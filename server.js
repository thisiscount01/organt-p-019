'use strict';

const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app   = express();
const PORT  = process.env.PORT || 3000;
const TOKEN = process.env.AQICN_TOKEN || 'demo';

// ── 도시 목록 ─────────────────────────────────────────────────────────────────
const CITIES = [
  { id: 'seoul',   name_ko: '서울', name_en: 'Seoul'   },
  { id: 'busan',   name_ko: '부산', name_en: 'Busan'   },
  { id: 'incheon', name_ko: '인천', name_en: 'Incheon' },
  { id: 'daejeon', name_ko: '대전', name_en: 'Daejeon' },
  { id: 'gwangju', name_ko: '광주', name_en: 'Gwangju' },
  { id: 'daegu',   name_ko: '대구', name_en: 'Daegu'   },
  { id: 'ulsan',   name_ko: '울산', name_en: 'Ulsan'   },
  { id: 'suwon',   name_ko: '수원', name_en: 'Suwon'   },
  { id: 'jeju',    name_ko: '제주', name_en: 'Jeju'    },
  { id: 'jeonju',  name_ko: '전주', name_en: 'Jeonju'  },
];

const VALID_IDS = new Set(CITIES.map(c => c.id));

// ── 단일 판정 함수 (서버 전용 — 클라 폴백 없음) ─────────────────────────────

/**
 * PM2.5 µg/m³ → grade
 * 극단값(≤0, ≥999, 음수, NaN) → null (unavailable로 처리)
 */
function gradeFromPM25(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0 || v >= 999) return null;
  if (v <= 30)  return 'good';
  if (v <= 80)  return 'moderate';
  if (v <= 150) return 'bad';
  return 'very_bad';
}

/** grade → verdict (서버 전용) */
function verdictFromGrade(grade) {
  if (grade === 'good')     return 'safe';
  if (grade === 'moderate') return 'caution';
  return 'avoid'; // bad / very_bad
}

/** grade별 메시지 */
const GRADE_INFO = {
  good:     { message: '대기질이 좋습니다. 야외 활동에 적합합니다.',         detail: 'PM2.5 농도가 낮아 대부분의 사람들에게 안전한 수준입니다.' },
  moderate: { message: '대기질이 보통입니다. 민감군은 주의하세요.',          detail: '노약자·호흡기 환자는 장시간 야외 활동 시 주의가 필요합니다.' },
  bad:      { message: '대기질이 나쁩니다. 야외 활동을 자제하세요.',         detail: '가급적 실내에 머물고 외출 시 마스크(KF94)를 착용하세요.' },
  very_bad: { message: '대기질이 매우 나쁩니다. 야외 활동을 삼가주세요.',   detail: '취약계층은 반드시 실내에 머무르고 창문을 닫으세요.' },
};

// ── AQICN API 호출 ────────────────────────────────────────────────────────────

async function fetchAQICN(cityId) {
  const url = `https://api.waqi.info/feed/${encodeURIComponent(cityId)}/?token=${TOKEN}`;
  const res = await fetch(url, { timeout: 9000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'ok' || !json.data) {
    throw new Error(`AQICN error: ${json.status || 'unknown'}`);
  }
  return json.data;
}

/** iaqi 객체에서 안전하게 수치 추출 (극단값 방어) */
function safeIaqi(iaqi, key) {
  if (!iaqi || iaqi[key] == null) return null;
  const v = Number(iaqi[key].v);
  if (!Number.isFinite(v) || v < 0 || v >= 999) return null;
  return Math.round(v * 10) / 10;
}

/** 내일 날짜 문자열 YYYY-MM-DD (UTC) */
function tomorrowUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * AQICN forecast.daily.pm25 배열에서 내일 avg 추출.
 * 없으면 가용 데이터로 트렌드 추정.
 */
function resolveTomorrow(pm25Arr, fallback) {
  if (!Array.isArray(pm25Arr) || pm25Arr.length === 0) return fallback;

  const tmr   = tomorrowUTC();
  const entry = pm25Arr.find(e => e.day === tmr);
  if (entry?.avg != null) {
    const v = Number(entry.avg);
    if (Number.isFinite(v) && v > 0 && v < 999) return Math.round(v * 10) / 10;
  }

  // 트렌드 추정: 유효한 일별 값 정렬 후 마지막 기울기 적용
  const sorted = pm25Arr
    .filter(e => e.avg != null && Number.isFinite(Number(e.avg)) && Number(e.avg) > 0 && Number(e.avg) < 999)
    .sort((a, b) => (a.day > b.day ? 1 : -1));

  if (sorted.length >= 2) {
    const a = Number(sorted[sorted.length - 2].avg);
    const b = Number(sorted[sorted.length - 1].avg);
    const est = Math.max(1, Math.min(998, b + (b - a)));
    return Math.round(est * 10) / 10;
  }
  if (sorted.length === 1) return Math.round(Number(sorted[0].avg) * 10) / 10;
  return fallback;
}

/** 3시간 간격 예측 포인트 생성 (8포인트 = 24h) */
function buildHourlyForecast(pm25Arr, currentPM25) {
  const now    = new Date();
  const points = [];

  const sorted = (pm25Arr || [])
    .filter(e => e.avg != null && Number.isFinite(Number(e.avg)) && Number(e.avg) > 0 && Number(e.avg) < 999)
    .sort((a, b) => (a.day > b.day ? 1 : -1))
    .slice(0, 7);

  for (let i = 0; i < 8; i++) {
    const offsetH = i * 3;
    const t       = new Date(now.getTime() + offsetH * 3_600_000);
    const label   = `${String(t.getUTCHours()).padStart(2, '0')}:00`;

    let val;
    if (sorted.length >= 2) {
      const dayIdx  = Math.floor(offsetH / 24);
      const frac    = (offsetH % 24) / 24;
      const d0      = Number(sorted[Math.min(dayIdx,     sorted.length - 1)].avg);
      const d1      = Number(sorted[Math.min(dayIdx + 1, sorted.length - 1)].avg);
      val = Math.max(1, Math.min(998, Math.round((d0 + (d1 - d0) * frac) * 10) / 10));
    } else if (sorted.length === 1) {
      val = Math.round(Number(sorted[0].avg) * 10) / 10;
    } else {
      val = currentPM25 ?? 50;
    }

    points.push({ hour: label, value: val, grade: gradeFromPM25(val) ?? null });
  }
  return points;
}

// ── 시티 파라미터 검증 미들웨어 ──────────────────────────────────────────────

function parseCity(req, res, next) {
  const city = (req.query.city || '').toLowerCase().trim();
  if (!city || !VALID_IDS.has(city)) {
    return res.status(400).json({ status: 'unavailable', error: '유효하지 않은 도시 ID입니다. /api/cities 에서 확인하세요.' });
  }
  req.cityId = city;
  next();
}

// ── 엔드포인트 ────────────────────────────────────────────────────────────────

/* GET /api/cities */
app.get('/api/cities', (_req, res) => {
  res.json(CITIES);
});

/* GET /api/current?city={id} */
app.get('/api/current', parseCity, async (req, res) => {
  try {
    const data  = await fetchAQICN(req.cityId);
    const pm25  = safeIaqi(data.iaqi, 'pm25');
    const pm10  = safeIaqi(data.iaqi, 'pm10');
    const o3    = safeIaqi(data.iaqi, 'o3');
    const no2   = safeIaqi(data.iaqi, 'no2');
    const rawAqi = typeof data.aqi === 'number' && data.aqi >= 0 && data.aqi < 9999 ? data.aqi : null;
    const grade  = gradeFromPM25(pm25);

    res.json({
      value:     pm25   ?? null,
      unit:      'µg/m³',
      grade:     grade  ?? null,
      status:    pm25 !== null ? 'ok' : 'unavailable',
      pm10:      pm10   ?? null,
      o3:        o3     ?? null,
      no2:       no2    ?? null,
      aqi:       rawAqi ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (_err) {
    res.json({
      value: null, unit: 'µg/m³', grade: null,
      status: 'unavailable', pm10: null, o3: null,
      no2: null, aqi: null,
      timestamp: new Date().toISOString(),
    });
  }
});

/* GET /api/forecast?city={id} */
app.get('/api/forecast', parseCity, async (req, res) => {
  try {
    const data        = await fetchAQICN(req.cityId);
    const currentPM25 = safeIaqi(data.iaqi, 'pm25') ?? 50;
    const pm25Fc      = data.forecast?.daily?.pm25 ?? [];

    const forecast       = buildHourlyForecast(pm25Fc, currentPM25);
    const tomorrowVal    = resolveTomorrow(pm25Fc, currentPM25);
    const tomorrowGrade  = gradeFromPM25(tomorrowVal) ?? null;

    res.json({
      status:         'ok',
      forecast,
      tomorrow_value: tomorrowVal,
      tomorrow_grade: tomorrowGrade,
    });
  } catch (_err) {
    res.json({
      status:         'unavailable',
      forecast:       [],
      tomorrow_value: null,
      tomorrow_grade: null,
    });
  }
});

/* GET /api/verdict?city={id} */
app.get('/api/verdict', parseCity, async (req, res) => {
  try {
    const data  = await fetchAQICN(req.cityId);
    const pm25  = safeIaqi(data.iaqi, 'pm25');
    const grade = gradeFromPM25(pm25);

    if (!grade) {
      return res.json({
        status:  'unavailable',
        verdict: 'caution',
        message: '데이터를 불러올 수 없습니다. 주의하세요.',
        detail:  '대기질 정보가 일시적으로 제공되지 않습니다.',
      });
    }

    const info = GRADE_INFO[grade];
    res.json({
      status:  'ok',
      verdict: verdictFromGrade(grade),
      message: info.message,
      detail:  info.detail,
    });
  } catch (_err) {
    res.json({
      status:  'unavailable',
      verdict: 'caution',
      message: '데이터를 불러올 수 없습니다. 주의하세요.',
      detail:  '대기질 서버에 일시적인 오류가 발생했습니다.',
    });
  }
});

// ── 정적 파일 서빙 ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  res.sendFile(idx, err => {
    if (err) res.send('<h1>Air Quality API</h1><ul><li><a href="/api/cities">/api/cities</a></li><li>/api/current?city=seoul</li><li>/api/forecast?city=seoul</li><li>/api/verdict?city=seoul</li></ul>');
  });
});

// ── 서버 기동 ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[AirQuality API] port=${PORT} token=${TOKEN === 'demo' ? 'demo' : '****'}`);
});

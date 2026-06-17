'use strict';
/* ============================================================
   app.js — 대기질 대시보드 클라이언트
   - 색상 하드코딩 없음: 모든 색은 CSS data-grade 토큰으로 제어
   - JS는 data-grade 속성 문자열만 DOM에 쓴다
   ============================================================ */

// ── 상수 ──────────────────────────────────────────────────────

/** PM2.5 게이지 최대 스케일 (µg/m³) */
const PM25_MAX = 200;

/** SVG 게이지 원주: 2π × r50 ≈ 314.16 */
const GAUGE_CIRC = 314;

const GRADE_LABELS = {
  good:        '좋음',
  moderate:    '보통',
  bad:         '나쁨',
  very_bad:    '매우나쁨',
  unavailable: '정보없음',
};

const VERDICT_ICONS = {
  safe:    '😊',
  caution: '😷',
  avoid:   '🚫',
};

const VERDICT_LABELS = {
  safe:    '외출 좋음',
  caution: '주의 필요',
  avoid:   '외출 자제',
};

// ── DOM 참조 ────────────────────────────────────────────────

const $id = id => document.getElementById(id);

const DOM = {
  cityNav:         $id('cityNav'),
  loadingState:    $id('loadingState'),
  errorState:      $id('errorState'),
  dashboard:       $id('dashboard'),
  updateTime:      $id('updateTime'),
  refreshBtn:      $id('refreshBtn'),
  currentCard:     $id('currentCard'),
  verdictCard:     $id('verdictCard'),
  gradeBadge:      $id('gradeBadge'),
  gaugeFill:       $id('gaugeFill'),
  gaugeValue:      $id('gaugeValue'),
  currentCityName: $id('currentCityName'),
  currentGradeLabel: $id('currentGradeLabel'),
  verdictIcon:     $id('verdictIcon'),
  verdictLabel:    $id('verdictLabel'),
  verdictMessage:  $id('verdictMessage'),
  verdictDetail:   $id('verdictDetail'),
  aiBannerText:    $id('aiBannerText'),
  forecastChart:   $id('forecastChart'),
  tomorrowBadge:   $id('tomorrowBadge'),
  pm10Val:         $id('pm10Val'),
  o3Val:           $id('o3Val'),
  no2Val:          $id('no2Val'),
  aqiVal:          $id('aqiVal'),
};

// ── 상태 ────────────────────────────────────────────────────

let currentCity = null;
let currentCityName = '';
let isLoading = false;

// ── 유틸 ────────────────────────────────────────────────────

/** data-grade 속성 설정 (CSS 토큰 계단 상속 트리거) */
function setGrade(elements, grade) {
  const g = grade || 'unavailable';
  elements.forEach(el => { if (el) el.dataset.grade = g; });
}

/** 게이지 stroke-dashoffset 업데이트 */
function updateGauge(value) {
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  const fraction = Math.min(1, Math.max(0, v / PM25_MAX));
  DOM.gaugeFill.style.strokeDashoffset = GAUGE_CIRC * (1 - fraction);
}

/** 값이 null/undefined면 '—' 반환 */
const fmt = v => (v !== null && v !== undefined && Number.isFinite(v)) ? v : '—';

// ── 렌더 함수 ────────────────────────────────────────────────

function renderCurrent(data) {
  const grade = data.grade || 'unavailable';
  const value = data.value;

  setGrade([DOM.currentCard], grade);

  DOM.gradeBadge.textContent     = GRADE_LABELS[grade] ?? '—';
  DOM.gaugeValue.textContent     = value !== null ? Math.round(value) : '—';
  DOM.currentGradeLabel.textContent = `PM2.5 ${GRADE_LABELS[grade] ?? '정보없음'}`;

  updateGauge(value);

  DOM.pm10Val.textContent = fmt(data.pm10);
  DOM.o3Val.textContent   = fmt(data.o3);
  DOM.no2Val.textContent  = fmt(data.no2);
  DOM.aqiVal.textContent  = fmt(data.aqi);

  if (data.timestamp) {
    try {
      DOM.updateTime.textContent = new Date(data.timestamp)
        .toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      DOM.updateTime.textContent = '방금';
    }
  }
}

function renderForecast(data) {
  const chart = DOM.forecastChart;
  chart.innerHTML = '';

  const points = Array.isArray(data.forecast) ? data.forecast : [];
  if (!points.length) {
    const emptyEl = document.createElement('p');
    emptyEl.className = 'forecast-empty';
    emptyEl.textContent = '예측 데이터가 없습니다';
    chart.appendChild(emptyEl);
    return;
  }

  // 반응형 높이: 모바일 80px / 데스크톱 120px
  const isMobile = window.matchMedia('(max-width: 430px)').matches;
  const areaH    = isMobile ? 80 : 120;
  const labelH   = 30; // forecast-val + forecast-hour + gap 합산 근사값
  const maxBarH  = Math.max(10, areaH - labelH);

  const maxVal = Math.max(...points.map(p => Number(p.value) || 0), 1);

  points.forEach(p => {
    const val     = Number.isFinite(Number(p.value)) ? Number(p.value) : 0;
    const frac    = Math.min(1, Math.max(0.04, val / maxVal));
    const barH    = Math.round(frac * maxBarH);
    const grade   = p.grade || 'unavailable';

    const wrap = document.createElement('div');
    wrap.className = 'forecast-bar-wrap';

    const valEl = document.createElement('div');
    valEl.className = 'forecast-val';
    valEl.textContent = val > 0 ? Math.round(val) : '—';

    const bar = document.createElement('div');
    bar.className = 'forecast-bar';
    bar.dataset.grade = grade;        // CSS 토큰이 색상 결정 — JS는 문자열만 씀
    bar.style.height = barH + 'px';  // 높이만 인라인

    const hourEl = document.createElement('div');
    hourEl.className = 'forecast-hour';
    hourEl.textContent = p.hour || '';

    wrap.appendChild(valEl);
    wrap.appendChild(bar);
    wrap.appendChild(hourEl);
    chart.appendChild(wrap);
  });

  // 내일 배지
  if (data.tomorrow_grade) {
    DOM.tomorrowBadge.classList.remove('hidden');
  }
}

function renderVerdict(data, grade) {
  const verdict = data.verdict || 'caution';

  setGrade([DOM.verdictCard], grade);

  DOM.verdictIcon.textContent    = VERDICT_ICONS[verdict] ?? '🤔';
  DOM.verdictLabel.textContent   = VERDICT_LABELS[verdict] ?? '—';
  DOM.verdictMessage.textContent = data.message ?? '';
  DOM.verdictDetail.textContent  = data.detail ?? '';
  const AI_BANNER = {
    good:        g => `${currentCityName} 오늘 야외 활동 최적 — PM2.5 좋음 수준 확인`,
    moderate:    g => `${currentCityName} 대기질 보통 — 민감군은 장시간 외출 주의`,
    bad:         g => `${currentCityName} 대기 오염 나쁨 — 마스크(KF94) 착용 권장`,
    very_bad:    g => `${currentCityName} 대기 오염 심각 — 취약계층 외출 자제 필요`,
    unavailable: g => `${currentCityName} 대기질 정보 없음 — 외출 시 주의 요망`,
  };
  DOM.aiBannerText.textContent = (AI_BANNER[grade] ?? AI_BANNER.unavailable)(grade);
}

// ── 도시 로드 ────────────────────────────────────────────────

async function loadCity(cityId, cityName) {
  if (isLoading) return;
  isLoading = true;
  currentCity     = cityId;
  currentCityName = cityName;

  // UI: 로딩 상태
  DOM.loadingState.classList.remove('hidden');
  DOM.dashboard.classList.add('hidden');
  DOM.errorState.classList.add('hidden');
  DOM.refreshBtn.classList.add('spinning');
  DOM.currentCityName.textContent = cityName;
  DOM.tomorrowBadge.classList.add('hidden');

  try {
    const [current, forecast, verdict] = await Promise.all([
      fetch(`/api/current?city=${cityId}`).then(r => r.json()),
      fetch(`/api/forecast?city=${cityId}`).then(r => r.json()),
      fetch(`/api/verdict?city=${cityId}`).then(r => r.json()),
    ]);

    const grade = current.grade || 'unavailable';

    renderCurrent(current);
    renderForecast(forecast);
    renderVerdict(verdict, grade);

    // 활성 도시 버튼에 grade 반영 → city-btn.active의 --g-* 상속
    const activeBtn = DOM.cityNav.querySelector('.city-btn.active');
    if (activeBtn) activeBtn.dataset.grade = grade;

    DOM.loadingState.classList.add('hidden');
    DOM.dashboard.classList.remove('hidden');
  } catch (err) {
    console.error('[대기질]', err);
    DOM.loadingState.classList.add('hidden');
    DOM.errorState.classList.remove('hidden');
  } finally {
    isLoading = false;
    DOM.refreshBtn.classList.remove('spinning');
  }
}

// ── 초기화 ──────────────────────────────────────────────────

async function init() {
  try {
    const cities = await fetch('/api/cities').then(r => r.json());

    cities.forEach((city, idx) => {
      const btn = document.createElement('button');
      btn.className    = 'city-btn';
      btn.dataset.grade = '';
      btn.textContent  = city.name_ko;
      btn.setAttribute('aria-label', `${city.name_ko} 대기질 보기`);

      btn.addEventListener('click', () => {
        DOM.cityNav.querySelectorAll('.city-btn').forEach(b => {
          b.classList.remove('active');
          b.dataset.grade = '';
        });
        btn.classList.add('active');
        loadCity(city.id, city.name_ko);
      });

      DOM.cityNav.appendChild(btn);

      // 첫 번째 도시(서울) 자동 선택
      if (idx === 0) {
        btn.classList.add('active');
        loadCity(city.id, city.name_ko);
      }
    });

  } catch (err) {
    console.error('[초기화 실패]', err);
    DOM.loadingState.classList.add('hidden');
    DOM.errorState.classList.remove('hidden');
  }
}

// ── 이벤트 ──────────────────────────────────────────────────

DOM.refreshBtn.addEventListener('click', () => {
  if (currentCity && !isLoading) {
    loadCity(currentCity, currentCityName);
  }
});

// 창 크기 변경 시 예측 바 재렌더 (높이 재계산)
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentCity && !DOM.dashboard.classList.contains('hidden')) {
      fetch(`/api/forecast?city=${currentCity}`)
        .then(r => r.json())
        .then(renderForecast)
        .catch(() => {});
    }
  }, 250);
});

// ── 시작 ───────────────────────────────────────────────────

init();

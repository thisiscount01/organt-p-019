"""
대기질 대시보드 UI 검증 스크립트
Playwright + Chromium으로 실제 렌더링 확인
"""
from playwright.sync_api import sync_playwright
import re, json

def check_colors(path, label):
    """파일에서 하드코딩 색상 검색 (var() 참조 제외)"""
    content = open(path).read()
    # var() 안의 값, 주석, data-grade값(문자열)은 제외하고 순수 색상 리터럴만
    patterns = [r'(?<!["\'])#[0-9a-fA-F]{6}(?!\w)', r'\brgb[a]?\s*\(', r'\bhsl[a]?\s*\(']
    found = []
    for pat in patterns:
        found.extend(re.findall(pat, content))
    print(f"[{label}] 색상 하드코딩: {'없음 ✓' if not found else found}")
    return found

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900})

    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    page.goto("http://localhost:3000/")
    page.wait_for_timeout(600)

    print("=== 구조 검증 ===")
    checks = {
        "app-shell": ".app-shell",
        "city-nav": ".city-nav",
        "gauge-svg": ".gauge-svg",
        "card--current": ".card--current",
        "card--verdict": ".card--verdict",
        "pollutant-grid": ".pollutant-grid",
        "forecast-area": ".forecast-area",
        "loading-state": "#loadingState",
    }
    for name, sel in checks.items():
        exists = page.locator(sel).count() > 0
        print(f"  {name}: {'✓' if exists else '✗'}")

    # 초기 스크린샷
    page.screenshot(path="/tmp/aq_init.png")
    print("스크린샷(초기): /tmp/aq_init.png")

    # API 응답 확인
    api_result = page.evaluate("""async () => {
        const r = await fetch('/api/current?city=seoul');
        return r.json();
    }""")
    print(f"\n=== API 응답 ===")
    print(f"  grade={api_result.get('grade')} status={api_result.get('status')} value={api_result.get('value')}")

    # 데이터 로드 대기
    try:
        page.wait_for_selector("#dashboard:not(.hidden)", timeout=6000)
        loaded = True
    except Exception as e:
        loaded = False
        print(f"  대시보드 미표시: {e}")

    print(f"\n=== 동작 검증 ===")
    print(f"  대시보드 표시: {'✓' if loaded else '✗'}")

    if loaded:
        grade_attr = page.locator("#currentCard").get_attribute("data-grade")
        gauge_val  = page.locator("#gaugeValue").text_content().strip()
        city_nm    = page.locator("#currentCityName").text_content().strip()
        verdict    = page.locator("#verdictLabel").text_content().strip()
        bars       = page.locator(".forecast-bar").count()
        badge_txt  = page.locator("#gradeBadge").text_content().strip()

        print(f"  currentCard[data-grade]: '{grade_attr}' {'✓' if grade_attr else '✗ (비어있음)'}")
        print(f"  게이지 값: {gauge_val}")
        print(f"  현재 도시: {city_nm}")
        print(f"  판정 라벨: {verdict}")
        print(f"  등급 배지: {badge_txt}")
        print(f"  예측 바 개수: {bars} {'✓ (8개)' if bars == 8 else '✗'}")

        # 도시 버튼 grade 반영 확인
        active_grade = page.locator(".city-btn.active").get_attribute("data-grade")
        print(f"  city-btn.active[data-grade]: '{active_grade}'")

        # 데이터 로드 후 스크린샷
        page.screenshot(path="/tmp/aq_loaded.png")
        print("스크린샷(로드후): /tmp/aq_loaded.png")

        # 모바일 검증
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(400)
        page.screenshot(path="/tmp/aq_mobile.png")
        print("스크린샷(모바일): /tmp/aq_mobile.png")

        # 2컬럼→1컬럼 확인
        primary_row = page.locator(".dashboard-row--primary")
        style = page.evaluate("""
            () => window.getComputedStyle(document.querySelector('.dashboard-row--primary'))
                        .gridTemplateColumns
        """)
        print(f"  모바일 그리드(430px): {style}")

    print(f"\n=== 색상 하드코딩 검증 ===")
    js_bad  = check_colors("/workdir/public/app.js", "app.js")
    css_bad = check_colors("/workdir/public/style.css", "style.css")

    print(f"\n=== 콘솔 에러 ===")
    print(f"  {errors if errors else '없음 ✓'}")

    overall = loaded and not js_bad and not css_bad
    print(f"\n결과: {'✓ PASS' if overall else '✗ FAIL (위 항목 확인)'}")

    browser.close()

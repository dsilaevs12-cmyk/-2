import re
from playwright.sync_api import sync_playwright

URL = "file:///workspace/index.html"
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(URL)
    page.wait_for_timeout(600)
    page.fill("#authRegFirst", "Иван")
    page.fill("#authRegLast", "Петров")
    page.fill("#authRegPass1", "secret123")
    page.fill("#authRegPass2", "secret123")
    page.click("#authRegisterSubmit")
    page.wait_for_timeout(1500)
    assert not page.is_visible("#authGate")

    page.evaluate("() => { state.devUnlocked = true; openDevPanel(); }")
    page.wait_for_timeout(300)

    # 1. No maxlength attributes on the text fields
    for sel in ("#devSystemTextInput", "#devBanTechTextInput"):
        assert page.get_attribute(sel, "maxlength") is None, sel + " still has maxlength"
    print("OK 1: no maxlength attribute on system/tech text fields")

    # 2. System text longer than the old 600-char limit saves fully
    long_sys = "\n".join("Строка системного текста номер %d: " % i + "абвгд "*30 for i in range(400))
    assert len(long_sys) > 12000
    page.fill("#devSystemTextInput", long_sys)
    page.click("#devSaveSystemTextButton")
    page.wait_for_timeout(300)
    saved = page.evaluate("() => state.settings.systemText")
    expected = "\n".join(re.sub(r"[ \t]+", " ", ln).strip() for ln in long_sys.split("\n"))
    assert len(saved) > 25000 and saved == expected, "system text wrong: %d vs %d" % (len(saved), len(expected))
    shown = page.evaluate("() => document.getElementById('systemTextLine').textContent")
    assert shown == expected, "rendered system text differs from saved one"
    print("OK 2: system text of %d chars saved and rendered without a limit" % len(saved))

    # 3. Ban technical text longer than the old 1000-char limit survives a ban
    long_tech = "Технический текст. " + ("Длинные подробности для забаненного устройства. " * 120)
    assert len(long_tech) > 3000
    page.check("#devBanAutoTextCheckbox")
    page.fill("#devBanTechTextInput", long_tech)
    page.click("#devSaveBanTechTextButton")
    page.wait_for_timeout(200)
    stored = page.evaluate("() => localStorage.getItem('attendance_ban_tech_text')")
    assert stored and len(stored) == len(long_tech.strip()), "tech text truncated on save"
    page.evaluate("() => applyShadowBan('Проверка лимита', 'тех. работник')")
    page.wait_for_timeout(400)
    tech = page.inner_text("#banTechText")
    assert len(tech) == len(long_tech.strip()), "tech text truncated on ban screen: %d vs %d" % (len(tech), len(long_tech.strip()))
    print("OK 3: ban tech text of %d chars shown fully on the ban screen" % len(tech))

    # 4. Reload keeps everything intact
    page.reload(); page.wait_for_timeout(800)
    assert page.is_visible("#banOverlay"), "ban screen lost after reload"
    assert len(page.inner_text("#banTechText")) == len(long_tech.strip())
    print("OK 4: long tech text persists across reload")

    assert not errors, "page errors: " + "; ".join(errors)
    browser.close()

print("ALL NO-LIMIT TESTS PASSED")

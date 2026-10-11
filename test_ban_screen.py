import json
from playwright.sync_api import sync_playwright

URL = "file:///workspace/index.html"
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    # 1. Register to get past the auth gate
    page.goto(URL)
    page.wait_for_timeout(600)
    assert page.is_visible("#authGate"), "auth gate not shown"
    page.fill("#authRegFirst", "Иван")
    page.fill("#authRegLast", "Петров")
    page.fill("#authRegPass1", "secret123")
    page.fill("#authRegPass2", "secret123")
    page.click("#authRegisterSubmit")
    page.wait_for_timeout(1500)
    assert not page.is_visible("#authGate"), "gate still visible after register"
    assert page.get_attribute("#banOverlay", "hidden") is not None, "ban screen shown without ban"
    print("OK 1: registered, no ban screen")

    # 2. Enable auto-fill and save a technical text in settings
    page.evaluate("() => { state.devUnlocked = true; openDevPanel(); }")
    page.wait_for_timeout(300)
    assert page.is_visible("#devBanTechTextInput"), "tech text field missing in settings"
    page.check("#devBanAutoTextCheckbox")
    page.fill("#devBanTechTextInput", "Устройство отключено до окончания проверки. Вопросы — к системному администратору школы.")
    page.click("#devSaveBanTechTextButton")
    page.wait_for_timeout(200)
    stored = page.evaluate("() => localStorage.getItem('attendance_ban_tech_text')")
    assert stored and "системному администратору" in stored, "tech text not stored: " + str(stored)
    print("OK 2: tech text saved with auto-fill enabled")

    # 3. Manual ban from settings -> full-screen un-collapsible notice
    page.evaluate("() => { banThisDevice(); }")
    page.wait_for_timeout(400)
    assert page.is_visible("#banOverlay"), "ban screen not shown after manual ban"
    txt_title = page.inner_text("#banTitle")
    assert "заблокировано" in txt_title.lower(), "bad title: " + txt_title
    reason = page.inner_text("#banReason")
    assert "вручную" in reason, "bad reason: " + reason
    by = page.inner_text("#banBy")
    assert "тех." in by, "bad issuer: " + by
    date = page.inner_text("#banDate")
    assert "." in date and len(date) > 6, "bad date: " + date
    dev_id = page.inner_text("#banDeviceId")
    assert len(dev_id) > 8, "bad device id: " + dev_id
    ip = page.inner_text("#banDeviceIp")
    assert ip, "ip line empty"
    tech = page.inner_text("#banTechText")
    assert "системному администратору" in tech, "auto-filled tech text missing: " + tech
    print("OK 3: ban screen shows device/IP/reason/issuer/date/tech text")

    # 4. The screen cannot be collapsed: no close button inside, journal inert,
    #    Escape does nothing, clicking outside does nothing.
    buttons = page.eval_on_selector_all("#banOverlay button", "els => els.length")
    assert buttons == 0, "ban screen has dismiss buttons: %d" % buttons
    assert page.eval_on_selector("#journalApp", "el => el.inert"), "journal not inert while banned"
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    assert page.is_visible("#banOverlay"), "ban screen closed by Escape"
    print("OK 4: ban screen cannot be dismissed")

    # 5. Survives reload (ban is persistent until lifted from settings)
    page.reload()
    page.wait_for_timeout(700)
    assert page.is_visible("#banOverlay"), "ban screen gone after reload"
    tech2 = page.inner_text("#banTechText")
    assert "системному администратору" in tech2, "tech text lost after reload"
    print("OK 5: ban screen persists across reload")

    # 6. Ban issued automatically (code lockout) is marked 'автоматически'
    page.evaluate("""() => {
      localStorage.removeItem('attendance_shadow_ban');
      setBanTechAuto(false);              // manual mode: tech text must NOT auto-fill
      applyShadowBan('5 неверных попыток ввода кода настроек');
    }""")
    page.wait_for_timeout(300)
    assert page.is_visible("#banOverlay"), "auto ban screen not shown"
    assert "5 неверных" in page.inner_text("#banReason"), "auto reason wrong"
    assert "автоматически" in page.inner_text("#banBy"), "auto issuer wrong"
    assert "ещё не заполнен" in page.inner_text("#banTechText"), "tech text should be empty placeholder without auto-fill"
    print("OK 6: automatic ban labeled 'автоматически', tech text empty without auto-fill")

    # 7. Lifting the ban closes the screen automatically
    page.evaluate("() => { liftShadowBan(); }")
    page.wait_for_timeout(300)
    assert page.get_attribute("#banOverlay", "hidden") is not None or not page.is_visible("#banOverlay"), "ban screen still visible after unban"
    assert not page.eval_on_selector("#journalApp", "el => el.inert"), "journal still inert after unban"
    print("OK 7: screen closes when the ban is lifted")

    assert not errors, "JS errors: " + json.dumps(errors[:5], ensure_ascii=False)
    print("ALL BAN SCREEN TESTS PASSED")
    browser.close()

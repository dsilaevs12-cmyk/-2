import json, re
from playwright.sync_api import sync_playwright

URL = "file:///workspace/index.html"
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width":1280,"height":900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    # 1. First opening => auth gate visible, journal inert
    page.goto(URL)
    page.wait_for_timeout(600)
    assert page.is_visible("#authGate"), "auth gate not shown on first open"
    assert page.get_attribute("#journalApp", "inert") is not None or page.eval_on_selector("#journalApp","el=>el.inert"), "journal not inert"
    print("OK 1: gate shown on first open")

    # 2. Register
    page.fill("#authRegFirst", "Иван")
    page.fill("#authRegLast", "Петров")
    page.fill("#authRegPass1", "secret123")
    page.fill("#authRegPass2", "secret123")
    page.click("#authRegisterSubmit")
    page.wait_for_timeout(1500)
    assert not page.is_visible("#authGate"), "gate still visible after register"
    print("OK 2: registration unlocks the journal")

    # 3. Reload => session persists, no gate
    page.reload(); page.wait_for_timeout(600)
    assert not page.is_visible("#authGate"), "gate shown after reload with session"
    print("OK 3: session survives reload")

    # 4. Logout via settings
    page.evaluate("""() => { state.devUnlocked = true; openDevPanel(); }""")
    page.wait_for_timeout(300)
    info = page.inner_text("#authAccountInfo")
    assert "Иван Петров" in info, "account info missing: "+info
    page.on("dialog", lambda d: d.accept())
    page.click("#authLogoutButton")
    page.wait_for_timeout(500)
    assert page.is_visible("#authGate"), "gate not shown after logout"
    tab_login_active = page.eval_on_selector("#authTabLogin","el=>el.classList.contains('is-active')")
    assert tab_login_active, "login tab not preselected when accounts exist"
    print("OK 4: logout returns to gate with login tab")

    # 5. Login with wrong password rejected
    page.fill("#authLoginName", "иван петров")
    page.fill("#authLoginPass", "wrongpass")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1500)
    err = page.inner_text("#authLoginError")
    assert "Неверный пароль" in err, "wrong-pass msg: "+err
    assert page.is_visible("#authGate"), "gate closed on wrong password"
    print("OK 5: wrong password rejected")

    # 6. Login correct password => 2FA SMS step demanded
    page.fill("#authLoginPass", "secret123")
    page.fill("#authPhone", "+7 999 123-45-67")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1500)
    assert page.is_visible("#authSmsRow"), "sms row not shown after password accepted"
    hint = page.inner_text("#authSmsHint")
    m = re.search(r"— (\d{6})", hint)
    assert m, "no demo code in hint: "+hint
    code = m.group(1)
    print("OK 6: 2FA code step appears, demo code issued")

    # 7. Wrong code rejected, right code accepted
    page.fill("#authSmsCode", "000000" if code != "000000" else "111111")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(800)
    assert "Неверный код" in page.inner_text("#authLoginError"), "bad code accepted"
    assert page.is_visible("#authGate"), "logged in with bad code!"
    page.fill("#authSmsCode", code)
    page.click("#authLoginSubmit")
    page.wait_for_timeout(800)
    assert not page.is_visible("#authGate"), "valid code did not log in"
    print("OK 7: SMS 2FA enforced correctly")

    # 8. Secret-word 2FA path
    page.evaluate("""() => { clearAuthSession(); openAuthGate('login'); }""")
    page.wait_for_timeout(300)
    page.check('input[name="auth2faMethod"][value="secret"]')
    page.fill("#authLoginName", "Иван Петров")
    page.fill("#authLoginPass", "secret123")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1500)
    assert page.is_visible('[data-method="secret"]'), "secret step hidden"
    page.fill("#authSecretWord", "моятайна")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1500)
    assert not page.is_visible("#authGate"), "secret 2FA login failed"
    print("OK 8: secret-word 2FA login works")

    # 9. Second login with WRONG secret rejected (secret was enrolled)
    page.evaluate("""() => { clearAuthSession(); openAuthGate('login'); }""")
    page.wait_for_timeout(300)
    page.check('input[name="auth2faMethod"][value="secret"]')
    page.fill("#authLoginName", "Иван Петров")
    page.fill("#authLoginPass", "secret123")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1500)
    page.fill("#authSecretWord", "неправильно")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1500)
    assert "Неверное секретное слово" in page.inner_text("#authLoginError"), "wrong secret accepted"
    page.fill("#authSecretWord", "другаятайна")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1500)
    assert "Неверное секретное слово" in page.inner_text("#authLoginError"), "second wrong secret accepted"
    assert page.is_visible("#authGate")
    print("OK 9: enrolled secret word is verified strictly")

    # mobile viewport sanity
    page.set_viewport_size({"width":390,"height":800})
    page.wait_for_timeout(300)
    card_box = page.eval_on_selector(".auth-card","el=>{const r=el.getBoundingClientRect();return {w:r.width,x:r.left}}")
    assert card_box["x"] >= 0 and card_box["w"] <= 390, "auth card overflows mobile"
    print("OK 10: mobile layout fits")

    browser.close()

print("PAGE ERRORS:", errors if errors else "none")
assert not errors, errors
print("ALL AUTH TESTS PASSED")

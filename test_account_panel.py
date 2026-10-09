import json, re
from playwright.sync_api import sync_playwright

URL = "file:///workspace/index.html"

def run(pw):
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width":1280,"height":900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(600)

    # 1. Auth gate must be forced on first open
    assert page.is_visible("#authGate"), "auth gate not shown"

    # 2. Register a teacher-ish account (default role student), then login flow done via register
    page.fill("#authRegFirst", "Иван")
    page.fill("#authRegLast", "Петров")
    page.fill("#authRegPass1", "Secret123!")
    page.fill("#authRegPass2", "Secret123!")
    page.click("#authRegisterSubmit")
    page.wait_for_timeout(1500)
    assert not page.is_visible("#authGate"), "gate still open after register"

    # 3. Open the Account tab in sidebar
    page.click("[data-nav='account']")
    page.wait_for_timeout(400)
    body_text = page.inner_text("#accountCardBody")
    print("ACCOUNT BODY:\n", body_text[:600])
    assert "Иван Петров" in body_text, "user name missing"
    assert "Роль устройства" in body_text
    assert "Не привязан" in body_text or "Профиль в журнале" in body_text

    # journal hidden while on account view
    assert "account-view" in (page.get_attribute("#journalApp", "class") or "")

    # 4. Logout -> gate returns; then go to account again should show CTA
    page.click("#accountLogoutButton")
    page.once("dialog", lambda d: d.accept())
    page.wait_for_timeout(600)
    assert page.is_visible("#authGate"), "gate not reopened after logout"

    # Login back with 2FA secret
    page.click("#authTabLogin")
    page.fill("#authLoginName", "Иван Петров")
    page.fill("#authLoginPass", "Secret123!")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1200)
    # choose secret word method if radios present
    try:
        page.check("input[name='auth2faMethod'][value='secret']", timeout=2000)
    except Exception:
        pass
    page.wait_for_timeout(300)
    # fill phone maybe required? Try secret word path
    sw = page.query_selector("#authSecretWord")
    if sw and sw.is_visible():
        page.fill("#authSecretWord", "моязагадка")
        page.click("#authLoginSubmit")
        page.wait_for_timeout(1200)
    else:
        sms = page.query_selector("#authSmsCode")
        if sms:
            code = None
            m = re.search(r"(\d{4,6})", page.inner_text("#authSmsHint") or "")
            if m: code = m.group(1)
            page.fill("#authSmsCode", code or "000000")
            page.click("#authLoginSubmit")
            page.wait_for_timeout(1200)
    print("after login, gate visible:", page.is_visible("#authGate"))
    if page.is_visible("#authGate"):
        err = page.inner_text("#authLoginError")
        print("login error:", err)

    # 5. Back to account view: rows filled
    page.click("[data-nav='account']")
    page.wait_for_timeout(400)
    txt = page.inner_text("#accountCardBody")
    print("ACCOUNT AFTER LOGIN:\n", txt[:600])
    assert "Текущий вход" in txt

    # 6. Switch back to journal restores content
    page.click("[data-nav='journal']")
    page.wait_for_timeout(400)
    assert "account-view" not in (page.get_attribute("#journalApp", "class") or "")
    assert page.is_visible("#journalControls") or page.locator("#journalControls").count() > 0

    print("PAGE ERRORS:", errors)
    assert not errors, "console pageerrors: " + "; ".join(errors)
    b.close()
    print("ALL OK")

with sync_playwright() as pw:
    run(pw)

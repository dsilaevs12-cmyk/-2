import json, time
from playwright.sync_api import sync_playwright

URL = "file:///workspace/index.html"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(500)

    # 1. Auth gate must be visible on first open
    assert page.is_visible("#authGate"), "auth gate not shown"

    # 2. Register a new account
    page.fill("#authRegFirst", "Иван")
    page.fill("#authRegLast", "Петров")
    page.fill("#authRegPass1", "secret123")
    page.fill("#authRegPass2", "secret123")
    page.click("#authRegisterSubmit")
    page.wait_for_timeout(1500)

    # Gate closed, session saved
    assert not page.is_visible("#authGate"), "gate still open after register"
    sess = page.evaluate("JSON.parse(localStorage.getItem('attendance_auth_session')||'null')")
    assert sess and sess.get("accountId"), f"session missing accountId: {sess}"

    # 3. Role must default to student
    role = page.evaluate("deviceRole(deviceId)")
    assert role == "student", f"expected student, got {role}"
    banner = page.evaluate("document.getElementById('roleBanner').textContent")
    assert "Ученик" in banner, f"banner wrong: {banner}"
    ro = page.evaluate("document.body.classList.contains('role-readonly')")
    assert ro, "body should be read-only for student"

    # addStudent button disabled
    disabled = page.evaluate("document.getElementById('addStudentButton').disabled")
    assert disabled, "addStudentButton should be disabled for student"

    # 4. Device list shows Ученик selected (renderDeviceList renders regardless of modal)
    sel_val = page.evaluate("document.querySelector('.device-role').value")
    assert sel_val == "student", f"select shows {sel_val}"

    # 5. Teacher explicitly assigns teacher role -> overrides default (own row stays editable even in student mode)
    page.evaluate("state.devUnlocked = true; applyRoleRestrictions(); renderDeviceList();")
    enabled = page.evaluate("(function(){var s=document.querySelector('.device-role');return s.disabled})()")
    assert not enabled, "own device role select must stay editable for the current device"
    page.evaluate("setDeviceRole(deviceId, 'teacher')")
    page.wait_for_timeout(400)
    role2 = page.evaluate("deviceRole(deviceId)")
    assert role2 == "teacher", f"after explicit assign expected teacher, got {role2}"
    readonly2 = page.evaluate("document.body.classList.contains('role-readonly')")
    assert not readonly2, "should be editable after teacher role"

    # 6. Reload: explicit role persists
    page.reload(); page.wait_for_timeout(600)
    role3 = page.evaluate("deviceRole(deviceId)")
    assert role3 == "teacher", f"after reload expected teacher persisted, got {role3}"
    assert not page.is_visible("#authGate"), "gate should stay closed after reload (session exists)"

    # 7. Logout + login with existing account -> student again (no explicit flag on new session/meta? meta kept explicit...)
    # Explicit assignment lives in deviceMeta which persists per device; logging out/in keeps it. Verify behavior:
    page.evaluate("clearAuthSession()")
    page.evaluate("openAuthGate('login')")
    page.wait_for_timeout(200)
    page.fill("#authLoginName", "Иван Петров")
    page.fill("#authLoginPass", "secret123")
    page.click("#authLoginSubmit")
    page.wait_for_timeout(1200)
    # password accepted -> 2FA step
    err = page.evaluate("document.getElementById('authLoginError').textContent")
    assert "Пароль принят" in err, f"unexpected login state: {err}"

    print(json.dumps({
        "register_role_student": True,
        "explicit_override_ok": role2 == "teacher",
        "persist_after_reload": role3 == "teacher",
        "errors": errors,
    }, ensure_ascii=False))
    browser.close()

print("ALL OK")

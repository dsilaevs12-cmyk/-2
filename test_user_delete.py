import json
from playwright.sync_api import sync_playwright

URL = "file:///workspace/index.html"

state = {"typed_name": None, "accept_confirm": True, "dialogs": []}

def on_dialog(d):
    state["dialogs"].append({"type": d.type, "message": d.message})
    if d.type == "confirm":
        if state["accept_confirm"]:
            d.accept()
        else:
            d.dismiss()
    elif d.type == "prompt":
        if state["typed_name"] is None:
            d.dismiss()
        else:
            d.accept(state["typed_name"])
    else:
        d.accept()

def register(page, first, last, pw="Secret123!"):
    page.fill("#authRegFirst", first)
    page.fill("#authRegLast", last)
    page.fill("#authRegPass1", pw)
    page.fill("#authRegPass2", pw)
    page.click("#authRegisterSubmit")
    page.wait_for_timeout(1500)

def unlock_settings(page):
    page.click("#versionButton")
    page.wait_for_timeout(300)
    page.fill("#settingsPasswordInput", "020912")
    page.click("#settingsPasswordForm button[type=submit]")
    page.wait_for_timeout(500)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", on_dialog)
    page.goto(URL)
    page.wait_for_timeout(600)

    # 1. Register current user, seed a second account directly in storage
    register(page, "Иван", "Петров")
    assert not page.is_visible("#authGate"), "gate still open after register"
    page.evaluate("""() => {
      const list = JSON.parse(localStorage.getItem('attendance_auth_accounts'));
      list.push({ id: 'acc-second-1', fullName: 'Анна Сидорова', firstName: 'Анна', lastName: 'Сидорова', salt: 'aa', hash: 'pbkdf2$bb', createdAt: Date.now() - 5000 });
      localStorage.setItem('attendance_auth_accounts', JSON.stringify(list));
    }""")

    # 2. Open settings — user list shows both accounts with delete buttons
    unlock_settings(page)
    assert page.is_visible("#devPanelModal"), "settings panel not open"
    rows = page.query_selector_all("#userList .user-row")
    assert len(rows) == 2, f"expected 2 user rows, got {len(rows)}"
    txt = page.inner_text("#userList")
    assert "Иван Петров" in txt and "текущий вход" in txt and "Анна Сидорова" in txt, txt
    btns = page.query_selector_all("#userList .user-remove")
    assert all(btn.is_enabled() for btn in btns), "delete must be enabled for teacher/dev-unlocked"

    # 3. Cancel at the confirm dialog -> nothing deleted
    state["accept_confirm"] = False
    page.query_selector_all("#userList .user-remove")[1].click()
    page.wait_for_timeout(400)
    accs = json.loads(page.evaluate("localStorage.getItem('attendance_auth_accounts')"))
    assert len(accs) == 2, "dismissed confirm must keep the account"
    state["accept_confirm"] = True

    # 4. Wrong name typed at the prompt -> deletion aborted
    state["typed_name"] = "Не То Имя"
    page.query_selector_all("#userList .user-remove")[1].click()
    page.wait_for_timeout(400)
    accs = json.loads(page.evaluate("localStorage.getItem('attendance_auth_accounts')"))
    assert len(accs) == 2, f"wrong-name confirmation must NOT delete: {[a['fullName'] for a in accs]}"

    # 5. Correctly delete the OTHER user (Anna); session stays intact
    state["typed_name"] = "анна сидорова"  # case/whitespace-insensitive match
    page.query_selector_all("#userList .user-remove")[1].click()
    page.wait_for_timeout(500)
    accs = json.loads(page.evaluate("localStorage.getItem('attendance_auth_accounts')"))
    assert [a["fullName"] for a in accs] == ["Иван Петров"], f"Anna should be gone: {accs}"
    assert len(page.query_selector_all("#userList .user-row")) == 1, "list must refresh after delete"
    session = json.loads(page.evaluate("localStorage.getItem('attendance_auth_session')"))
    assert session.get("accountId") != "acc-second-1", "session untouched when deleting another user"
    backups = json.loads(page.evaluate("localStorage.getItem('attendance_recovery_backups') || '[]'"))
    assert len(backups) >= 1, "recovery backup must be saved before deletion"
    assert page.is_visible("#devPanelModal"), "panel stays open when deleting another user"

    # 6. Delete the CURRENT user -> warning shown, session cleared, gate reopens
    confirm_msgs = [d["message"] for d in state["dialogs"] if d["type"] == "confirm"]
    assert any("текущая учётная запись" in m for m in confirm_msgs[-1:]), "current-account warning missing"
    state["typed_name"] = "Иван Петров"
    page.click("#userList .user-remove")
    page.wait_for_timeout(700)
    accs = json.loads(page.evaluate("localStorage.getItem('attendance_auth_accounts') || '[]'"))
    assert accs == [], f"all accounts removed: {accs}"
    assert page.evaluate("!localStorage.getItem('attendance_auth_session')"), "session must be cleared"
    assert page.is_visible("#authGate"), "auth gate must reopen after deleting current user"
    assert page.evaluate("state.devUnlocked === false"), "dev unlock must reset"

    # 7. Fresh registration works again after deletion
    register(page, "Новый", "Пользователь")
    assert not page.is_visible("#authGate"), "gate closed after new register"

    # 8. Read-only student cannot delete users
    unlock_settings(page)
    page.evaluate("setDeviceRole(deviceId, 'student'); state.devUnlocked = false;")
    page.wait_for_timeout(300)
    btn = page.query_selector("#userList .user-remove")
    assert btn and not btn.is_enabled(), "delete button must be disabled for students"
    blocked = page.evaluate("removeAuthAccount(JSON.parse(localStorage.getItem('attendance_auth_accounts'))[0].id)")
    assert blocked is False, "removeAuthAccount must refuse for read-only role"
    accs = json.loads(page.evaluate("localStorage.getItem('attendance_auth_accounts')"))
    assert len(accs) == 1, "account must survive blocked deletion"

    assert not errors, f"page errors: {errors}"
    print("ALL USER-DELETE TESTS PASSED")
    b.close()

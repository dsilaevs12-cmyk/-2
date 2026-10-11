"""Regression: an attendance mark must appear WITHOUT a page reload.

Two browser contexts = two devices sharing one mock GitHub Gist API.
Device A sets a mark -> immediate push; device B's echo pull applies it and
repaints the cell automatically.
"""
import json, time
from playwright.sync_api import sync_playwright

GIST_ID = "mockgist123"
STATE = {"files": {}}

def handle_route(route):
    url = route.request.url
    if "api.github.com/gists" in url:
        if route.request.method == "GET":
            body = json.dumps({"id": GIST_ID, "public": True, "truncated": False, "files": {
                n: {"content": c, "truncated": False} for n, c in STATE["files"].items()}})
            route.fulfill(status=200, body=body, content_type="application/json")
        elif route.request.method == "PATCH":
            payload = json.loads(route.request.post_data)
            for n, f in payload.get("files", {}).items():
                STATE["files"][n] = f["content"]
            route.fulfill(status=200, body=json.dumps({"id": GIST_ID}), content_type="application/json")
        else:
            route.continue_()
    else:
        route.continue_()

def login(page):
    page.goto("http://localhost:8099/index.html", wait_until="domcontentloaded")
    page.wait_for_timeout(600)
    assert page.is_visible("#authGate"), "auth gate not shown"
    page.fill("#authRegFirst", "Тест")
    page.fill("#authRegLast", "Учитель")
    page.fill("#authRegPass1", "secret123")
    page.fill("#authRegPass2", "secret123")
    page.click("#authRegisterSubmit")
    page.wait_for_function("() => !document.getElementById('authGate').hidden === false || getComputedStyle(document.getElementById('authGate')).display === 'none'", timeout=10000)
    page.wait_for_timeout(400)
    # A freshly registered account defaults to the read-only «Ученик» role, so
    # every journal control is disabled. This test acts as a TEACHER device:
    # promote it explicitly (same flag the settings role picker sets).
    page.evaluate("""() => {
        const s = currentAuthSession();
        if (s) { s.roleExplicit = true; saveAuthSession(s); }
        applyRoleRestrictions();
    }""")
    page.wait_for_selector("#studentName:not([disabled])", timeout=5000)

def connect_sync(page):
    page.evaluate("""(gid) => {
        syncConfig.enabled = true; syncConfig.gistId = gid; syncConfig.token = 'mock-token';
        saveSyncConfig(); syncInvalidate(); restartPolling(); updateSyncUI();
    }""", GIST_ID)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctxA = browser.new_context(viewport={"width": 1280, "height": 800})
    ctxB = browser.new_context(viewport={"width": 1280, "height": 800})
    for ctx in (ctxA, ctxB):
        ctx.route("**/api.github.com/**", handle_route)
    a = ctxA.new_page(); b = ctxB.new_page()

    login(a); connect_sync(a)
    login(b); connect_sync(b)

    # Device A adds a student via the real UI, then pushes.
    a.fill("#studentName", "Провер Тестович")
    a.click("#addStudentButton")
    a.wait_for_function("() => state.students.length > 0", timeout=5000)
    a.evaluate("() => fullSync('manual')")
    a.wait_for_function("() => !syncRuntime.isSyncing", timeout=15000)
    time.sleep(0.5)
    b.evaluate("() => fullSync('manual')")
    b.wait_for_function("() => !syncRuntime.isSyncing", timeout=15000)
    assert b.evaluate("() => state.students.length") > 0, "B did not receive students"

    date_key = a.evaluate("() => state.selectedDate")
    student_id = a.evaluate("() => state.students[0].id")
    sel = f'.attendance-button[data-student-id="{student_id}"][data-date-key="{date_key}"]'

    # Device A marks presence through the modal.
    a.click(sel)
    a.wait_for_selector("#attendanceModal.open", timeout=5000)
    a.click('#attOptions .att-option[data-status="present"]')
    a.wait_for_function(f"""() => {{
        const btn = document.querySelector('{sel}');
        return btn && /present|status-present/.test(btn.className);
    }}""", timeout=4000)
    print("OK: mark visible on device A without reload")

    # Idle device -> push must complete quickly (immediate fire, no long debounce).
    t0 = time.time()
    a.wait_for_function("() => syncRuntime.lastPushedAt > 0 && !syncRuntime.hasPendingChanges", timeout=8000)
    print(f"OK: push completed in {time.time()-t0:.1f}s of the mark")

    # Device B never triggers a manual pull: in production the mark must reach
    # it purely via the automatic echo burst scheduled after device A's change
    # (scheduleEchoPolls -> fullSync("echo") at 1.5/4/9 s). If the timers or
    # the noCache pull break, this wait times out — exactly the user-reported
    # "отметки появляются только после перезагрузки страницы" regression.
    b.evaluate("() => { window.__noReloadMarker = 1; }")
    t0 = time.time()
    b.wait_for_function(f"""() => {{
        const btn = document.querySelector('{sel}');
        return btn && /present|status-present/.test(btn.className);
    }}""", timeout=20000)
    print(f"OK: mark appeared on device B automatically in {time.time()-t0:.1f}s via echo burst, NO manual pull, NO page reload")
    assert b.evaluate("() => window.__noReloadMarker === 1"), "page B reloaded during test"
    print("OK: device B never reloaded")

    # Rapid successive marks: every earlier mark's echo schedule must survive
    # (regression guard against clearEchoPolls() being called per mutation).
    second_date_key = a.evaluate("""() => {
        const d = new Date(); d.setDate(d.getDate() - 1);
        return formatDateKey(d);
    }""")
    sel2 = f'.attendance-button[data-student-id="{student_id}"][data-date-key="{second_date_key}"]'
    a.click(sel2)
    a.wait_for_selector("#attendanceModal.open", timeout=5000)
    a.click('#attOptions .att-option[data-status="absent"]')
    b.wait_for_function(f"""() => {{
        const btn = document.querySelector('{sel2}');
        return btn && /absent|status-absent/.test(btn.className);
    }}""", timeout=20000)
    print("OK: second rapid mark also propagated to device B without reload")

    browser.close()
print("ALL MARK-VISIBLE TESTS PASSED")

import json, time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("file:///workspace/index.html")
    page.wait_for_timeout(800)

    # Prepare state: connect a fake gist config so device list renders
    page.evaluate("""() => {
      const devId = localStorage.getItem('attendance_device_id');
      const raw = JSON.parse(localStorage.getItem('attendance_journal_v5') || localStorage.getItem('attendance_journal'));
      // find storage key
      let key = null; for (const k of Object.keys(localStorage)) if (k.includes('attendance') && !k.includes('device') && !k.includes('sync')) key = k;
      const data = JSON.parse(localStorage.getItem(key));
      data.deviceMeta = { [devId]: { name: 'Мой ноут', role: 'teacher', seenAt: Date.now(), updatedAt: Date.now() },
                          'abcd1234other': { name: 'Планшет Ани', role: 'student', seenAt: Date.now()-3600e3, updatedAt: Date.now() } };
      localStorage.setItem(key, JSON.stringify(data));
      localStorage.setItem('attendance_sync_config', JSON.stringify({ gistId: 'fakegistid123', token: '', isPublicGist: true }));
    }""")
    page.reload(); page.wait_for_timeout(800)

    # Open settings panel via version button code? Device list lives in dev panel. Try unlocking with default code.
    page.click("#versionButton"); page.wait_for_timeout(300)
    inputs = page.query_selector_all("#devPanelModal input[type=password], #devPanelModal input")
    result = {}
    # try to enter unlock code
    unlocked = page.evaluate("""() => {
      // simulate the documented unlock: click version, enter code
      return typeof state !== 'undefined' ? state.devUnlocked : null;
    }""")
    # Fill any visible code input
    code_inputs = page.query_selector_all("#codeInput, .dev-code-input, #devPanelModal input")
    for ci in code_inputs:
        try:
            ci.fill("3333"); 
        except Exception: pass
    btns = page.query_selector_all("#devPanelModal button")
    for bt in btns:
        t = (bt.text_content() or "").lower()
        if "открыть" in t or "войти" in t or "разблокир" in t:
            bt.click(); break
    page.wait_for_timeout(400)

    # Directly render device list regardless of panel visibility
    page.evaluate("renderDeviceList()")
    page.wait_for_timeout(300)
    rows = page.evaluate("""() => {
      const out = [];
      document.querySelectorAll('#syncDeviceList .device-row').forEach(r => {
        const sel = r.querySelector('.device-role');
        out.push({ name: r.querySelector('.device-name')?.textContent, role: sel?.value, options: sel ? [...sel.options].map(o=>o.textContent) : [], disabled: sel?.disabled });
      });
      return { rows: out, bannerHidden: document.getElementById('roleBanner')?.hidden, bodyRole: document.body.getAttribute('data-role') };
    }""")
    print("RENDER:", json.dumps(rows, ensure_ascii=False))

    # Change own device role to student -> restrictions apply
    page.evaluate("""() => {
      const devId = deviceId;
      setDeviceRole(devId, 'student');
    }""")
    page.wait_for_timeout(300)
    after = page.evaluate("""() => ({
      banner: { hidden: document.getElementById('roleBanner').hidden, text: document.getElementById('roleBanner').textContent },
      addStudentDisabled: document.getElementById('addStudentButton').disabled,
      hwAddDisabled: document.getElementById('hwAddButton').disabled,
      roleOfSelf: deviceRole(deviceId)
    })""")
    print("STUDENT MODE:", json.dumps(after, ensure_ascii=False))

    # Switch back to teacher
    page.evaluate("setDeviceRole(deviceId,'teacher')")
    page.wait_for_timeout(200)
    back = page.evaluate("""() => ({
      bannerHidden: document.getElementById('roleBanner').hidden,
      addStudentDisabled: document.getElementById('addStudentButton').disabled,
      roleSelects: [...document.querySelectorAll('.device-role')].map(s=>({v:s.value,d:s.disabled}))
    })""")
    print("TEACHER BACK:", json.dumps(back, ensure_ascii=False))

    # Persistence check
    saved = page.evaluate("""() => {
      let key=null; for (const k of Object.keys(localStorage)) if (k.includes('attendance') && !k.includes('device') && !k.includes('sync')) key=k;
      const d=JSON.parse(localStorage.getItem(key));
      return Object.fromEntries(Object.entries(d.deviceMeta).map(([id,m])=>[id.slice(0,6),m.role]));
    }""")
    print("PERSISTED ROLES:", json.dumps(saved))
    print("PAGE ERRORS:", errors)
    b.close()

# -*- coding: utf-8 -*-
"""Pre-release checks for the ban screen: UI bugs, escape hatches, lags."""
import json, sys
from playwright.sync_api import sync_playwright

URL = "file:///workspace/index.html"
EXE = "/root/.cache/ms-playwright/chromium-1117/chrome-linux/chrome"
errors = []
fails = []

def bbox(pg, sel):
    loc = pg.query_selector(sel)
    return loc.bounding_box() if loc else None



def check(name, cond, detail=""):
    if cond:
        print("OK   " + name)
    else:
        print("FAIL " + name + (" | " + detail if detail else ""))
        fails.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=EXE, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    # --- register & get a session
    page.goto(URL)
    page.wait_for_timeout(600)
    page.fill("#authRegFirst", "Иван")
    page.fill("#authRegLast", "Петров")
    page.fill("#authRegPass1", "secret123")
    page.fill("#authRegPass2", "secret123")
    page.click("#authRegisterSubmit")
    page.wait_for_timeout(1200)
    check("register clears gate", not page.is_visible("#authGate"))

    # --- BUG CHECK 1: banned device must still reach settings (code dialog on top of ban screen)
    page.evaluate("() => { setBanTechAuto(true); applyShadowBan('5 неверных попыток ввода кода настроек'); }")
    page.wait_for_timeout(300)
    check("ban screen visible", page.is_visible("#banOverlay"))
    # journal is inert -> clicking version button via real mouse must NOT open settings
    vb_box = bbox(page, "#versionButton")
    check("version button exists", vb_box is not None)
    if vb_box:
        page.mouse.click(vb_box["x"] + vb_box["width"]/2, vb_box["y"] + vb_box["height"]/2)
        page.wait_for_timeout(300)
        check("inert journal blocks clicks while banned", not page.evaluate("() => document.getElementById('settingsPasswordModal').classList.contains('open')"))
    # programmatic open of the code dialog (as maintenanceDevAccessButton would)
    page.evaluate("() => { openPasswordModal(); }")
    page.wait_for_timeout(200)
    opened = page.evaluate("() => document.getElementById('settingsPasswordModal').classList.contains('open')")
    check("code dialog opens over ban screen", opened)
    if opened:
        zmodal = page.evaluate("() => getComputedStyle(document.getElementById('settingsPasswordModal')).zIndex")
        zban = page.evaluate("() => getComputedStyle(document.getElementById('banOverlay')).zIndex")
        check("code dialog above ban screen", int(zmodal) > int(zban), f"modal={zmodal} ban={zban}")
        box = bbox(page, "#settingsPasswordInput")
        check("code input clickable geometry", box is not None)
        if box:
            page.mouse.click(box["x"] + box["width"]/2, box["y"] + box["height"]/2)
            page.keyboard.type("020912")
            page.click("#settingsPasswordForm button[type=submit]")
            page.wait_for_timeout(400)
            dev_open = page.evaluate("() => document.getElementById('devPanelModal').classList.contains('open')")
            check("settings panel opens from banned device", dev_open)
            if dev_open:
                zd = page.evaluate("() => getComputedStyle(document.getElementById('devPanelModal')).zIndex")
                zb = page.evaluate("() => getComputedStyle(document.getElementById('banOverlay')).zIndex")
                check("settings panel above ban screen", int(zd) > int(zb), f"dev={zd} ban={zb}")
                # scroll to shadow-ban section and press 'Снять бан' (self-device) with REAL click
                page.evaluate("() => document.getElementById('shadowBanList').scrollIntoView({block:'center'})")
                page.wait_for_timeout(200)
                btn = page.query_selector("#shadowBanList [data-shadow-target='self-device']")
                check("unban-self button present in settings", btn is not None)
                if btn:
                    btn.click()
                    page.wait_for_timeout(400)
                    check("real-click unban lifts ban", not page.evaluate("() => !!localStorage.getItem('attendance_shadow_ban')"))
                    check("ban screen hidden after unban", not page.is_visible("#banOverlay"))
                # close settings, then verify the journal is interactive again
                page.evaluate("() => { collapseDevPanel(); }")
                page.wait_for_timeout(200)
                check("journal interactive again", not page.evaluate("() => document.getElementById('journalApp').inert"))
    # after unban: stacking resets
    zb = page.evaluate("() => document.getElementById('banOverlay').style.zIndex")
    check("ban overlay z reset when unbanned", zb in ("9400", ""), "got " + str(zb))

    # --- BUG CHECK 2: re-ban, then Escape/backdrop must not dismiss the ban screen itself
    page.evaluate("() => { applyShadowBan('Ручная блокировка', 'тех. работник'); }")
    page.wait_for_timeout(300)
    check("re-ban shows screen", page.is_visible("#banOverlay"))
    page.keyboard.press("Escape")
    page.mouse.click(10, 10)  # click on the overlay background
    page.wait_for_timeout(200)
    check("ban screen survives Escape+backdrop clicks", page.is_visible("#banOverlay"))
    # Tab cycling should stay inside the ban screen (it has no focusables besides title) — just ensure no crash
    for _ in range(5):
        page.keyboard.press("Tab")
    page.wait_for_timeout(150)
    check("tabbing while banned does not crash", page.is_visible("#banOverlay"))

    # --- BUG CHECK 3: IP ban inherited -> screen shows IP + reason; lift works
    page.evaluate("""() => {
      localStorage.setItem('attendance_public_ip_cache', JSON.stringify({ip:'203.0.113.7', at: Date.now()}));
      localStorage.removeItem('attendance_shadow_ban');
      setDeviceShadowBan('ip:203.0.113.7', true, 'Ручной бан по IP');
    }""")
    page.wait_for_timeout(300)
    check("IP ban shows screen", page.is_visible("#banOverlay"))
    ip_txt = page.inner_text("#banDeviceIp")
    check("IP shown on ban screen", "203.0.113.7" in ip_txt, ip_txt)
    reason = page.inner_text("#banReason")
    check("IP ban reason shown", "бан по ip-адресу" in reason.lower(), reason)
    by = page.inner_text("#banBy")
    check("IP ban issuer = tech worker", "тех." in by, by)
    date = page.inner_text("#banDate")
    check("IP ban date shown", "." in date and len(date) > 6, date)
    page.evaluate("() => { liftShadowBan(); }")
    page.wait_for_timeout(300)
    check("IP ban lifted", not page.is_visible("#banOverlay"))

    # --- BUG CHECK 4: account ban inheritance + tech text placeholder
    page.evaluate("""() => {
      var s = JSON.parse(localStorage.getItem('attendance_auth_session'));
      setAccountShadowBan(s.accountId, true, 'Иван Петров');
    }""")
    page.wait_for_timeout(300)
    check("account ban shows screen", page.is_visible("#banOverlay"))
    acc_reason = page.inner_text("#banReason")
    check("account ban label used as reason", "иван петров" in acc_reason.lower(), acc_reason)
    page.evaluate("() => { liftShadowBan(); }")
    page.wait_for_timeout(200)

    # --- BUG CHECK 5: reload persistence while modal-open state existed before ban
    page.evaluate("() => { applyShadowBan('тест перезагрузки'); }")
    page.reload(); page.wait_for_timeout(800)
    check("ban screen after reload", page.is_visible("#banOverlay"))
    check("body overflow locked after reload", page.evaluate("() => document.body.style.overflow === 'hidden'"))

    # --- LAG CHECK: render pipeline coalescing + fast repeated renders
    perf = page.evaluate("""async () => {
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) renderBanScreen();
      const tSerial = performance.now() - t0;
      // simulated heavy frame path: schedule 100 renders through rAF pipeline
      const marks = [];
      let framesBefore = performance.getEntriesByType('measure').length;
      const t1 = performance.now();
      await new Promise(r => requestAnimationFrame(() => {
        for (let i = 0; i < 100; i++) render();
        requestAnimationFrame(r);
      }));
      const tRaf = performance.now() - t1;
      return { tSerial, tRaf };
    }""")
    check("200 direct ban-screen renders < 120ms", perf["tSerial"] < 120, json.dumps(perf))
    check("100 scheduled full renders within ~2 frames < 400ms", perf["tRaf"] < 400, json.dumps(perf))

    # layout thrash check: reading bounding box during ban screen stays stable
    b1 = bbox(page, "#banOverlay")
    page.evaluate("() => renderBanScreen()")
    b2 = bbox(page, "#banOverlay")
    check("no layout jump on re-render", b1 and b2 and abs(b1["height"] - b2["height"]) < 1.5, f"{b1} vs {b2}")

    # --- long tech text doesn't break layout (overflow-wrap)
    page.evaluate("() => { liftShadowBan(); setBanTechAuto(true); setBanTechText('Очень длинный технический текст без пробелов: " + "А"*900 + "'); applyShadowBan('длинный текст'); }")
    page.wait_for_timeout(250)
    fits = page.evaluate("""() => {
      const c = document.querySelector('.ban-content');
      return c.scrollWidth <= c.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1;
    }""")
    check("long tech text wraps without horizontal overflow", fits)

    # mobile viewport sanity
    page.set_viewport_size({"width": 360, "height": 640})
    page.wait_for_timeout(250)
    fits_m = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
    check("mobile 360px: no horizontal scroll", fits_m)
    vis = page.is_visible("#banOverlay")
    check("mobile: ban screen visible", vis)

    js_errs = [e for e in errors if "ipify" not in e and "Failed to load resource" not in e and "net::ERR" not in e]
    check("no JS console errors", not js_errs, json.dumps(js_errs[:4], ensure_ascii=False))

    browser.close()

if fails:
    print("\n=== RELEASE CHECK FAILED: %d issue(s) ===" % len(fails))
    sys.exit(1)
print("\nALL PRE-RELEASE BAN CHECKS PASSED")

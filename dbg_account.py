from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_context(viewport={"width":1280,"height":900}).new_page()
    errs=[]; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto("file:///workspace/index.html"); page.wait_for_timeout(500)
    page.fill("#authRegFirst","Иван"); page.fill("#authRegLast","Петров")
    page.fill("#authRegPass1","Secret123!"); page.fill("#authRegPass2","Secret123!")
    page.click("#authRegisterSubmit"); page.wait_for_timeout(1500)
    page.click("[data-nav='account']"); page.wait_for_timeout(400)
    info = page.evaluate("""() => {
      const btn = document.getElementById('accountLogoutButton');
      const panel = document.getElementById('accountPanel');
      const r = btn.getBoundingClientRect();
      return {
        errs: window.__errs || [],
        btnRect: [r.x, r.y, r.width, r.height],
        btnDisplay: getComputedStyle(btn).display,
        btnVis: getComputedStyle(btn).visibility,
        panelHidden: panel.hidden,
        panelDisplay: getComputedStyle(panel).display,
        panelRect: (p=>[p.x,p.y,p.width,p.height])(panel.getBoundingClientRect()),
        bodyClass: document.body.className,
        appClass: document.getElementById('journalApp').className,
        html: panel.outerHTML.slice(0, 300),
      };
    }""")
    print(info)
    print("pageerrors:", errs)
    b.close()

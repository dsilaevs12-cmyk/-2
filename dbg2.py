from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_context(viewport={"width":1280,"height":900}).new_page()
    page.goto("file:///workspace/index.html"); page.wait_for_timeout(500)
    page.fill("#authRegFirst","Иван"); page.fill("#authRegLast","Петров")
    page.fill("#authRegPass1","Secret123!"); page.fill("#authRegPass2","Secret123!")
    page.click("#authRegisterSubmit"); page.wait_for_timeout(1500)
    page.click("[data-nav='account']"); page.wait_for_timeout(400)
    out = page.evaluate("""() => {
      const p = document.getElementById('accountPanel');
      const chain = [];
      let el = p;
      while (el && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        chain.push({tag: el.tagName + (el.id ? '#'+el.id : '.'+el.className.split(' ').join('.')), display: cs.display, vis: cs.visibility, op: cs.opacity, rectW: el.getBoundingClientRect().width});
        el = el.parentElement;
      }
      return chain;
    }""")
    for c in out: print(c)
    b.close()

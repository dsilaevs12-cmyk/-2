from playwright.sync_api import sync_playwright

def vis(page, sel):
    els = page.query_selector_all(sel)
    if not els: return False
    return els[0].evaluate("el => { let n = el; while (n) { if (n.hidden || getComputedStyle(n).display === 'none') return false; n = n.parentElement; } return true; }")

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width":1280,"height":900})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto("file:///workspace/index.html"); pg.wait_for_timeout(500)
    # seed students + homework through the app's own API so saveLocal writes them
    pg.evaluate("""() => {
      addStudent.name; // noop
      dom.studentNameInput.value = 'Иван Петров'; addStudent();
      dom.hwText.value = 'ДЗ: упр. 5-7'; addHomeworkEntry();
    }""")
    # set role student via the app's own function (correct updatedAt/clock)
    pg.evaluate("() => setDeviceRole(deviceId, 'student')")
    pg.wait_for_timeout(400)
    res = {
      "role_now": pg.evaluate("() => deviceRole(deviceId)"),
      "body_class": pg.eval_on_selector("body","b=>b.className"),
      "nav_homework_visible": vis(pg, "#glassNavigation [data-nav='homework']"),
      "nav_students_visible": vis(pg, "#glassNavigation [data-nav='students']"),
      "nav_reports_visible": vis(pg, "#glassNavigation [data-nav='reports']"),
      "nav_settings_visible": vis(pg, "#glassNavigation [data-nav='settings']"),
      "syncOverview_visible": vis(pg, "#syncOverview"),
      "summary_visible": vis(pg, ".summary-grid"),
      "class_toolbar_visible": vis(pg, "#journalControls .class-toolbar"),
      "search_visible": vis(pg, "#journalControls .search-block"),
      "legend_visible": vis(pg, "#attendanceTableCard .legend"),
      "month_nav_visible": vis(pg, ".month-navigation"),
      "hwPanel_visible": vis(pg, "#hwPanel"),
      "hw_textarea_visible": vis(pg, "#hwText"),
      "hw_addbtn_visible": vis(pg, "#hwAddButton"),
      "table_rows": len(pg.query_selector_all("#tableBody tr")),
      "hw_items": pg.eval_on_selector_all("#hwHistory > *","els=>els.length"),
      "banner": pg.eval_on_selector("#roleBanner","el=>({hidden:el.hidden,text:el.textContent})"),
      "export_btn_visible": vis(pg, "#exportBackupButton"),
    }
    print("STUDENT:", res); print("ERRORS:", errors)

    # persistence after reload
    pg.reload(); pg.wait_for_timeout(700)
    res2 = {
      "role": pg.evaluate("() => deviceRole(deviceId)"),
      "body_class": pg.eval_on_selector("body","b=>b.className"),
      "summary_visible": vis(pg, ".summary-grid"),
      "hwPanel_visible": vis(pg, "#hwPanel"),
      "table_rows": len(pg.query_selector_all("#tableBody tr")),
      "hw_items": pg.eval_on_selector_all("#hwHistory > *","els=>els.length"),
    }
    print("RELOAD:", res2)

    # tech-admin add-on restores everything for a student
    pg.evaluate("() => setDeviceTechAdmin(deviceId, true)")
    pg.wait_for_timeout(300)
    res3 = {
      "body_class": pg.eval_on_selector("body","b=>b.className"),
      "summary_visible": vis(pg, ".summary-grid"),
      "search_visible": vis(pg, "#journalControls .search-block"),
      "nav_reports_visible": vis(pg, "#glassNavigation [data-nav='reports']"),
      "banner": pg.eval_on_selector("#roleBanner","el=>({hidden:el.hidden,text:el.textContent})"),
    }
    print("TECHADMIN:", res3)

    # back to plain teacher
    pg.evaluate("() => { setDeviceTechAdmin(deviceId, false); setDeviceRole(deviceId, 'teacher'); }")
    pg.wait_for_timeout(300)
    res4 = {
      "body_class": pg.eval_on_selector("body","b=>b.className"),
      "summary_visible": vis(pg, ".summary-grid"),
      "banner_hidden": pg.eval_on_selector("#roleBanner","el=>el.hidden"),
      "addbtn_enabled": pg.eval_on_selector("#addStudentButton","el=>!el.disabled"),
    }
    print("TEACHER:", res4); print("ERRORS-FINAL:", errors)
    b.close()

# -*- coding: utf-8 -*-
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errors = []
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto("file:///workspace/index.html")
    pg.wait_for_timeout(600)

    r = {}
    # 1. Role select has exactly 3 options now
    r["role_options"] = pg.eval_on_selector_all(".device-role option", "els=>els.map(e=>e.value)")

    # 2. Seed deviceMeta with own device student + fake other device admin legacy
    did = pg.evaluate("deviceId")
    pg.evaluate("""(did)=>{
      state.deviceMeta = {};
      setDeviceRole(did,'student');
      state.deviceMeta['ffff0000']={name:'Чужой',role:'admin',seenAt:Date.now(),updatedAt:Date.now()};
      renderDeviceList();
    }""", did)
    pg.wait_for_timeout(300)
    r["own_role"] = pg.evaluate("deviceRole(deviceId)")
    r["legacy_admin_migrated"] = pg.evaluate("state.deviceMeta['ffff0000'].role + '/' + state.deviceMeta['ffff0000'].techAdmin")
    r["banner_visible_student"] = pg.evaluate("!document.getElementById('roleBanner').hidden && document.getElementById('roleBanner').textContent")
    r["addbtn_disabled_student"] = pg.evaluate("document.getElementById('addStudentButton').disabled")
    r["hwadd_disabled_student"] = pg.evaluate("document.getElementById('hwAddButton').disabled")

    # 3. Tech-admin chip on own row; click grants add-on (own device allowed w/o token)
    chip_sel = ".device-tech-flag[data-device-id='%s']" % did
    r["chip_present"] = pg.evaluate("!!document.querySelector(%s)" % json.dumps(chip_sel))
    pg.click(chip_sel)
    pg.wait_for_timeout(300)
    r["tech_after_click"] = pg.evaluate("deviceTechAdmin(deviceId)")
    r["chip_active_class"] = pg.evaluate("document.querySelector(%s).classList.contains('is-active')" % json.dumps(chip_sel))
    r["banner_tech"] = pg.evaluate("document.getElementById('roleBanner').textContent")
    r["addbtn_enabled_tech"] = pg.evaluate("!document.getElementById('addStudentButton').disabled")
    r["hwadd_enabled_tech"] = pg.evaluate("!document.getElementById('hwAddButton').disabled")

    # 4. Write path actually works with tech-admin over student role
    pg.fill("#studentNameInput", "Проверка ролей")
    pg.click("#addStudentButton")
    pg.wait_for_timeout(200)
    r["student_added_with_tech"] = pg.evaluate("state.students.some(s=>s.name==='Проверка ролей')")

    # 5. Remove tech flag -> locks again
    pg.click(chip_sel)
    pg.wait_for_timeout(200)
    r["tech_removed"] = pg.evaluate("!deviceTechAdmin(deviceId)")
    r["locked_again"] = pg.evaluate("document.getElementById('addStudentButton').disabled")

    # 6. Password unlock grants tech admin: set role observer, submit code
    pg.evaluate("(did)=>setDeviceRole(did,'observer')", did)
    pg.wait_for_timeout(150)
    r["observer_locked"] = pg.evaluate("document.getElementById('addStudentButton').disabled")
    pg.click("#versionButton")
    pg.wait_for_timeout(200)
    pg.fill("#settingsPasswordInput", "020912")
    pg.press("#settingsPasswordInput", "Enter")
    pg.wait_for_timeout(400)
    r["password_grants_tech"] = pg.evaluate("deviceTechAdmin(deviceId) || state.devUnlocked")
    r["observer_unlocked_by_password"] = pg.evaluate("!document.getElementById('addStudentButton').disabled")
    # exit settings removes it
    pg.click("#devExitButton")
    pg.wait_for_timeout(300)
    r["exit_removes_tech"] = pg.evaluate("!deviceTechAdmin(deviceId) && !state.devUnlocked")
    r["locked_after_exit"] = pg.evaluate("document.getElementById('addStudentButton').disabled")

    # 7. teacher role full access
    pg.evaluate("(did)=>{setDeviceRole(did,'teacher');applyRoleRestrictions();}", did)
    pg.wait_for_timeout(150)
    r["teacher_full"] = pg.evaluate("!document.getElementById('addStudentButton').disabled && !document.getElementById('hwAddButton').disabled && document.getElementById('roleBanner').hidden")

    # 8. persistence across reload
    pg.reload(wait_until="load"); pg.wait_for_timeout(600)
    r["persisted_role"] = pg.evaluate("deviceRole(deviceId)")
    r["persisted_meta_has_flag_field"] = pg.evaluate("'techAdmin' in (JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.indexOf('journal')!==-1)||'') )?.deviceMeta||{}[deviceId]||{})".replace("journal","attendance"))

    r["console_errors"] = errors
    print(json.dumps(r, ensure_ascii=False, indent=1))
    b.close()

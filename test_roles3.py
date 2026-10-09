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

    did = pg.evaluate("deviceId")
    # open dev panel (default teacher -> no password needed)
    pg.click("#versionButton"); pg.wait_for_timeout(300)
    r["panel_open"] = pg.evaluate("document.getElementById('devPanelModal').classList.contains('open')")
    r["role_options"] = pg.eval_on_selector_all(".device-role option", "els=>[...new Set(els.map(e=>e.value))]")

    # own device row exists with chip
    chip_sel = ".device-tech-flag[data-device-id='%s']" % did
    r["chip_present"] = pg.evaluate("!!document.querySelector(%s)" % json.dumps(chip_sel))

    # switch role to student via UI select
    pg.select_option(".device-role[data-device-id='%s']" % did, "student"); pg.wait_for_timeout(250)
    r["own_role"] = pg.evaluate("deviceRole(deviceId)")
    r["banner_student"] = pg.evaluate("document.getElementById('roleBanner').textContent")
    r["addbtn_disabled_student"] = pg.evaluate("document.getElementById('addStudentButton').disabled")
    r["hwadd_disabled_student"] = pg.evaluate("document.getElementById('hwAddButton').disabled")
    # write attempt blocked at logic level too
    r["commit_blocked"] = pg.evaluate("(n)=>{var before=state.students.length;commitProject(['x']);return state.students.length===before;}","noop")

    # grant tech admin via chip click (own device)
    pg.click(chip_sel); pg.wait_for_timeout(250)
    r["tech_after_click"] = pg.evaluate("deviceTechAdmin(deviceId)")
    r["chip_active"] = pg.evaluate("document.querySelector(%s).classList.contains('is-active')" % json.dumps(chip_sel))
    r["banner_tech_over_student"] = pg.evaluate("document.getElementById('roleBanner').textContent")
    r["addbtn_enabled_tech"] = pg.evaluate("!document.getElementById('addStudentButton').disabled")
    pg.fill("#studentNameInput", "Техпроверка"); pg.click("#addStudentButton"); pg.wait_for_timeout(200)
    r["student_added_with_tech"] = pg.evaluate("state.students.some(s=>s.name==='Техпроверка')")

    # remove flag -> locked again
    pg.click(chip_sel); pg.wait_for_timeout(250)
    r["locked_again"] = pg.evaluate("document.getElementById('addStudentButton').disabled")

    # observer + password unlock flow: close panel first
    pg.select_option(".device-role[data-device-id='%s']" % did, "observer"); pg.wait_for_timeout(200)
    pg.click("#devCloseButton"); pg.wait_for_timeout(300)
    r["observer_locked"] = pg.evaluate("document.getElementById('addStudentButton').disabled")
    pg.click("#versionButton"); pg.wait_for_timeout(250)
    r["pw_modal"] = pg.evaluate("document.getElementById('settingsPasswordModal').classList.contains('open')")
    pg.fill("#settingsPasswordInput", "020912"); pg.press("#settingsPasswordInput", "Enter"); pg.wait_for_timeout(400)
    r["password_grants_tech"] = pg.evaluate("deviceTechAdmin(deviceId)")
    r["auto_promoted_teacher"] = pg.evaluate("deviceRole(deviceId)")
    r["unlocked_by_password"] = pg.evaluate("!document.getElementById('addStudentButton').disabled")

    # exit settings removes add-on and locks again (role stays teacher now, so still unlocked — check flag only)
    pg.click("#devExitButton"); pg.wait_for_timeout(300)
    r["exit_removes_flag"] = pg.evaluate("!deviceTechAdmin(deviceId) && !state.devUnlocked")
    r["teacher_still_full"] = pg.evaluate("!document.getElementById('addStudentButton').disabled")

    # legacy admin migration through cleanDeviceMeta
    r["legacy_migrated"] = pg.evaluate("JSON.stringify(cleanDeviceMeta({aa:{name:'X',role:'admin'}}).aa)")

    # persistence across reload
    pg.reload(wait_until="load"); pg.wait_for_timeout(600)
    r["persisted_role"] = pg.evaluate("deviceRole(deviceId)")
    r["persisted_meta_field"] = pg.evaluate("'techAdmin' in ((state.deviceMeta||{})[deviceId]||{})")
    r["console_errors"] = errors
    print(json.dumps(r, ensure_ascii=False, indent=1))
    b.close()

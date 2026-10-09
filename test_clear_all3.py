import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errors = []
    dialogs_log = []
    mode = {"prompt_answer": "НЕТО"}
    pg.on("pageerror", lambda e: errors.append(str(e)))

    def dialog_handler(d):
        dialogs_log.append((d.type, d.message[:40]))
        if d.type == "prompt":
            d.accept(mode["prompt_answer"])
        else:
            d.accept()
    pg.on("dialog", dialog_handler)

    pg.goto("file:///workspace/index.html")
    pg.wait_for_timeout(600)
    seed = {
        "version": 5,
        "students": [
            {"id":"s1","name":"Иванов Иван","updatedAt":1,"actor":"","deleted":False,"classId":"class-main"},
            {"id":"s2","name":"Петрова Анна","updatedAt":1,"actor":"","deleted":False,"classId":"class-main"}],
        "attendance": {"s1_2026-10-01":{"status":"present","updatedAt":1,"actor":""},
                        "s2_2026-10-01":{"status":"absent","updatedAt":1,"actor":""}},
        "settings": {}
    }
    pg.evaluate("""(seed)=>{localStorage.setItem('attendance_diary_data',JSON.stringify(seed));
      localStorage.setItem('attendance_settings_unlocked','1');
      localStorage.setItem('attendance_auth_accounts',JSON.stringify([{id:'acc1',firstName:'Тест',lastName:'Тестов',fullName:'Тест Тестов',phone:'',saltHash:'',iterations:1,createdAt:Date.now()}]));
      localStorage.setItem('attendance_auth_session',JSON.stringify({accountId:'acc1',fullName:'Тест Тестов',method:'register',roleExplicit:true}));}""", seed)
    pg.reload(); pg.wait_for_timeout(800)
    live = pg.evaluate("()=>state.students.filter(s=>!s.deleted).length")
    print("live students after load:", live)
    assert live == 2, "seed не загрузился"

    perms = pg.evaluate("()=>({role:deviceRole(deviceId), edit:effectivePermissions().canEditJournal, manage:effectivePermissions().canManageDevices})")
    print("perms:", perms)
    assert perms["edit"] and perms["manage"], "нет прав учителя/админа"

    pg.evaluate("()=>openDevPanel()"); pg.wait_for_timeout(300)
    assert pg.locator("#devClearAllButton").count() == 1, "кнопки очистки нет"
    has_hw = pg.evaluate("()=>{try{dom.hwText.value='Проверочная';addHomeworkEntry();return state.homework.filter(h=>!h.deleted).length}catch(e){return -1}}")
    print("homework live:", has_hw)
    assert has_hw == 1, "ДЗ не добавилось"

    # wrong code must NOT clear
    dialogs_log.clear()
    pg.click("#devClearAllButton"); pg.wait_for_timeout(700)
    alive = pg.evaluate("()=>state.students.filter(s=>!s.deleted).length")
    print("after wrong code, live students:", alive, "| dialogs:", dialogs_log)
    assert len(dialogs_log) == 2 and dialogs_log[0][0]=="confirm" and dialogs_log[1][0]=="prompt", "ожидается confirm+prompt"
    assert alive == 2, "неправильный код не должен очищать"

    # correct code clears everything
    mode["prompt_answer"] = "ОЧИСТИТЬ"
    dialogs_log.clear()
    pg.click("#devClearAllButton"); pg.wait_for_timeout(900)
    res = pg.evaluate("""()=>({
      liveStudents: state.students.filter(s=>!s.deleted).length,
      marks: Object.values(state.attendance||{}).filter(a=>a.status!=='unmarked').length,
      liveHw: (state.homework||[]).filter(h=>!h.deleted).length,
      classes: state.classes.filter(c=>!c.deleted).length,
      queued: Object.keys(offline.queue).filter(k=>!offline.queue[k].done).length,
      backups: JSON.parse(localStorage.getItem('attendance_recovery_backups')||'[]').length,
      toast: document.getElementById('toast').textContent})""")
    print("AFTER CLEAR:", json.dumps(res, ensure_ascii=False), "| dialogs:", dialogs_log)
    assert res["liveStudents"]==0, "ученики не удалены"
    assert res["marks"]==0, "отметки не сброшены"
    assert res["liveHw"]==0, "ДЗ не удалены"
    assert res["classes"]>=1, "классы должны остаться"
    assert res["backups"]>=1, "копия не сохранена"
    assert res["queued"]>0, "изменения не встали в очередь синхронизации"

    # persistence across reload
    pg.reload(); pg.wait_for_timeout(800)
    after_reload = pg.evaluate("()=>({st:state.students.filter(s=>!s.deleted).length, hw:(state.homework||[]).filter(h=>!h.deleted).length})")
    print("after reload:", after_reload)
    assert after_reload["st"]==0 and after_reload["hw"]==0, "очистка не сохранилась после перезагрузки"

    # restore from backup
    pg.evaluate("()=>restoreBackup()"); pg.wait_for_timeout(800)
    restored = pg.evaluate("()=>({st:state.students.filter(s=>!s.deleted).length, hw:(state.homework||[]).filter(h=>!h.deleted).length})")
    print("after restore:", restored)
    assert restored["st"] == 2, "восстановление из копии не сработало"

    print("pageerrors:", errors)
    assert not errors
    b.close()
print("ALL OK")

import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errors = []
    dialogs = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto("file:///workspace/index.html")
    pg.wait_for_timeout(600)
    seed = {
        "version": 5,
        "students": [
            {"id":"s1","name":"Иванов Иван","updatedAt":1,"actor":"","deleted":False,"classId":"class-main"},
            {"id":"s2","name":"Петрова Анна","updatedAt":1,"actor":"","deleted":False,"classId":"class-main"}],
        "attendance": {"s1|2026-10-01":{"status":"present","updatedAt":1,"actor":""},
                        "s2|2026-10-01":{"status":"absent","updatedAt":1,"actor":""}},
        "settings": {}
    }
    pg.evaluate("""(seed)=>{localStorage.setItem('attendance_diary_data',JSON.stringify(seed));
      localStorage.setItem('attendance_settings_unlocked','1');
      localStorage.setItem('attendance_auth_accounts',JSON.stringify([{id:'acc1',firstName:'Тест',lastName:'Тестов',fullName:'Тест Тестов',phone:'',saltHash:'',iterations:1,createdAt:Date.now()}]));
      localStorage.setItem('attendance_auth_session',JSON.stringify({accountId:'acc1',fullName:'Тест Тестов',method:'register',roleExplicit:true}));}""", seed)
    pg.reload(); pg.wait_for_timeout(800)
    print("live after load:", pg.evaluate("()=>state.students.filter(s=>!s.deleted).length"))
    pg.evaluate("()=>{openDevPanel();}")
    pg.wait_for_timeout(300)
    assert pg.locator("#devClearAllButton").count() == 1, "кнопки очистки нет"
    has_hw = pg.evaluate("()=>{try{dom.hwText.value='Проверочная';addHomeworkEntry();return state.homework.filter(h=>!h.deleted).length}catch(e){return -1}}")
    print("homework live:", has_hw)

    def wrong_code(d):
        dialogs.append(("W", d.type, d.message[:50]))
        if d.type == "prompt": d.accept("НЕТО")
        else: d.accept()
    pg.on("dialog", wrong_code)
    pg.click("#devClearAllButton"); pg.wait_for_timeout(700)
    alive = pg.evaluate("()=>state.students.filter(s=>!s.deleted).length")
    print("after wrong code, live students:", alive, "| dialogs:", dialogs)
    assert alive == 2, "неправильный код не должен очищать"

    pg.remove_all_listeners("dialog")
    seen = []
    def ok_code(d):
        seen.append((d.type, d.message[:50]))
        if d.type == "prompt": d.accept("ОЧИСТИТЬ")
        else: d.accept()
    pg.on("dialog", ok_code)
    pg.click("#devClearAllButton"); pg.wait_for_timeout(800)
    res = pg.evaluate("""()=>({
      liveStudents: state.students.filter(s=>!s.deleted).length,
      marks: Object.values(state.attendance||{}).filter(a=>a.status!=='unmarked').length,
      liveHw: (state.homework||[]).filter(h=>!h.deleted).length,
      classes: state.classes.filter(c=>!c.deleted).length,
      queued: Object.keys(offline.queue).filter(k=>!offline.queue[k].done).length,
      backups: JSON.parse(localStorage.getItem('attendance_recovery_backups')||'[]').length})""")
    print("AFTER CLEAR:", json.dumps(res, ensure_ascii=False), "| dialogs:", seen)
    assert res["liveStudents"]==0 and res["marks"]==0 and res["liveHw"]==0 and res["classes"]>=1 and res["backups"]>=1

    pg.remove_all_listeners("dialog")
    pg.on("dialog", lambda d: d.accept())
    pg.evaluate("()=>restoreBackup()"); pg.wait_for_timeout(700)
    restored = pg.evaluate("()=>({st:state.students.filter(s=>!s.deleted).length, hw:(state.homework||[]).filter(h=>!h.deleted).length})")
    print("after restore:", restored)
    assert restored["st"] == 2, "восстановление из копии не сработало"
    print("pageerrors:", errors)
    assert not errors
    b.close()
print("ALL OK")

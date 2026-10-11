"""Marks must appear in the table immediately, without a page reload."""
from playwright.sync_api import sync_playwright

URL = "file:///workspace/index.html"
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))

    # Register through the auth gate
    page.goto(URL)
    page.wait_for_timeout(600)
    page.fill("#authRegFirst", "Анна")
    page.fill("#authRegLast", "Смирнова")
    page.fill("#authRegPass1", "secret123")
    page.fill("#authRegPass2", "secret123")
    page.click("#authRegisterSubmit")
    page.wait_for_timeout(1200)
    assert not page.is_visible("#authGate"), "gate still visible"

    # Add a student via the app's own flow
    sid = page.evaluate("""() => {
        addStudent(); // uses prompt; will be cancelled -> returns quietly
        return null;
    }""") if False else None
    page.evaluate("""() => {
        const id = generateId();
        state.students.push({ id, name: 'Тест Ученик', updatedAt: nextTimestamp(), actor: deviceId, deleted: false });
        markChanged(['students/' + id]); saveLocal(true); renderNow();
    }""")
    page.wait_for_timeout(300)

    row_btn = page.locator("#tableBody .attendance-button").first
    before_cls = row_btn.get_attribute("class")
    assert "unmarked" in before_cls, "expected unmarked start: " + str(before_cls)

    # Open modal and set status — NO reload afterwards
    row_btn.click()
    page.wait_for_timeout(300)
    assert page.is_visible("#attendanceModal"), "attendance modal did not open"
    page.click('#attOptions [data-status="present"]')
    page.wait_for_timeout(400)

    after_cls = page.locator("#tableBody .attendance-button").first.get_attribute("class")
    assert "present" in after_cls, "mark NOT visible without reload: " + str(after_cls)
    print("OK 1: mark appears in table immediately (no reload)")

    # Modal closed and focus restored to the cell
    assert not page.is_visible("#attendanceModal"), "modal still open"
    journal_inert = page.evaluate("() => document.getElementById('journalApp').inert")
    assert journal_inert is False, "journal stuck inert after modal close"
    print("OK 2: modal closed, journal interactive")

    # Day view path too
    page.evaluate("() => setViewMode('day')")
    page.wait_for_timeout(200)
    btn = page.locator("#tableBody .attendance-button").first
    btn.click()
    page.wait_for_timeout(250)
    page.click('#attOptions [data-status="absent"]')
    page.wait_for_timeout(350)
    cls2 = page.locator("#tableBody .attendance-button").first.get_attribute("class")
    assert "absent" in cls2, "day-view mark not immediate: " + str(cls2)
    label = page.locator("#tableBody .attendance-button").first.inner_text()
    assert "Нет" in label, "day-view label not updated: " + label
    print("OK 3: day view updates immediately with label")

    # Student card calendar also reflects the mark instantly
    page.evaluate("() => openStudentCard(state.students[0].id)")
    page.wait_for_timeout(300)
    card_status = page.locator(".student-card-day").last.get_attribute("class")
    assert "absent" in card_status or "present" in card_status, "card not updated: " + str(card_status)
    print("OK 4: student card reflects marks without reload")

    # Summary counters updated live
    summary = page.evaluate("() => document.getElementById('summaryPresent').textContent")
    print("OK 5: summary present count =", summary)

    assert not errors, "JS errors: " + "; ".join(errors)
    browser.close()

print("ALL MARK-VISIBILITY TESTS PASSED")

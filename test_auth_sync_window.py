#!/usr/bin/env python3
"""E2E test for the sync window inside the login menu (auth gate): opens the
window, checks connection against a mocked gist API, saves the connection and
verifies the journal is pulled while still on the login screen."""
import json, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

STATE = {"files": {}, "public": True}
GIST_ID = "abc123def456"
# A pre-existing journal pushed from another device.
REMOTE_DATA = {"version": 4, "students": [{"id": "s1", "name": "Иван Петров", "classId": "class-main"}],
               "attendance": {}, "settings": {}}
STATE["files"] = {"attendance.device.other.json": json.dumps(REMOTE_DATA, ensure_ascii=False)}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match")
        self.send_header("Access-Control-Expose-Headers", "ETag")
        self.send_header("Access-Control-Allow-Methods", "GET, PATCH, POST, OPTIONS")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_GET(self):
        m = re.match(r"^/api/gists/([a-f0-9]+)$", self.path)
        if m:
            body = json.dumps({"id": m.group(1), "public": STATE["public"],
                               "files": {k: {"content": v, "truncated": False} for k, v in STATE["files"].items()}}).encode()
            self.send_response(200); self._cors()
            self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(body); return
        m = re.match(r"^/raw/([^/]+)$", self.path)
        if m:
            from urllib.parse import unquote
            name = unquote(m.group(1))
            if name in STATE["files"]:
                self.send_response(200); self._cors(); self.end_headers()
                self.wfile.write(STATE["files"][name].encode()); return
            self.send_response(404); self._cors(); self.end_headers(); return
        if self.path.startswith("/gistpage"):
            links = "".join(f'<a href="/owner/{GIST_ID}/raw/{n}">{n}</a>' for n in STATE["files"])
            self.send_response(200); self._cors(); self.send_header("Content-Type", "text/html"); self.end_headers()
            self.wfile.write((f"<html>{links}</html>").encode()); return
        self.send_response(404); self._cors(); self.end_headers()

srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
GIST_URL = f"http://127.0.0.1:{PORT}"

results = []
def ok(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}: {name} {extra}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context().new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    def handle_fulfill(route):
        url = route.request.url
        if "api.github.com" in url:
            path = "/api" + url.split("api.github.com")[1]
        elif "/raw/" in url:
            path = "/raw/" + url.rsplit("/raw/", 1)[1]
        elif "gist.github.com" in url:
            path = "/gistpage"
        else:
            route.abort(); return
        import urllib.request
        try:
            data = route.request.post_data
            req = urllib.request.Request(GIST_URL + path, data=(data.encode() if data else None), method=route.request.method)
            with urllib.request.urlopen(req, timeout=10) as resp:
                headers = {k.lower(): v for k, v in resp.getheaders()}
                headers["access-control-allow-origin"] = "*"
                route.fulfill(status=resp.status, body=resp.read(), headers=headers)
        except Exception:
            route.abort()
    page.route(re.compile(r"https://api\.github\.com/.*"), handle_fulfill)
    page.route(re.compile(r"https://gist\.githubusercontent\.com/.*"), handle_fulfill)
    page.route(re.compile(r"https://gist\.github\.com/.*"), handle_fulfill)

    page.goto("file:///workspace/index.html")
    page.wait_for_timeout(800)

    # The auth gate is open on a fresh device; the sync window must be closed initially.
    ok("gate visible", not page.evaluate("document.getElementById('authGate').hidden"))
    ok("sync panel hidden initially", page.evaluate("document.getElementById('authSyncPanel').hidden"))
    ok("open button visible", page.is_visible("#authSyncOpenButton"))

    # Open the sync window.
    page.click("#authSyncOpenButton")
    page.wait_for_timeout(100)
    ok("sync panel opened", page.is_visible("#authSyncPanel"))
    ok("open button hidden after opening", page.evaluate("document.getElementById('authSyncOpenButton').hidden"))

    # Invalid gist input → inline error, no crash. ("not-a-gist" contains the
    # valid hex token "at"? no — but "gist" letters g/i/s/t are not hex; use a
    # string that is definitely not 5+ hex chars.)
    page.fill("#authSyncGist", "zzzz")
    page.click("#authSyncTestButton")
    page.wait_for_timeout(150)
    ok("invalid gist shows error", "правильный id" in (page.text_content("#authSyncError") or "").lower(), repr(page.text_content("#authSyncError")))

    # No token + public checkbox unchecked → save refused with explanation.
    page.fill("#authSyncGist", GIST_ID)
    page.check("#authSyncPublic")  # read-only public mode
    page.click("#authSyncSaveButton")
    page.wait_for_timeout(2500)
    status = page.text_content("#authSyncStatus") or ""
    ok("save succeeded (public, no token)", "Подключение сохранено" in status, repr(status))

    # Journal must already be loaded from the cloud while still on the login screen.
    students = page.evaluate("JSON.parse(localStorage.getItem('attendance_diary_data')||'{}').students||[]")
    ok("journal pulled before login", any(s.get("name") == "Иван Петров" for s in students), str(students))

    # Sync settings persisted under the regular config key.
    cfg = page.evaluate("JSON.parse(localStorage.getItem('attendance_sync_config')||'{}')")
    ok("sync config saved", cfg.get("enabled") and cfg.get("gistId") == GIST_ID, str(cfg))

    # Close button hides the window and restores the opener.
    page.click("#authSyncCloseButton")
    page.wait_for_timeout(100)
    ok("sync panel closed", page.evaluate("document.getElementById('authSyncPanel').hidden"))
    ok("opener restored", page.is_visible("#authSyncOpenButton"))

    ok("no page errors", not errors, str(errors[:3]))
    browser.close()

srv.shutdown()
failed = [n for n, c in results if not c]
print("\nRESULT:", "ALL PASS" if not failed else f"FAILED: {failed}")
exit(1 if failed else 0)

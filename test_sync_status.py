#!/usr/bin/env python3
"""E2E test for the sync status badge: mocks the GitHub gist API and verifies
the status text transitions correctly through every state."""
import asyncio, json, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.async_api import async_playwright

STATE = {"files": {}, "public": True}  # gist files as name -> content

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match")
        self.send_header("Access-Control-Expose-Headers", "ETag")
        self.send_header("Access-Control-Allow-Methods", "GET, PATCH, POST, OPTIONS")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        if self.path == "/api/gists":
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length)) if length else {}
            STATE["files"] = {k: v.get("content", "") for k, v in (payload.get("files") or {}).items()}
            body = json.dumps({"id": GIST_ID, "public": True, "files": {k: {"content": v, "truncated": False} for k, v in STATE["files"].items()}}).encode()
            self.send_response(201); self._cors(); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(body); return
        self.send_response(404); self._cors(); self.end_headers()
    def do_GET(self):
        m = re.match(r"^/api/gists/([a-f0-9]+)$", self.path)
        if m:
            auth = self.headers.get("Authorization") or ""
            if "Bearer " not in auth:
                self.send_response(401); self._cors(); self.end_headers()
                self.wfile.write(b'{"message":"Bad credentials"}'); return
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
    def do_PATCH(self):
        m = re.match(r"^/api/gists/([a-f0-9]+)$", self.path)
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length)) if length else {}
        if not m or "Bearer " not in (self.headers.get("Authorization") or ""):
            self.send_response(401); self._cors(); self.end_headers(); return
        for k, v in (payload.get("files") or {}).items():
            STATE["files"][k] = v.get("content", "")
        self.send_response(200); self._cors(); self.end_headers()
        self.wfile.write(b"{}")

GIST_ID = "abc123def456"
srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
GIST_URL = f"http://127.0.0.1:{PORT}"

async def main():
    results = []
    def ok(name, cond, extra=""):
        results.append((name, bool(cond), extra))
        print(f"{'PASS' if cond else 'FAIL'}: {name} {extra}")

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context()
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # Serve the mock gist API and respond to github.com requests locally
        async def handle_fulfill(route):
            url = route.request.url
            if "api.github.com" in url:
                path = "/api" + url.split("api.github.com")[1]
            elif "/raw/" in url:
                path = "/raw/" + url.rsplit("/raw/", 1)[1]
            elif "gist.github.com" in url:
                path = "/gistpage"
            else:
                await route.abort(); return
            target = f"{GIST_URL}{path}"
            import urllib.request, urllib.error
            try:
                data = route.request.post_data
                req = urllib.request.Request(target, data=(data.encode() if data else None), method=route.request.method)
                for k in ("Authorization", "Content-Type"):
                    v = route.request.headers.get(k)
                    if v: req.add_header(k, v)
                with urllib.request.urlopen(req, timeout=10) as resp:
                    body = resp.read()
                    headers = {k.lower(): v for k, v in resp.getheaders()}
                    headers["access-control-allow-origin"] = "*"
                    await route.fulfill(status=resp.status, body=body, headers=headers)
            except urllib.error.HTTPError as e:
                hs = {k.lower(): v for k, v in e.headers.items()}
                hs["access-control-allow-origin"] = "*"
                await route.fulfill(status=e.code, body=e.read(), headers=hs)
            except Exception:
                await route.abort()
        await page.route(re.compile(r"https://api\.github\.com/.*"), handle_fulfill)
        await page.route(re.compile(r"https://gist\.githubusercontent\.com/.*"), handle_fulfill)
        await page.route(re.compile(r"https://gist\.github\.com/.*"), handle_fulfill)
        await page.goto("file:///workspace/index.html")
        await page.wait_for_timeout(800)

        txt = lambda: page.text_content("#syncStatusText")
        cls = lambda: page.get_attribute("#syncStatus", "class")

        # 1. Initial state: not configured
        ok("initial badge 'На этом устройстве'", (await txt()).strip() == "На этом устройстве", repr(await txt()))

        # 2. Make an edit -> pending changes appear even without sync
        await page.evaluate("""() => {
            const s = document.getElementById('studentName');
            s.value = 'Проверка статуса';
            document.getElementById('addStudentButton').click();
        }""")
        await page.wait_for_timeout(500)
        ok("still local-only after edit (no connection)", "На этом устройстве" in (await txt()), repr(await txt()))

        # 3. Save connection WITH token -> should sync and show 'Синхр.'
        await page.evaluate("document.querySelector('.sync-panel').open = true")
        await page.click("#toggleSyncConfigButton")
        await page.fill("#githubToken", "test-token")
        await page.fill("#gistId", "abc123def456")
        await page.check("#gistPublicCheckbox")
        await page.click("#saveSyncConfigButton")
        await page.wait_for_timeout(2500)
        t = await txt()
        ok("after connect+token shows synced time", t.startswith("Синхр."), repr(t))
        ok("badge class is on", "on" in (await cls()) or "busy" in (await cls()), await cls())

        # 4. Local edit -> 'Изменения ждут отправки' then auto-sync back to 'Синхр.'
        await page.evaluate("""() => {
            const s = document.getElementById('studentName');
            s.value = 'Вторая проверка';
            document.getElementById('addStudentButton').click();
        }""")
        await page.wait_for_timeout(300)
        t1 = await txt()
        ok("pending badge right after edit", "ждут отправки" in t1 or "Есть изменения" in t1, repr(t1))
        await page.wait_for_timeout(4000)
        t2 = await txt()
        ok("returns to 'Синхр.' after autosync", t2.startswith("Синхр."), repr(t2))
        # verify data actually reached the mock gist
        ok("data uploaded to gist", any("Вторая проверка" in v for v in STATE["files"].values()), str(list(STATE["files"])))

        # 5. Manual 'Синхронизировать сейчас' -> busy visible at least logically; final ok
        await page.evaluate("fullSync('manual')")
        await page.wait_for_timeout(2000)
        ok("manual sync ends synced", (await txt()).startswith("Синхр."), repr(await txt()))

        # 6. Go offline -> paused badge with network message
        await context.set_offline(True)
        await page.evaluate("updateSyncUI()")
        t = await txt()
        ok("offline shows 'Нет сети'", "Нет сети" in t, repr(t))
        ok("offline badge paused", "paused" in (await cls()), await cls())
        await context.set_offline(False)
        await page.evaluate("updateSyncUI()")

        # 7. Reconnect read-only (no token, public gist) -> honest status
        await page.evaluate("document.querySelector('.sync-panel').open = true")
        await page.click("#toggleSyncConfigButton")
        await page.fill("#githubToken", "")
        await page.fill("#gistId", "abc123def456")
        await page.check("#gistPublicCheckbox")
        await page.click("#saveSyncConfigButton")
        await page.wait_for_timeout(2500)
        t = await txt()
        ok("read-only shows public-gist status, not 'сохранено локально'",
          ("Публичный Gist" in t) and ("локально" not in t.lower()), repr(t))

        # 8. Disable sync -> back to local badge
        await page.click("#disableSyncButton")
        await page.wait_for_timeout(300)
        ok("disabled -> 'На этом устройстве'", (await txt()).strip() == "На этом устройстве", repr(await txt()))

        ok("no page JS errors", not errors, "; ".join(errors[:3]))
        await browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results)-len(failed)}/{len(results)} checks passed")
    raise SystemExit(1 if failed else 0)

asyncio.run(main())

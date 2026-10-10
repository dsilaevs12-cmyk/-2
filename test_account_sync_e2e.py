#!/usr/bin/env python3
"""Cross-device account sync E2E: device A registers an account and pushes it
to a mocked Gist; device B (fresh browser context = fresh localStorage) opens
the app, connects via the login-screen sync window and logs in with the same
password AND secret-word 2FA."""
import json, re, threading, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

GIST_ID = "abc123def456"
STATE = {"files": {}, "public": True}

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
            self.send_response(200); self._cors(); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(body); return
        m = re.match(r"^/raw/([^/]+)$", self.path)
        if m:
            from urllib.parse import unquote
            name = unquote(m.group(1))
            if name in STATE["files"]:
                self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(STATE["files"][name].encode()); return
            self.send_response(404); self._cors(); self.end_headers(); return
        if self.path.startswith("/gistpage"):
            links = "".join(f'<a href="/owner/{GIST_ID}/raw/{n}">{n}</a>' for n in STATE["files"])
            self.send_response(200); self._cors(); self.send_header("Content-Type", "text/html"); self.end_headers()
            self.wfile.write(f"<html>{links}</html>".encode()); return
        self.send_response(404); self._cors(); self.end_headers()
    def do_PATCH(self):
        m = re.match(r"^/api/gists/([a-f0-9]+)$", self.path)
        if not m:
            self.send_response(404); self._cors(); self.end_headers(); return
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length))
        for name, f in (payload.get("files") or {}).items():
            if f.get("content") is None: STATE["files"].pop(name, None)
            else: STATE["files"][name] = f["content"]
        body = json.dumps({"id": m.group(1)}).encode()
        self.send_response(200); self._cors(); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(body)

srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
GIST_URL = f"http://127.0.0.1:{PORT}"

results = []
def ok(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}: {name} {extra}")

def route_handler(route):
    url = route.request.url
    if "api.github.com" in url: path = "/api" + url.split("api.github.com")[1]
    elif "/raw/" in url: path = "/raw/" + url.rsplit("/raw/", 1)[1]
    elif "gist.github.com" in url: path = "/gistpage"
    else: route.abort(); return
    try:
        data = route.request.post_data
        req = urllib.request.Request(GIST_URL + path, data=(data.encode() if data else None), method=route.request.method)
        with urllib.request.urlopen(req, timeout=10) as resp:
            headers = {k.lower(): v for k, v in resp.getheaders()}
            headers["access-control-allow-origin"] = "*"
            route.fulfill(status=resp.status, body=resp.read(), headers=headers)
    except Exception:
        route.abort()

NAME = "Осень тест"
PASSWORD = "password123"
SECRET = "тыкква"

browser = None
with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---------- Device A: register + enroll secret word ----------
    ctxA = browser.new_context()
    pageA = ctxA.new_page()
    errsA = []; pageA.on("pageerror", lambda e: errsA.append(str(e)))
    pageA.route(re.compile(r"https://(api\.github\.com|gist\.githubusercontent\.com|gist\.github\.com)/.*"), route_handler)
    pageA.goto("file:///workspace/index.html")
    pageA.wait_for_timeout(600)

    # Register on tab "register"
    pageA.click("#authTabRegister")
    pageA.fill("#authRegLast", "Осень"); pageA.fill("#authRegFirst", "тест")
    pageA.fill("#authRegPass1", PASSWORD); pageA.fill("#authRegPass2", PASSWORD)
    pageA.click("#authRegisterSubmit")
    pageA.wait_for_timeout(4000)  # PBKDF2 150k iterations
    ok("A registered & logged in", pageA.evaluate("document.getElementById('authGate').hidden"), str(errsA[:2]))

    # Connect sync WITH token so accounts get pushed to the gist
    pageA.evaluate("""() => {
      document.getElementById('syncToken') && (document.getElementById('syncToken').value='');
    }""")
    # Use the settings panel sync fields if present; simpler: write config directly and call push
    pushed = pageA.evaluate("""async () => {
      // simulate saving sync config the way the settings UI does
      syncConfig.token = 'tok-test'; syncConfig.gistId = '%s'; syncConfig.enabled = true; syncConfig.isPublicGist = true;
      saveSyncConfig();
      const r = await syncAccountsOnce({});
      return r;
    }""" % GIST_ID)
    ok("A pushed accounts to gist", isinstance(pushed, dict) and pushed.get("uploaded"), str(pushed))
    acct_files = [k for k in STATE["files"] if k.startswith("accounts.device.")]
    ok("gist has accounts file", len(acct_files) >= 1, str(list(STATE["files"].keys())))

    # Enroll secret word deterministically via the REAL handleAuthLogin
    # (headless radio-click interaction is flaky, so drive the handler directly).
    # Each login step runs in its own evaluate(): assigning .value fires the
    # page's "input" listener which CLEARS #authLoginError, so the wrong-secret
    # message must be read before the next value assignment.
    pageA.evaluate("""async () => {
      clearAuthSession();
      document.getElementById('authGate').hidden = false;
      const acc = loadAuthAccounts()[0];
      window.__rightHash = await authDerive('%s', acc.salt);
      window.__wrongHash = await authDerive('не-то-слово', acc.salt);
      document.querySelector('input[name="auth2faMethod"][value="secret"]').checked = true;
      updateAuth2faStep();
      document.getElementById('authLoginName').value = acc.fullName;
      document.getElementById('authLoginPass').value = '%s';
      await handleAuthLogin({ preventDefault(){} });   // step 1 -> pending 2fa
    }""" % (SECRET, PASSWORD))
    ok("A password accepted, moved to 2FA step",
       pageA.evaluate("Boolean(authGateState.pending && authGateState.pending.step === '2fa')"))
    # Helper: fill the secret field via JS (the radio input is visually hidden
    # by CSS, so Playwright's actionability checks on it are unreliable), then
    # submit and wait for the PBKDF2 derivation to finish.
    def try_secret(page, word):
        page.evaluate("(w) => { document.getElementById('authSecretWord').value = w; }", word)
        page.evaluate("handleAuthLogin({ preventDefault(){} })")
        page.wait_for_function("document.getElementById('authGate').hidden || document.getElementById('authLoginError').textContent.length > 0", timeout=60000)

    try_secret(pageA, "не-то-слово")
    wrong_err = pageA.text_content("#authLoginError") or ""
    still_gated = not pageA.evaluate("document.getElementById('authGate').hidden")
    ok("A rejects WRONG secret word", still_gated and "секретн" in wrong_err.lower(), repr(wrong_err))
    try_secret(pageA, SECRET)
    enrolled = pageA.evaluate("""(() => {
      const acc = loadAuthAccounts()[0];
      return {
        loggedIn: document.getElementById('authGate').hidden,
        localHasSecretHash: Boolean(acc.secretHash),
        hashMatches: acc.secretHash === window.__rightHash,
        wrongDiffers: window.__wrongHash !== window.__rightHash
      };
    })()""")
    ok("A logged in with correct secret (real handler)", enrolled.get("loggedIn") and enrolled.get("wrongDiffers"), str(enrolled))
    ok("A stored matching secretHash locally after login", enrolled.get("localHasSecretHash") and enrolled.get("hashMatches"), str(enrolled))
    # Push updated list (now includes secretHash)
    pushed2 = pageA.evaluate("""async () => await syncAccountsOnce({})""")
    ok("A re-pushed with secret hash", isinstance(pushed2, dict))
    content = None
    for k in STATE["files"]:
        if k.startswith("accounts.device."):
            content = json.loads(STATE["files"][k])
    hashes = [a.get("secretHash") for a in content.get("accounts", [])] if content else []
    ok("secretHash present in gist payload", any(hashes), str(hashes)[:80])
    ctxA.close()

    # ---------- Device B: fresh storage, connect via login-window, login ----------
    ctxB = browser.new_context()
    pageB = ctxB.new_page()
    errsB = []; pageB.on("pageerror", lambda e: errsB.append(str(e)))
    pageB.route(re.compile(r"https://(api\.github\.com|gist\.githubusercontent\.com|gist\.github\.com)/.*"), route_handler)
    pageB.goto("file:///workspace/index.html")
    pageB.wait_for_timeout(600)
    ok("B gate open (fresh device)", not pageB.evaluate("document.getElementById('authGate').hidden"))

    pageB.click("#authSyncOpenButton")
    pageB.fill("#authSyncGist", GIST_ID)
    pageB.fill("#authSyncToken", "tok-test")   # writable mode: reads via api.github.com (mocked)
    pageB.click("#authSyncSaveButton")
    pageB.wait_for_timeout(6000)
    status = pageB.text_content("#authSyncStatus") or ""
    ok("B pulled account from gist", "аккаунт" in status.lower(), repr(status))

    pageB.evaluate("""() => {
      const acc = loadAuthAccounts()[0];
      window.__accName = acc.fullName;
      document.querySelector('input[name="auth2faMethod"][value="secret"]').checked = true;
      updateAuth2faStep();
      document.getElementById('authLoginName').value = acc.fullName;
      document.getElementById('authLoginPass').value = '%s';
      return handleAuthLogin({ preventDefault(){} });   // password step
    }""" % PASSWORD)
    pageB.wait_for_timeout(3500)
    ok("B password accepted via synced hash",
       pageB.evaluate("Boolean(authGateState.pending && authGateState.pending.step === '2fa')"))
    secret_hash_on_b = pageB.evaluate("(() => { const a = loadAuthAccounts().find(x => x.fullName === window.__accName) || {}; return a.secretHash || ''; })()")
    ok("B received secretHash via sync", bool(secret_hash_on_b), str(secret_hash_on_b)[:40])

    try_secret(pageB, "не-то-слово")
    wrong_err_b = pageB.text_content("#authLoginError") or ""
    still_gated_b = not pageB.evaluate("document.getElementById('authGate').hidden")
    ok("B rejects WRONG secret word", still_gated_b and "секретн" in wrong_err_b.lower(), repr(wrong_err_b))

    try_secret(pageB, SECRET)
    logged_in_b = pageB.evaluate("document.getElementById('authGate').hidden")
    err_b = pageB.text_content("#authLoginError") or ""
    ok("B logged in with SAME password+secret on a scratch device", logged_in_b, f"err={err_b!r} errs={errsB[:2]}")
    ctxB.close()
    browser.close()

srv.shutdown()
failed = [n for n, c in results if not c]
print("\nRESULT:", "ALL PASS" if not failed else f"FAILED: {failed}")
exit(1 if failed else 0)

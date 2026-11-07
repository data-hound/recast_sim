"""End-to-end UI test: headless Chrome drives the real page through the DevTools protocol.

    python tests/e2e_chrome.py --url http://127.0.0.1:8765/ --shots OUTDIR [--games tissue,clue,duel,workup,quiz]

Plays: consent -> signup (pre-med) -> placement -> each game (tutorial + play items) -> profile, league, dashboard.
Fails on any JS exception or console error, or any request to a host other than the server. Needs websocket-client.
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

import websocket

ANSWER_ONE = r"""
(function(){
 var m=document.getElementById('modal');
 if(!m.hidden){ var ab=m.querySelector('#abA'); if(ab){ab.click(); return 'ab';}
   var t=m.querySelector('#t'); if(t){t.click(); return 'tutorial';}
   var c=Array.from(m.querySelectorAll('button')).find(function(b){return /Close|play/i.test(b.textContent)}); if(c){c.click(); return 'close';} }
 var btns=Array.from(document.querySelectorAll('main button'));
 var next=btns.find(function(b){return b.textContent.indexOf('Next')===0||b.textContent.indexOf('Let')===0}); if(next){next.click(); return 'next';}
 var sb=btns.find(function(b){return b.textContent==='Shift board'}); if(sb && /Shift complete/.test(document.body.textContent)){sb.click(); return 'shift_done';}
 var tests=document.querySelector('.tests');
 if(tests){ var free=Array.from(tests.querySelectorAll('button')).filter(function(x){return !x.disabled});
   if(free.length){ free[Math.floor(Math.random()*free.length)].click(); return 'order';}
   var r=btns.find(function(b){return b.textContent==='Refer'}); if(r){r.click(); return 'refer';} }
 var opts=Array.from(document.querySelectorAll('.opts button')).filter(function(b){return !b.classList.contains('gone')});
 var sub=btns.find(function(b){return b.textContent==='Submit'});
 if(opts.length && sub){ if(sub.disabled){ opts[Math.floor(Math.random()*opts.length)].click(); } sub.click(); return 'submit';}
 return 'none';
})()
"""


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True); self.i = 0; self.events = []

    def call(self, method, **params):
        self.i += 1; mid = self.i
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            self.events.append(msg)

    def ev(self, js):
        r = self.call("Runtime.evaluate", expression=js, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            raise RuntimeError(f"eval failed: {r['exceptionDetails']}")
        return r["result"].get("value")

    def drain(self, secs=0.3):
        end = time.time() + secs; self.ws.settimeout(0.05)
        while time.time() < end:
            try:
                self.events.append(json.loads(self.ws.recv()))
            except Exception:
                pass
        self.ws.settimeout(30)

    def shot(self, path):
        d = self.call("Page.captureScreenshot", format="png")["data"]
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(d))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--url", required=True); ap.add_argument("--shots", required=True)
    ap.add_argument("--games", default="tissue,quiz,workup,clue,duel"); ap.add_argument("--actions", type=int, default=30)
    ap.add_argument("--port", type=int, default=9333); ap.add_argument("--bg", default="premed"); ap.add_argument("--pools", default="")
    a = ap.parse_args(); os.makedirs(a.shots, exist_ok=True)
    prof = tempfile.mkdtemp(prefix="arcade_chrome_")
    chrome = subprocess.Popen(["google-chrome", "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                               f"--user-data-dir={prof}", f"--remote-debugging-port={a.port}", f"--remote-allow-origins=http://127.0.0.1:{a.port}", "--window-size=1100,1300", "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{a.port}/json").read()); break
            except Exception:
                time.sleep(0.2)
        page = [t for t in tabs if t["type"] == "page"][0]
        c = CDP(page["webSocketDebuggerUrl"])
        for d in ("Page", "Runtime", "Network", "Log"):
            c.call(d + ".enable")
        c.call("Page.navigate", url=a.url); time.sleep(1.5)
        host = urlparse(a.url).netloc
        c.ev("document.getElementById('ok').click()"); c.ev("document.getElementById('go').click()"); time.sleep(0.4)
        c.shot(f"{a.shots}/01_signup.png")
        c.ev("document.getElementById('h').value='e2e-tester'; document.getElementById('bg').value='" + a.bg + "'; document.getElementById('site').value='Duke'; document.getElementById('go').click()")
        time.sleep(0.8); c.shot(f"{a.shots}/02_placement.png")
        for _ in range(20):
            r = c.ev(ANSWER_ONE); time.sleep(0.35)
            if c.ev("!!document.querySelector('h1') && /You\\u2019re a|Choose a game/.test(document.querySelector('h1').textContent)"):
                break
        c.shot(f"{a.shots}/03_tier.png"); c.ev(ANSWER_ONE); time.sleep(0.5)
        c.shot(f"{a.shots}/04_home.png")
        if a.pools:
            r = c.ev("fetch('/api/prefs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({player_id:localStorage.getItem('arcade_pid'),pools:%s})}).then(function(r){return r.json()})" % json.dumps(a.pools.split(",")))
            print("prefs:", r)
        counts = {}
        for g in a.games.split(","):
            c.ev("document.querySelector('nav button[data-v=home]').click()"); time.sleep(0.4)
            if g in ("workup", "daily"):
                label = "Free play" if g == "workup" else "\u25B6 Today"
                ok = c.ev(f"(function(){{var b=Array.from(document.querySelectorAll('main button')).find(function(x){{return x.textContent.indexOf({json.dumps(label)})===0}}); if(b){{b.click(); return true}} return false}})()")
                if not ok:
                    print(f"{g}: button not found"); continue
                time.sleep(0.6)
            else:
                idx = c.ev(f"Array.from(document.querySelectorAll('.game .t')).findIndex(function(t){{return t.textContent.indexOf({json.dumps({'tissue':'Tissue','quiz':'Concept','clue':'Clue','duel':'Report'}[g])})===0}})")
                if idx is None or idx < 0:
                    print(f"{g}: card not found (locked or missing)"); continue
                c.ev(f"document.querySelectorAll('.game')[{idx}].click()"); time.sleep(0.5)
            c.shot(f"{a.shots}/10_{g}_intro.png")
            seen = {}
            for k in range(a.actions):
                r = c.ev(ANSWER_ONE); seen[r] = seen.get(r, 0) + 1; time.sleep(0.3)
                if k == 3 and g in ("workup", "daily"):
                    c.ev("(function(){var b=Array.from(document.querySelectorAll('main button')).find(function(x){return x.textContent.indexOf('\\uD83E\\uDD16')===0}); if(b) b.click();})()")
                if k == 6:
                    c.shot(f"{a.shots}/11_{g}_play.png")
            c.shot(f"{a.shots}/12_{g}_end.png"); counts[g] = seen
        c.ev("document.querySelector('nav button[data-v=home]').click()"); time.sleep(0.5)
        c.ev("(function(){var a=document.getElementById('cred'); if(a) a.click();})()"); time.sleep(0.7); c.shot(f"{a.shots}/19_credits.png")
        for v in ("profile", "league", "dash"):
            c.ev(f"document.querySelector('nav button[data-v={v}]').click()"); time.sleep(0.7); c.shot(f"{a.shots}/20_{v}.png")
        c.drain(1.0)
        errors = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
        cons = [e for e in c.events if e.get("method") == "Log.entryAdded" and e["params"]["entry"]["level"] == "error"]
        reqs = [e["params"]["request"]["url"] for e in c.events if e.get("method") == "Network.requestWillBeSent"]
        foreign = [u for u in reqs if urlparse(u).netloc not in (host, "") and not u.startswith("data:")]
        api = [u for u in reqs if "/api/" in u]
        print(json.dumps({"actions": counts, "js_exceptions": len(errors), "console_errors": [x["params"]["entry"]["text"][:160] for x in cons],
                          "requests": len(reqs), "api_calls": len(api), "foreign_requests": foreign}, indent=1))
        for e in errors[:5]:
            print("EXC", json.dumps(e["params"]["exceptionDetails"])[:600])
        ok = not errors and not cons and not foreign
        print("E2E", "PASS" if ok else "FAIL")
        sys.exit(0 if ok else 1)
    finally:
        chrome.terminate(); shutil.rmtree(prof, ignore_errors=True)


if __name__ == "__main__":
    main()

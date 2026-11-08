"""End-to-end test of the hospital simulation + Daily Workup page (web/hospital/) in headless Chrome. Needs websocket-client.

    python tests/e2e_hospital.py --url http://127.0.0.1:8770/hospital/ --shots OUTDIR
    python tests/e2e_hospital.py --url http://127.0.0.1:8771/ --shots OUTDIR --informer-build   # the built Informer app (dist/)

The page is the single entry of the Informer App: a sign-in form (demo email accounts), then tabs for the worklist with
the GlioAgent assistant, the clinician tool, Practice (Daily Workup, external cohorts only) and the steward dashboard.

Uses ?speed=2 (2 real seconds per simulated day) and a fixed arrival seed. Checks: demo sign-in, worklist, a full case
workup following the assistant (order, advance the clock, sign out), the debrief, persistence across reload, the
resource-limited hospital's unavailable 1p/19q and send-out labels, the steward dashboard, and one Daily Workup game
played in the planner's order (must score exactly Par unless the planner itself goes out of bounds via the surrogate).
Fails on any JS exception or console error, any /api request, or any request to another host. With --informer-build the
team log's /api/_server/caselog requests are allowed (they 404 off Informer) and their console errors are ignored.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

from e2e_chrome import CDP

CASE_STATE = r"""
(function(){
  var s=document.getElementById('supported'), g=document.getElementById('sug');
  return {sup: s ? +s.getAttribute('data-cls') : null, sug: g ? g.getAttribute('data-t') : null,
          nos: !!(g && g.getAttribute('data-nos')), debrief: !!document.getElementById('debrief'),
          pending: document.querySelectorAll('#hresults .pend').length};
})()
"""

PRACTICE_STEP = r"""
(function(){
  var E=ClinicEngine, p=window.__HOSP.practice(); if(!p) return 'noprac'; if(p.done) return 'done';
  var M=window.__HOSP.model, cfg=E.cfgOf({r:3}), w=E.posterior(p.prior,M.L,p.o), d=E.dpChoose(w,p.o,p.g4,M.L,cfg);
  if(d.j==null){ var n=document.querySelector('[data-act=dw-nos]'); if(n){n.click(); return 'nos';} return 'stuck'; }
  var b=document.querySelector('[data-act=dw-order][data-t='+E.TESTS[d.j]+']'); if(!b||b.disabled) return 'nobtn';
  b.click(); return 'order:'+E.TESTS[d.j];
})()
"""


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--url", required=True); ap.add_argument("--shots", required=True)
    ap.add_argument("--port", type=int, default=9341); ap.add_argument("--informer-build", action="store_true")
    a = ap.parse_args(); os.makedirs(a.shots, exist_ok=True)
    url = a.url + ("&" if "?" in a.url else "?") + "speed=2&seed=e2e"
    prof = tempfile.mkdtemp(prefix="hosp_chrome_")
    chrome = subprocess.Popen(["google-chrome", "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                               f"--user-data-dir={prof}", f"--remote-debugging-port={a.port}", f"--remote-allow-origins=http://127.0.0.1:{a.port}",
                               "--window-size=1280,800", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = []

    def expect(name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
        if not ok:
            fails.append(name)

    try:
        for _ in range(50):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{a.port}/json").read()); break
            except Exception:
                time.sleep(0.2)
        c = CDP([t for t in tabs if t["type"] == "page"][0]["webSocketDebuggerUrl"])
        for d in ("Page", "Runtime", "Network", "Log"):
            c.call(d + ".enable")
        c.call("Emulation.setDeviceMetricsOverride", width=1280, height=800, deviceScaleFactor=1, mobile=False)

        def click(sel):
            return c.ev(f"(function(){{var e=document.querySelector({json.dumps(sel)}); if(!e||e.disabled) return false; e.click(); return true;}})()")

        def text(sel):
            return c.ev(f"(function(){{var e=document.querySelector({json.dumps(sel)}); return e ? e.textContent : null;}})()")

        EMAIL = {"clin.lakeside": "dummy_clinician@lakeside-general.example", "clin.valley": "dummy_clinician@valley-community.example",
                 "steward.lakeside": "dummy_steward@lakeside-general.example", "judge": "judge@glioagent-demo.example"}

        def login(email, pw):
            c.ev("(function(){document.getElementById('loginEmail').value=%s;document.getElementById('loginPass').value=%s;})()" % (json.dumps(email), json.dumps(pw)))
            click("#loginBtn"); time.sleep(0.5)

        def signin(uid):
            click("#logout"); time.sleep(0.2)
            if not c.ev("!!document.getElementById('loginForm')"):
                return False
            login(EMAIL[uid], "demo"); return bool(c.ev("!!document.getElementById('tabs') && !document.getElementById('tabs').hidden"))

        c.call("Page.navigate", url=url); time.sleep(1.5); c.drain(0.3)
        c.shot(f"{a.shots}/h0_signin.png")
        v0 = text("#view") or ""
        expect("opens on the sign-in page with a form and 7 demo accounts", "Sign in · GlioAgent Workup" in v0 and
               c.ev("document.querySelectorAll('[data-act=fill]').length") == 7, v0[:120])
        expect("clinician tool hidden before sign-in", c.ev("document.getElementById('toolPane').hidden") is True)
        login(EMAIL["clin.lakeside"], "wrong")
        expect("wrong password rejected", "Wrong password" in (text("#loginErr") or "") and c.ev("document.getElementById('tabs').hidden") is True)
        login("nobody@lakeside-general.example", "demo")
        expect("unknown email rejected", "No demo account" in (text("#loginErr") or ""))
        click("[data-act=fill][data-u='dummy_clinician@riverbend-university.example']")
        expect("clicking a demo account fills the email", c.ev("document.getElementById('loginEmail').value") == "dummy_clinician@riverbend-university.example")
        expect("sign in as clin.lakeside", signin("clin.lakeside"))
        n_rows = c.ev("document.querySelectorAll('#worklist tr.wrow').length")
        expect("worklist shows >= 3 cases", (n_rows or 0) >= 3, str(n_rows))
        clock = text("#hclock") or ""
        expect("header shows the simulated clock", clock.startswith("Day "), clock)
        expect("header shows the hospital name", "Lakeside General Hospital" in (text("#hname") or ""))
        c.shot(f"{a.shots}/h1_worklist.png")

        # --- clinician tool tab (same page, same sign-in)
        expect("clinician tool tab opens", click("#tab_tool")); time.sleep(0.3)
        expect("tool tab: tool shown, worklist hidden", c.ev("document.getElementById('toolPane').hidden") is False and c.ev("document.getElementById('view').hidden") is True)
        click("#examples button"); time.sleep(0.3)
        expect("tool tab: an example case gives probabilities and a next step", len(text("#postCard") or "") > 20 and len(text("#nextCard") or "") > 20)
        c.shot(f"{a.shots}/h1b_tool.png")
        click("#tab_work"); time.sleep(0.3)
        expect("back to worklist", c.ev("document.getElementById('toolPane').hidden") is True and (c.ev("document.querySelectorAll('#worklist tr.wrow').length") or 0) >= 3)

        # --- one full case following the assistant
        click("#worklist tr.wrow"); time.sleep(0.4)
        c.shot(f"{a.shots}/h2_case_open.png")
        ordered_suggested, steps, nexts, signed = 0, [], 0, None
        for _ in range(40):
            st = c.ev(CASE_STATE)
            if st["debrief"]:
                break
            if st["sup"] is not None and st["sup"] >= 0:
                click(f"#signBtns button[data-cls='{st['sup']}']"); signed = st["sup"]; steps.append("signout"); time.sleep(0.4); continue
            if st["nos"]:
                click("#signBtns button[data-cls='-1']"); signed = -1; steps.append("nos"); time.sleep(0.4); continue
            if st["sug"]:
                if click(f"#testBtns button[data-t='{st['sug']}']"):
                    ordered_suggested += 1; steps.append("order:" + st["sug"])
                    if ordered_suggested == 1:
                        time.sleep(0.2); c.shot(f"{a.shots}/h3_case_pending.png")
                time.sleep(0.3); continue
            click("#nextBtn"); nexts += 1; steps.append("next"); time.sleep(0.3)
        print("case steps:", steps)
        expect("ordered at least one suggested test", ordered_suggested >= 1)
        expect("used ⏩ Next result", nexts >= 1 or ordered_suggested == 0)
        st = c.ev(CASE_STATE)
        expect("case signed out (class or NOS)", st["debrief"] and signed is not None)
        db = text("#debrief") or ""
        expect("debrief shows the true class", "True class:" in db and len(text("#trueCls") or "") > 5, db[:200])
        expect("debrief compares with planner and CAP pathway", "Planner" in (text("#compare") or "") and "CAP pathway" in (text("#compare") or ""))
        expect("debrief records orders vs assistant", "matched" in db)
        c.shot(f"{a.shots}/h4_debrief.png")

        # --- reload keeps the simulation (sessionStorage)
        c.call("Page.reload"); time.sleep(1.5)
        expect("reload keeps the signed-out case", bool(c.ev("!!document.getElementById('debrief')")))
        click("[data-act=back]"); time.sleep(0.3)
        expect("worklist marks the case signed out", "signed out" in (text("#worklist") or ""))

        # --- steward dashboard
        expect("sign in as steward.lakeside", signin("steward.lakeside"))
        expect("steward sees the dashboard tab", click("#tab_dash")); time.sleep(0.4)
        kn = text("#k_n .v") or "0"
        expect("dashboard shows >= 1 signed-out case", kn.isdigit() and int(kn) >= 1, kn)
        expect("dashboard says it is this session only", "this browser tab's simulated session only" in (text("#dash") or ""))
        c.shot(f"{a.shots}/h5_dashboard.png")

        # --- judge can switch hospital
        expect("sign in as judge", signin("judge"))
        c.ev("(function(){var s=document.getElementById('hsel'); s.value='valley'; s.dispatchEvent(new Event('change',{bubbles:true}));})()"); time.sleep(0.4)
        expect("judge: hospital switch to Valley", "Valley Community Hospital" in (text("#view h2") or ""), text("#view h2"))
        expect("judge: dashboard tab present", bool(c.ev("!!document.getElementById('tab_dash')")))
        c.shot(f"{a.shots}/h5b_judge.png")

        # --- resource-limited hospital
        expect("sign in as clin.valley", signin("clin.valley"))
        expect("clinician has no dashboard tab", not c.ev("!!document.getElementById('tab_dash')"))
        click("#worklist tr.wrow"); time.sleep(0.4)
        codel = c.ev("(function(){var b=document.querySelector('#testBtns button[data-t=codel]'); return b ? {d: b.disabled, t: b.textContent} : null;})()")
        expect("valley: 1p/19q button disabled and 'not available'", codel and codel["d"] and "not available" in codel["t"], str(codel))
        seq = text("#testBtns button[data-t=seq]") or ""
        expect("valley: molecular test shows send-out", "send-out" in seq, seq)
        c.shot(f"{a.shots}/h6_valley.png")

        # --- Daily Workup
        expect("practice tab opens", click("#tab_practice")); time.sleep(0.4)
        c.shot(f"{a.shots}/h7_practice_start.png")
        src = c.ev("(function(){var x=new XMLHttpRequest();x.open('GET',document.body.getAttribute('data-cases'),false);x.send();var D=JSON.parse(x.responseText),"
                   "id=window.__HOSP.practice().id,inP=D.practice.some(function(c){return c.id===id;}),"
                   "inH=D.hospitals.some(function(h){return h.cases.some(function(c){return c.id===id;});});return {p:inP,h:inH,n:D.practice.length};})()")
        expect("daily case comes from the external practice pool, not a hospital", src and src["p"] and not src["h"] and src["n"] >= 100, str(src))
        moves = []
        for _ in range(12):
            r = c.ev(PRACTICE_STEP); moves.append(r); time.sleep(0.25)
            if r in ("done", "stuck", "nobtn", "noprac"):
                break
        print("practice moves:", moves)
        p = c.ev("window.__HOSP.practice()")
        golf = text("#golf") or ""
        expected = "Out of bounds" if p and p["done"] and p["done"]["wrong"] else "Par"
        expect("daily case closed with a golf label", bool(p and p["done"]) and golf in ("Eagle", "Birdie", "Par", "Bogey", "Double bogey+", "Out of bounds"), golf)
        expect(f"planner's order scores exactly {expected} (cost == par)", golf == expected and p["cost"] == p["par"], f"{golf} cost={p and p['cost']} par={p and p['par']}")
        share = c.ev("(function(){var t=document.getElementById('shareTxt'); return t ? t.value : '';})()") or ""
        expect("share text contains 'Daily Workup'", share.startswith("Daily Workup ") and "Par " in share, share)
        print("share text:", share.replace("\n", " | "))
        click("#copyBtn"); time.sleep(0.3)
        c.shot(f"{a.shots}/h8_practice_done.png")
        c.call("Page.reload"); time.sleep(1.5)
        expect("one attempt per day: result kept after reload", (text("#golf") or "") == golf)
        expect("Practice another case gives an extra case", click("#extraBtn")); time.sleep(0.3)
        expect("extra case labelled not counted", "not counted" in (text("#view") or ""))

        # --- reset simulation
        expect("reset button works", click("#resetBtn")); time.sleep(0.3)
        n3 = c.ev("document.querySelectorAll('#worklist tr.wrow').length"); wl = text("#worklist") or ""
        expect("reset: 3 fresh cases, none signed out, clock at Day 1", n3 == 3 and "signed out" not in wl and (text("#hclock") or "").startswith("Day 1 "),
               f"{n3} {text('#hclock')}")

        # --- storage unavailable (Informer sandboxed iframe without allow-same-origin): getters throw
        c.call("Page.addScriptToEvaluateOnNewDocument", source="['localStorage','sessionStorage'].forEach(function(k){"
               "Object.defineProperty(window,k,{configurable:true,get:function(){throw new DOMException('blocked by test','SecurityError');}});});")
        c.call("Page.navigate", url=url.replace("seed=e2e", "seed=nostore")); time.sleep(1.5)
        blocked = c.ev("(function(){try{window.localStorage;return false;}catch(e){}try{window.sessionStorage;return false;}catch(e){return true;}})()")
        expect("no-storage: storage getters throw in the page", blocked is True)
        expect("no-storage: sign in as clin.lakeside", signin("clin.lakeside"))
        n2 = c.ev("document.querySelectorAll('#worklist tr.wrow').length")
        expect("no-storage: worklist shows >= 3 cases", (n2 or 0) >= 3, str(n2))
        click("#worklist tr.wrow"); time.sleep(0.3)
        sug = c.ev(CASE_STATE)["sug"]
        expect("no-storage: case opens and an order works", bool(sug) and click(f"#testBtns button[data-t='{sug}']") and
               c.ev("document.querySelectorAll('#hresults .pend').length") >= 1)
        expect("no-storage: practice tab opens", click("#tab_practice")); time.sleep(0.3)
        for _ in range(12):
            if c.ev(PRACTICE_STEP) in ("done", "stuck", "nobtn", "noprac"):
                break
            time.sleep(0.2)
        expect("no-storage: daily case completes with a golf label", bool(text("#golf")) and "Daily Workup" in (c.ev("(function(){var t=document.getElementById('shareTxt'); return t ? t.value : '';})()") or ""))
        c.shot(f"{a.shots}/h9_nostorage_practice.png")

        # --- inside Informer: the link's roles (window.__INFORMER__.roles, top level) lock the demo accounts; storage still blocked
        sid = c.call("Page.addScriptToEvaluateOnNewDocument", source="window.__INFORMER__={user:{username:'admin',displayName:'Dr Test <b>x</b>'},roles:['site_valley','steward']};")["identifier"]
        c.call("Page.navigate", url=url.replace("seed=e2e", "seed=informer")); time.sleep(1.5)
        note = text("#informerNote") or ""
        expect("informer: sign-in page notes the Informer user (escaped) and the link's roles", "Dr Test <b>x</b>" in note and "Valley Community Hospital" in note and
               bool(c.ev("!!document.getElementById('loginForm')")), note[:200])
        expect("informer: site role prefills the Valley clinician", c.ev("document.getElementById('loginEmail').value") == "dummy_clinician@valley-community.example")
        nlock = c.ev("document.querySelectorAll('[data-act=fill][disabled]').length")
        expect("informer: 5 accounts locked (4 other clinicians, Lakeside steward, judge -> 6)", nlock == 6, str(nlock))
        login(EMAIL["clin.lakeside"], "demo")
        expect("informer: Lakeside account refused on a Valley link", "does not include Lakeside" in (text("#loginErr") or "") and c.ev("document.getElementById('tabs').hidden") is True)
        login(EMAIL["clin.valley"], "demo")
        expect("informer: signs in to Valley", "Valley Community Hospital" in (text("#hname") or ""))
        expect("informer: label says opened through Informer", "Opened through Informer" in (text("#tabs") or ""))
        c.shot(f"{a.shots}/h10_informer.png")
        c.call("Page.removeScriptToEvaluateOnNewDocument", identifier=sid)
        sid = c.call("Page.addScriptToEvaluateOnNewDocument", source="window.__INFORMER__={user:{username:'admin'},roles:['site_lakeside','site_riverbend','site_harbor','site_northgate','site_valley','steward']};")["identifier"]
        c.call("Page.navigate", url=url.replace("seed=e2e", "seed=informer2")); time.sleep(1.5)
        expect("informer owner (all roles): nothing locked, judge can sign in", c.ev("document.querySelectorAll('[data-act=fill][disabled]').length") == 0 and signin("judge"))
        c.call("Page.removeScriptToEvaluateOnNewDocument", identifier=sid)
        sid = c.call("Page.addScriptToEvaluateOnNewDocument", source="window.__INFORMER__={user:{username:'nosite'},roles:[]};")["identifier"]
        c.call("Page.navigate", url=url.replace("seed=e2e", "seed=informer3")); time.sleep(1.5)
        expect("informer without site role: empty email, all open, judge can sign in", c.ev("document.getElementById('loginEmail').value") == "" and
               c.ev("document.querySelectorAll('[data-act=fill][disabled]').length") == 0 and signin("judge"))
        c.call("Page.removeScriptToEvaluateOnNewDocument", identifier=sid)

        # --- "Ask GlioAgent (Informer AI)": window.__INFORMER__.openChat({prompt, context, instructions}) + two page tools, de-identified
        # Stub: records the openChat call and the registered tools; ipcRenderer stands in for the Informer host (the injected bridge only
        # reaches the chat when a host page answers, so the button is hidden in a top-level tab).
        STUB = ("window.__cap=null;window.__tools={};window.__INFORMER__={user:{username:'admin'},roles:[],"
                "openChat:function(o){window.__cap=o;},registerTool:function(t){window.__tools[t.name]=t;}};")
        HOST = "window.ipcRenderer={send:function(){},on:function(){}};"

        def ask_page(src, seed):
            i = c.call("Page.addScriptToEvaluateOnNewDocument", source=src)["identifier"]
            c.call("Page.navigate", url=url.replace("seed=e2e", "seed=" + seed)); time.sleep(1.5)
            ok = signin("judge") and click("#tab_tool"); time.sleep(0.3)
            click("#ex1"); time.sleep(0.4)          # example 1: age 34, grade 2, R132H positive, ATRX lost (the age must never be sent)
            return i, ok

        i, ok = ask_page("window.__INFORMER__={user:{username:'admin'},roles:[]};", "ask1")
        expect("ask: tool tab opens without openChat", bool(ok))
        expect("ask: button hidden when __INFORMER__ has no openChat", not c.ev("!!document.getElementById('askAI')"))
        c.call("Page.removeScriptToEvaluateOnNewDocument", identifier=i)
        i, ok = ask_page(STUB, "ask2")
        expect("ask: box shown with the button DISABLED when openChat exists but no Informer host answers (share link / top-level tab)",
               bool(ok) and c.ev("(function(){var b=document.getElementById('askAI'); return !!b && b.disabled;})()") is True and "inside Informer GO" in (text("#askBox") or ""))
        click("#askAI"); time.sleep(0.2)
        expect("ask: clicking the disabled button sends nothing, and the preview still shows what would be sent", c.ev("window.__cap") is None and
               "histological_grade" in (c.ev("document.getElementById('askPreview').textContent") or ""))
        c.call("Page.removeScriptToEvaluateOnNewDocument", identifier=i)
        i, ok = ask_page(STUB + HOST, "ask3")
        expect("ask: button shown inside the Informer host", bool(ok) and c.ev("!!document.getElementById('askAI')") is True)
        expect("ask: label says Informer AI and research prototype", "Informer AI" in (text("#askAI") or "") and "Research prototype, not for clinical use" in (text("#askBox") or ""))
        prev = c.ev("(function(){var p=document.getElementById('askPreview'); return p ? p.textContent : '';})()") or ""
        expect("ask: nothing sent before the click", c.ev("window.__cap") is None and c.ev("Object.keys(window.__tools).length") == 0)
        click("#askAI"); time.sleep(0.3)
        cap = json.loads(c.ev("JSON.stringify(window.__cap)") or "null")
        raw = json.dumps(cap)
        expect("ask: openChat called with prompt, context and instructions", bool(cap) and all(isinstance(cap.get(k), (str, dict)) and cap.get(k) for k in ("prompt", "context", "instructions")), raw[:200])
        ctx = (cap or {}).get("context") or {}
        expect("ask: context carries grade, results, evidence and planner",
               ctx.get("histological_grade") == "2" and [r["id"] for r in ctx.get("reported_results", [])] == ["ihc", "atrx"] and
               ctx.get("cns5_evidence", {}).get("supported") is True and "Astrocytoma" in ctx.get("cns5_evidence", {}).get("diagnosis", "") and
               ctx.get("surrogate_warning") is True and "planner" in ctx, raw[:300])
        leaks = [x for x in ("34", "age 3", "<35", "35-50", "50-65", "65+", "clinical model", "your own estimate", "Case summary", "tumour board") if x in raw]
        leaks += re.findall(r"\bAge\b", raw)       # the summary starts "Age 34;" ("GlioAgent" is not a hit)
        expect("ask: no age, age band, prior label or free-text summary in anything sent", not leaks, str(leaks))
        expect("ask: the preview shows exactly what is sent", json.loads(prev) == ctx)
        expect("ask: two page tools registered (getCase, whatIf)", c.ev("Object.keys(window.__tools).sort().join()") == "getCase,whatIf")
        gc = c.ev("JSON.stringify(window.__tools.getCase.handler())")
        expect("ask: getCase returns the same de-identified case", json.loads(gc) == ctx)
        wi = json.loads(c.ev("JSON.stringify(window.__tools.whatIf.handler({test:'codel',result:1}))"))
        expect("ask: whatIf codel = codeleted -> oligodendroglioma supported, no surrogate warning",
               "Oligodendroglioma" in wi["cns5_evidence"].get("diagnosis", "") and wi["surrogate_warning"] is False and "hypothetical" in wi.get("what_if", ""), json.dumps(wi)[:300])
        wi0 = json.loads(c.ev("JSON.stringify(window.__tools.whatIf.handler({test:'codel',result:0}))"))
        expect("ask: whatIf codel = intact -> astrocytoma supported on 1p/19q intact", "1p/19q intact" in wi0["cns5_evidence"].get("basis", "") and wi0["surrogate_warning"] is False, json.dumps(wi0)[:300])
        bad = json.loads(c.ev("JSON.stringify(window.__tools.whatIf.handler({test:'ihc',result:0}))"))
        expect("ask: whatIf refuses a test that already has a result, and a bad test name", "already has a reported result" in bad.get("error", "") and
               "error" in json.loads(c.ev("JSON.stringify(window.__tools.whatIf.handler({test:'zzz',result:1}))")))
        expect("ask: whatIf leaves the screen unchanged", json.loads(c.ev("JSON.stringify(window.__tools.getCase.handler())")) == ctx)
        click("#ex3"); time.sleep(0.4)   # example 3: R132H positive, ATRX retained, 1p/19q not available here
        c.ev("(function(){var e=document.getElementById('age'); e.value='71'; e.dispatchEvent(new Event('input',{bubbles:true}));})()"); time.sleep(0.3)
        gc3 = json.loads(c.ev("JSON.stringify(window.__tools.getCase.handler())"))
        shown = text("#nextCard .big") or ""
        expect("ask: planner pick in the packet equals the one on screen (and 'unavailable' lists 1p/19q)",
               gc3["planner"].get("status") == "order next" and shown == "Order next: " + gc3["planner"]["next_test"] + " cost " + str(gc3["planner"]["cost"]) and
               "1p/19q" in gc3["unavailable_at_site"], shown + " | " + json.dumps(gc3["planner"]))
        c.call("Page.removeScriptToEvaluateOnNewDocument", identifier=i)

        c.drain(1.0)
        reqs = [e["params"]["request"]["url"] for e in c.events if e.get("method") == "Network.requestWillBeSent"]
        host = urlparse(a.url).netloc
        errors = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
        cons = [e["params"]["entry"]["text"][:200] for e in c.events if e.get("method") == "Log.entryAdded" and e["params"]["entry"]["level"] == "error"
                and not (a.informer_build and "/api/_server/caselog" in (e["params"]["entry"].get("url") or ""))]
        expect("0 JS exceptions", not errors, json.dumps([e["params"]["exceptionDetails"] for e in errors[:2]])[:600])
        expect("0 console errors", not cons, str(cons)[:400])
        expect("0 /api requests" + (" (other than the team log)" if a.informer_build else ""),
               not [u for u in reqs if "/api/" in u and not (a.informer_build and "/api/_server/caselog" in u)])
        expect("0 requests to other hosts", not [u for u in reqs if urlparse(u).netloc not in (host, "") and not u.startswith("data:")])
        print("requests:", sorted(set(urlparse(u).path for u in reqs)))
        print("E2E HOSPITAL", "PASS" if not fails else f"FAIL {fails}")
        sys.exit(1 if fails else 0)
    finally:
        chrome.terminate(); shutil.rmtree(prof, ignore_errors=True)


if __name__ == "__main__":
    main()

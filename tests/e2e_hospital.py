"""End-to-end test of the hospital simulation + Daily Workup page (web/hospital/) in headless Chrome. Needs websocket-client.

    python tests/e2e_hospital.py --url http://127.0.0.1:8770/hospital/ --shots OUTDIR

Uses ?speed=2 (2 real seconds per simulated day) and a fixed arrival seed. Checks: demo sign-in, worklist, a full case
workup following the assistant (order, advance the clock, sign out), the debrief, persistence across reload, the
resource-limited hospital's unavailable 1p/19q and send-out labels, the steward dashboard, and one Daily Workup game
played in the planner's order (must score exactly Par unless the planner itself goes out of bounds via the surrogate).
Fails on any JS exception or console error, any /api request, or any request to another host.
"""
import argparse
import json
import os
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
          pending: document.querySelectorAll('#results .pend').length};
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
    ap.add_argument("--port", type=int, default=9341)
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

        def signin(uid):
            click("#logout"); time.sleep(0.2)
            ok = click("#u_" + uid.replace(".", "_")); time.sleep(0.5); return ok

        c.call("Page.navigate", url=url); time.sleep(1.5); c.drain(0.3)
        c.shot(f"{a.shots}/h0_signin.png")
        expect("demo sign-in label shown", "Demo sign-in · simulated hospitals · public research data" in (text("#view") or ""))
        expect("sign in as clin.lakeside", signin("clin.lakeside"))
        n_rows = c.ev("document.querySelectorAll('#worklist tr.wrow').length")
        expect("worklist shows >= 3 cases", (n_rows or 0) >= 3, str(n_rows))
        clock = text("#hclock") or ""
        expect("header shows the simulated clock", clock.startswith("Day "), clock)
        expect("header shows the hospital name", "Lakeside General Hospital" in (text("#hname") or ""))
        c.shot(f"{a.shots}/h1_worklist.png")

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
        expect("dashboard carries the Informer note", "In the Informer build these numbers come from the team's shared database." in (text("#dash") or ""))
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
               c.ev("document.querySelectorAll('#results .pend').length") >= 1)
        expect("no-storage: practice tab opens", click("#tab_practice")); time.sleep(0.3)
        for _ in range(12):
            if c.ev(PRACTICE_STEP) in ("done", "stuck", "nobtn", "noprac"):
                break
            time.sleep(0.2)
        expect("no-storage: daily case completes with a golf label", bool(text("#golf")) and "Daily Workup" in (c.ev("(function(){var t=document.getElementById('shareTxt'); return t ? t.value : '';})()") or ""))
        c.shot(f"{a.shots}/h9_nostorage_practice.png")

        # --- Informer build: window.__INFORMER__.user (storage still blocked, as in a sandboxed iframe)
        sid = c.call("Page.addScriptToEvaluateOnNewDocument", source="window.__INFORMER__={user:{displayName:'Dr Test <b>x</b>',roles:['site_valley',{id:'steward'}]}};")["identifier"]
        c.call("Page.navigate", url=url.replace("seed=e2e", "seed=informer")); time.sleep(1.5)
        who = c.ev("document.getElementById('who').textContent") or ""
        expect("informer: display name shown and escaped", "Dr Test <b>x</b>" in who, who)
        expect("informer: site role selects Valley", "Valley Community Hospital" in (text("#hname") or ""))
        expect("informer: steward role shows dashboard; no demo sign-out link",
               bool(c.ev("!!document.getElementById('tab_dash')")) and c.ev("document.getElementById('logout').hidden") is True)
        expect("informer: label says Informer sign-in", "Informer sign-in" in (text("#tabs") or ""))
        c.shot(f"{a.shots}/h10_informer.png")
        c.call("Page.removeScriptToEvaluateOnNewDocument", identifier=sid)
        c.call("Page.addScriptToEvaluateOnNewDocument", source="window.__INFORMER__={user:{name:'nosite',roles:[]}};")
        c.call("Page.navigate", url=url.replace("seed=e2e", "seed=informer2")); time.sleep(1.5)
        npick = c.ev("document.querySelectorAll('[data-act=pickhosp]').length")
        expect("informer without site role: hospital picker (5)", npick == 5, str(npick))
        click("[data-act=pickhosp][data-h=harbor]"); time.sleep(0.3)
        expect("informer: picking a hospital shows its worklist", "Harbor Point Cancer Institute" in (text("#view h2") or ""))

        c.drain(1.0)
        reqs = [e["params"]["request"]["url"] for e in c.events if e.get("method") == "Network.requestWillBeSent"]
        host = urlparse(a.url).netloc
        errors = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
        cons = [e["params"]["entry"]["text"][:200] for e in c.events if e.get("method") == "Log.entryAdded" and e["params"]["entry"]["level"] == "error"]
        expect("0 JS exceptions", not errors, json.dumps([e["params"]["exceptionDetails"] for e in errors[:2]])[:600])
        expect("0 console errors", not cons, str(cons)[:400])
        expect("0 /api requests", not [u for u in reqs if "/api/" in u])
        expect("0 requests to other hosts", not [u for u in reqs if urlparse(u).netloc not in (host, "") and not u.startswith("data:")])
        print("requests:", sorted(set(urlparse(u).path for u in reqs)))
        print("E2E HOSPITAL", "PASS" if not fails else f"FAIL {fails}")
        sys.exit(1 if fails else 0)
    finally:
        chrome.terminate(); shutil.rmtree(prof, ignore_errors=True)


if __name__ == "__main__":
    main()

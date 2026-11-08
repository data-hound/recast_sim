"""Headless check of the deployed App through a real Informer share link. URL comes from env LINK_URL (never printed)."""
import json, os, subprocess, sys, tempfile, time, shutil, urllib.request
sys.path.insert(0, "/home/anshuman/ASDev/CancerML/RECAST/arcade/tests")
from e2e_chrome import CDP
url = os.environ["LINK_URL"]; shots = sys.argv[1]; os.makedirs(shots, exist_ok=True); port = 9351
prof = tempfile.mkdtemp()
ch = subprocess.Popen(["google-chrome", "--headless=new", "--disable-gpu", "--no-first-run", f"--user-data-dir={prof}", f"--remote-debugging-port={port}",
                       f"--remote-allow-origins=http://127.0.0.1:{port}", "--window-size=1280,900", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
fails = []
def expect(n, ok, d=""):
    print(("PASS " if ok else "FAIL ") + n + ("" if ok else f"  ({d})")); ok or fails.append(n)
try:
    for _ in range(50):
        try: tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json").read()); break
        except Exception: time.sleep(0.2)
    c = CDP([t for t in tabs if t["type"] == "page"][0]["webSocketDebuggerUrl"])
    for d in ("Page", "Runtime", "Network", "Log"): c.call(d + ".enable")
    c.call("Emulation.setDeviceMetricsOverride", width=1280, height=900, deviceScaleFactor=1, mobile=False)
    ev = c.ev
    click = lambda sel: ev(f"(function(){{var e=document.querySelector({json.dumps(sel)}); if(!e||e.disabled) return false; e.click(); return true;}})()")
    text = lambda sel: ev(f"(function(){{var e=document.querySelector({json.dumps(sel)}); return e ? e.textContent : null;}})()")
    c.call("Page.navigate", url=url); time.sleep(6)
    expect("sign-in form loads", bool(ev("!!document.getElementById('loginForm')")), (text("#view") or "")[:200])
    print("note:", text("#informerNote"))
    print("prefill:", ev("document.getElementById('loginEmail') && document.getElementById('loginEmail').value"))
    print("locked accounts:", ev("document.querySelectorAll('[data-act=fill][disabled]').length"))
    c.shot(f"{shots}/live0_signin.png")
    ev("document.getElementById('loginPass').value='demo'"); click("#loginBtn"); time.sleep(1)
    expect("signed in: worklist rows", (ev("document.querySelectorAll('#worklist tr.wrow').length") or 0) >= 1, text("#loginErr"))
    print("hospital:", text("#hname"))
    c.shot(f"{shots}/live1_worklist.png")
    click("#worklist tr.wrow"); time.sleep(0.6); c.shot(f"{shots}/live2_case.png")
    expect("case opens with assistant suggestion", bool(ev("!!document.getElementById('sug') || !!document.getElementById('supported')")))
    click("#tab_tool"); time.sleep(0.5); click("#examples button"); time.sleep(0.5)
    expect("clinician tool tab works", len(text("#postCard") or "") > 20 and len(text("#nextCard") or "") > 20)
    print("team log summary:", (text("#teamSum") or "")[:160])
    c.shot(f"{shots}/live3_tool.png")
    click("#tab_practice"); time.sleep(0.6)
    expect("practice tab shows the Daily Workup", "Daily Workup" in (text("#view") or ""))
    c.shot(f"{shots}/live4_practice.png")
    c.drain(1.0)
    errs = [e for e in c.events if e.get("method") == "Runtime.exceptionThrown"]
    cons = [e["params"]["entry"]["text"][:160] for e in c.events if e.get("method") == "Log.entryAdded" and e["params"]["entry"]["level"] == "error"]
    bad = [e["params"]["response"]["status"] for e in c.events if e.get("method") == "Network.responseReceived" and e["params"]["response"]["status"] >= 400]
    expect("0 JS exceptions", not errs, json.dumps([e["params"]["exceptionDetails"].get("text") for e in errs[:3]]))
    print("console errors:", cons[:5]); print("HTTP >=400 statuses:", bad[:10])
    print("LIVE", "PASS" if not fails else f"FAIL {fails}")
finally:
    ch.terminate(); shutil.rmtree(prof, ignore_errors=True)

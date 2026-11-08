"""Minimal Chrome DevTools Protocol client used by e2e_hospital.py and live_link_check.py (needs websocket-client).

Trimmed from the research repo's game end-to-end test; only the CDP helper is kept."""
import base64
import json
import time

import websocket


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

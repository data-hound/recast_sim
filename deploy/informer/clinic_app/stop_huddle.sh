#!/bin/sh
# Run after every deploy (npm run deploy does it): an Informer deploy sets the stopped morning-huddle cron agent back to "active"
# (observed 2026-11-08), which would spend AI credits on a schedule. Stop it again; start it deliberately in App Admin > Agents.
# (`inf deploy` bypasses this: run `sh stop_huddle.sh` after it.) Uses the inf sign-in; prints only the resulting status.
# Needs informer.id in package.json, which the first `npm run deploy` writes (a fresh clone has none until then).
cd "$(dirname "$0")"
python3 - <<'PY' || { echo "WARNING: deployed, but could NOT confirm the morning-huddle agent is stopped: check App Admin > Agents" >&2; exit 1; }
import json, subprocess, urllib.request
host = json.loads(subprocess.check_output(["inf", "whoami", "--json"]))["host"]
tok = subprocess.check_output(["inf", "auth", "token"]).decode().strip()
app = json.load(open("package.json"))["informer"].get("id")
if not app:
    raise SystemExit("package.json has no informer.id yet: deploy once first")
def call(method, path, body=None):
    r = urllib.request.Request("https://%s/api/apps/%s%s" % (host, app, path), method=method, data=json.dumps(body).encode() if body else None,
                               headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))
for a in call("GET", "/agents"):
    if a["name"] == "morning-huddle" and a["status"] != "stopped":
        call("PUT", "/agents/" + a["id"], {"status": "stopped"})
st = [a["status"] for a in call("GET", "/agents") if a["name"] == "morning-huddle"]
print("morning-huddle agent status:", st[0] if st else "missing")
assert st and st[0] == "stopped"
PY

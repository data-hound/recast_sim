#!/bin/sh
# Serve the standalone pages (web/hospital/ and web/clinic/) on http://127.0.0.1:8770/ with YOUR OWN private assets.
#   RECAST_PRIVATE_ASSETS=/private/dir ./run_local.sh      # the directory must hold model.json and cases.json
# The assets are copied to git-ignored paths (web/clinic/model.json, web/hospital/cases.json); they never enter git.
set -e
cd "$(dirname "$0")"
for f in model.json cases.json; do
  [ -f "${RECAST_PRIVATE_ASSETS:-/nonexistent}/$f" ] || { echo "run_local.sh: set RECAST_PRIVATE_ASSETS to a directory containing model.json and cases.json" >&2; exit 1; }
done
cp "$RECAST_PRIVATE_ASSETS/model.json" web/clinic/model.json
cp "$RECAST_PRIVATE_ASSETS/cases.json" web/hospital/cases.json
echo "Hospital simulation: http://127.0.0.1:8770/hospital/    Clinician tool: http://127.0.0.1:8770/clinic/"
exec python3 -m http.server 8770 --bind 127.0.0.1 --directory web

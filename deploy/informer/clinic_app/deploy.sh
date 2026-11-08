#!/bin/sh
# One-command Informer deploy. Credentials: INFORMER_URL plus INFORMER_API_KEY (or INFORMER_USER/INFORMER_PASS), taken from
# the environment, ./.env, or ~/.recast.env (only INFORMER_* lines are read; nothing is printed).
set -e
cd "$(dirname "$0")"
export PATH="$HOME/opt/node-v22.12.0/bin:$PATH"
if [ -z "$INFORMER_URL" ] && [ -f "$HOME/.recast.env" ]; then
  eval "$(grep -E '^(export )?INFORMER_(URL|API_KEY|USER|PASS)=' "$HOME/.recast.env" | sed 's/^export //; s/^/export /')"
fi
if [ -z "$INFORMER_URL" ] && [ ! -f .env ]; then
  # no explicit credentials: the plugin falls back to the Informer CLI sign-in (inf login <url>; inf auth token)
  command -v inf >/dev/null && inf whoami >/dev/null 2>&1 || { echo "Not signed in: run 'inf login <url>' or set INFORMER_URL + INFORMER_API_KEY"; exit 1; }
  echo "Using the inf sign-in: $(inf whoami --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["user"]["username"], "@", d["host"])')"
fi
node --version | grep -q '^v2[0-9]' || { echo "Need Node >= 20 (expected at ~/opt/node-v22.12.0)"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
npm run deploy -- "$@"

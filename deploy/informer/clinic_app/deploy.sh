#!/bin/sh
# One-command Informer deploy: sync (needs RECAST_PRIVATE_ASSETS) + vite build + upload + migrate + publish.
# Credentials are NOT stored in this repo. Either sign in with the Informer CLI (inf login https://<tenant>), or put
# INFORMER_URL and INFORMER_API_KEY in a git-ignored ./.env. Nothing is printed. Needs Node >= 20.
set -e
cd "$(dirname "$0")"
node --version | grep -q '^v2[0-9]' || { echo "Need Node >= 20 on PATH"; exit 1; }
if [ -z "$INFORMER_URL" ] && [ ! -f .env ]; then
  command -v inf >/dev/null && inf whoami >/dev/null 2>&1 || { echo "Not signed in: run 'inf login <url>' or create .env with INFORMER_URL and INFORMER_API_KEY"; exit 1; }
fi
[ -d node_modules ] || npm install --no-audit --no-fund
npm run deploy -- "$@"

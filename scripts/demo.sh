#!/usr/bin/env bash
# One command local demo: build, generate demo keys, start the stack,
# set up the Lightning wallets, and serve the ShroudVeil app.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run build
node dist/scripts/gen-env.js
bash scripts/stack.sh
node dist/scripts/setup.js

if curl -s -m 2 http://127.0.0.1:8799/api/status >/dev/null 2>&1; then
  echo "app already running on http://127.0.0.1:8799"
else
  echo "starting the ShroudVeil app..."
  nohup node dist/src/server.js > "$ROOT/server.log" 2>&1 &
  for i in $(seq 1 20); do
    if curl -s -m 2 http://127.0.0.1:8799/api/status >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

echo ""
echo "ShroudVeil is up:  http://127.0.0.1:8799"
echo "Demo PINs:         normal 2468, duress 9753"
echo "Watcher status:    open the app and tap Watcher status"
echo "Run the proofs:    npm run e2e"

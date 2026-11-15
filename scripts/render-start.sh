#!/usr/bin/env bash
# Hosted start process: bring up the full ShroudVeil demo stack in one
# container (Render free tier) or on any single machine:
#   1. Bitcoin Core on regtest (coin and block source, demo only)
#   2. LNbits 1.7.1 + FakeWallet, with a FRESH data folder: the first
#      install is completed automatically and account creation is opened
#      (the two gates the spike documented), then the demo wallets are
#      created and funded by scripts/setup.ts
#   3. The ShroudVeil app server in the foreground on $PORT
#
# Everything is demo material on test networks. Fresh keys and fresh
# wallets are generated on first boot; nothing here can hold real funds.
#
# Knobs (defaults match the Docker image and the local project):
#   SV_BITCOIN_BIN   dir holding bitcoind/bitcoin-cli
#   SV_LNBITS_VENV   python venv with lnbits installed
#   SV_RPC_PORT      bitcoind RPC port      (default 18443)
#   SV_P2P_PORT      bitcoind p2p port      (default 18444)
#   SV_LNBITS_PORT   LNbits port            (default 5001)
#   PORT             app port               (default 8799)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BITCOIN_BIN="${SV_BITCOIN_BIN:-$ROOT/tools/bitcoin-28.1/bin}"
LNBITS_VENV="${SV_LNBITS_VENV:-$HOME/.venvs/lnbits}"
RPC_PORT="${SV_RPC_PORT:-18443}"
P2P_PORT="${SV_P2P_PORT:-18444}"
LN_PORT="${SV_LNBITS_PORT:-5001}"
APP_PORT="${PORT:-8799}"
DATADIR="$ROOT/regtest-data"
LNDATA="$ROOT/lnbits-data"
mkdir -p "$DATADIR" "$LNDATA" "$ROOT/data"

export BITCOIND_RPC_URL="http://127.0.0.1:$RPC_PORT"
export LNBITS_URL="http://127.0.0.1:$LN_PORT"

health() {
  local h
  h=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$LN_PORT/api/v1/health" 2>/dev/null)
  printf '%s' "${h:-000}"
}

wait_health_not_down() { # wait until LNbits answers at all (200 or the 307 first-install gate)
  for _ in $(seq 1 45); do
    [ "$(health)" != "000" ] && return 0
    sleep 2
  done
  return 1
}

wait_health_ok() { # wait until LNbits answers 200
  for _ in $(seq 1 45); do
    [ "$(health)" = "200" ] && return 0
    sleep 2
  done
  return 1
}

fail_boot() {
  echo "BOOT FAILED: $1"
  echo "--- last LNbits log lines ---"
  tail -30 "$ROOT/lnbits.log" 2>/dev/null || true
  exit 1
}

start_lnbits() {
  local site_packages
  site_packages="$("$LNBITS_VENV/bin/python" -c "import site; print(site.getsitepackages()[0])")"
  (cd "$site_packages" && \
    LNBITS_BACKEND_WALLET_CLASS=FakeWallet LNBITS_DATA_FOLDER="$LNDATA" \
    nohup "$LNBITS_VENV/bin/lnbits" --port "$LN_PORT" --host 127.0.0.1 \
    > "$ROOT/lnbits.log" 2>&1 &)
}

stop_lnbits() {
  pkill -f "lnbits --port $LN_PORT" 2>/dev/null || true
  for _ in $(seq 1 15); do
    [ "$(health)" = "000" ] && return 0
    sleep 1
  done
  pkill -9 -f "lnbits --port $LN_PORT" 2>/dev/null || true
  sleep 1
}

# --- 0. build + demo keys -------------------------------------------------
if [ ! -f dist/src/server.js ]; then
  echo "building the app..."
  npm run build
fi
node dist/scripts/gen-env.js
RPC_USER=$(grep '^BITCOIND_RPC_USER=' .env | cut -d= -f2)
RPC_PASS=$(grep '^BITCOIND_RPC_PASS=' .env | cut -d= -f2)

# --- 1. Bitcoin Core (regtest) --------------------------------------------
CLI="$BITCOIN_BIN/bitcoin-cli -regtest -datadir=$DATADIR -rpcuser=$RPC_USER -rpcpassword=$RPC_PASS -rpcport=$RPC_PORT"
if ! $CLI getblockcount >/dev/null 2>&1; then
  echo "starting bitcoind (regtest)..."
  "$BITCOIN_BIN/bitcoind" -regtest -datadir="$DATADIR" -server -daemon \
    -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS" -fallbackfee=0.0002 \
    -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport="$RPC_PORT" -port="$P2P_PORT"
  for _ in $(seq 1 30); do
    $CLI getblockcount >/dev/null 2>&1 && break
    sleep 1
  done
fi
echo "bitcoind height: $($CLI getblockcount)"

# --- 2. LNbits --------------------------------------------------------------
if grep -q '^LN_MAIN_ADMINKEY=' .env 2>/dev/null && [ -f "$LNDATA/database.sqlite3" ]; then
  # Already initialised (local dev, or a container restart with a warm disk):
  # just bring LNbits up. The settings gates were opened during init.
  if [ "$(health)" = "000" ] || [ "$(health)" = "307" ]; then
    echo "starting LNbits (existing data)..."
    start_lnbits
    wait_health_not_down || fail_boot "LNbits (existing data) did not come up"
  fi
  echo "LNbits health: HTTP $(health)"
else
  echo "fresh LNbits data folder: running first-install init..."
  # Superuser password for this throwaway demo instance. LNbits only ever
  # listens on 127.0.0.1 inside this container; the password protects
  # nothing of value and is stored in the gitignored .env.
  if ! grep -q '^LNBITS_SUPERUSER_PASSWORD=' .env; then
    SU_PASS=$(node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")
    echo "LNBITS_SUPERUSER_PASSWORD=$SU_PASS" >> .env
  fi
  SU_PASS=$(grep '^LNBITS_SUPERUSER_PASSWORD=' .env | cut -d= -f2)

  start_lnbits
  wait_health_not_down || fail_boot "LNbits first boot did not come up"
  echo "LNbits first boot health: HTTP $(health)"

  # Gate 1: complete the first install (sets the superuser credentials).
  # No LNBITS_FIRST_INSTALL_TOKEN is configured, so no token is required.
  # The fields go in the JSON body (query parameters are rejected with a
  # 400 by this LNbits version); retry a few times because the superuser
  # account is seeded during startup.
  CODE=000
  for _ in $(seq 1 6); do
    CODE=$(curl -s -m 10 -o /tmp/sv-first-install.json -w "%{http_code}" -X PUT \
      "http://127.0.0.1:$LN_PORT/api/v1/auth/first_install" \
      -H 'Content-Type: application/json' \
      -d "{\"username\":\"svadmin\",\"password\":\"$SU_PASS\",\"password_repeat\":\"$SU_PASS\"}")
    [ "$CODE" = "200" ] || [ "$CODE" = "403" ] && break
    sleep 3
  done
  echo "first_install: HTTP $CODE"
  if [ "$CODE" != "200" ] && [ "$CODE" != "403" ]; then
    echo "first_install response:"; cat /tmp/sv-first-install.json 2>/dev/null; echo
    fail_boot "first_install did not complete"
  fi

  # Gate 2: open account creation in system_settings (DB values override
  # env), the exact rows the spike proved, then restart so they take effect.
  stop_lnbits
  for _ in $(seq 1 15); do
    [ -f "$LNDATA/database.sqlite3" ] && python3 -c "
import sqlite3, sys
con = sqlite3.connect('$LNDATA/database.sqlite3')
sys.exit(0 if con.execute(\"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='system_settings'\").fetchone()[0] else 1)
" 2>/dev/null && break
    sleep 2
  done
  python3 - "$LNDATA/database.sqlite3" <<'PYEOF' || fail_boot "settings patch failed"
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("UPDATE system_settings SET value='[\"username-password\", \"user-id-only\"]' WHERE id='auth_allowed_methods'")
con.execute("UPDATE system_settings SET value='true' WHERE id='lnbits_allow_new_accounts'")
con.commit()
rows = con.execute("SELECT id, value FROM system_settings WHERE id IN ('auth_allowed_methods','lnbits_allow_new_accounts')").fetchall()
print("settings patched:", rows)
if len(rows) != 2:
    sys.exit(1)
PYEOF
  start_lnbits
  wait_health_ok || fail_boot "LNbits did not reach HTTP 200 after the settings patch"
  echo "LNbits health after init: HTTP $(health)"
fi

# --- 3. Demo Lightning wallets (create + fund, idempotent) ------------------
node dist/scripts/setup.js

# --- 4. The app, foreground ---------------------------------------------------
echo "starting ShroudVeil on port $APP_PORT..."
exec node dist/src/server.js

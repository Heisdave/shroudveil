#!/usr/bin/env bash
# Start the local ShroudVeil stack: Bitcoin Core (regtest) and LNbits.
# Both are reused from the spike setup; nothing here touches the internet
# or any real funds.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo ".env missing. Run: node dist/scripts/gen-env.js"
  exit 1
fi
RPC_USER=$(grep '^BITCOIND_RPC_USER=' .env | cut -d= -f2)
RPC_PASS=$(grep '^BITCOIND_RPC_PASS=' .env | cut -d= -f2)
BTC="$ROOT/tools/bitcoin-28.1/bin"
DATADIR="$ROOT/regtest-data"
mkdir -p "$DATADIR"

# --- Bitcoin Core (regtest) ---
if ! "$BTC/bitcoin-cli" -regtest -datadir="$DATADIR" -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS" getblockcount >/dev/null 2>&1; then
  echo "starting bitcoind (regtest)..."
  "$BTC/bitcoind" -regtest -datadir="$DATADIR" -server -daemon \
    -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS" -fallbackfee=0.0002 \
    -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1
  for i in $(seq 1 30); do
    if "$BTC/bitcoin-cli" -regtest -datadir="$DATADIR" -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS" getblockcount >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi
echo "bitcoind height: $("$BTC/bitcoin-cli" -regtest -datadir="$DATADIR" -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS" getblockcount)"

# --- LNbits (self-hosted, FakeWallet) ---
# First run: reuse the spike's already-initialised data folder (first install
# completed, account creation opened in system_settings). See SPIKE-REPORT.
if [ ! -f "$ROOT/lnbits-data/database.sqlite3" ]; then
  echo "copying LNbits data folder from the spike project..."
  cp -r "$ROOT/../dakar-spike/lnbits-data" "$ROOT/lnbits-data"
fi
HEALTH=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:5001/api/v1/health 2>/dev/null)
HEALTH=${HEALTH:-000}
if [ "$HEALTH" = "000" ] || [ "$HEALTH" = "307" ]; then
  echo "starting LNbits..."
  (cd "$HOME/.venvs/lnbits/lib/python3.12/site-packages" && \
    LNBITS_BACKEND_WALLET_CLASS=FakeWallet LNBITS_DATA_FOLDER="$ROOT/lnbits-data" \
    nohup "$HOME/.venvs/lnbits/bin/lnbits" --port 5001 --host 127.0.0.1 \
    > "$ROOT/lnbits.log" 2>&1 &)
  for i in $(seq 1 40); do
    HEALTH=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:5001/api/v1/health 2>/dev/null)
    HEALTH=${HEALTH:-000}
    if [ "$HEALTH" != "000" ] && [ "$HEALTH" != "307" ]; then break; fi
    sleep 2
  done
fi
echo "LNbits health: HTTP $HEALTH"
echo "stack up: bitcoind regtest on 18443, LNbits on 5001"

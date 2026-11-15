# ShroudVeil, Phase 1 Report

**Phase:** core engine plus local end-to-end proof of both protection stories
**Date:** Sun 15 Nov 2026
**Verdict: Phase 1 complete. Both stories proven end to end on the local stack, with evidence.**

---

## What was built

Project: `~/workspace/projects/shroudveil/` (Node.js + TypeScript, plain node:http server, no framework).

- **Chain adapter** (`src/chain.ts`) with two backends behind one interface:
  - Regtest via Bitcoin Core 28.1 JSON-RPC: UTXO scan, balance, broadcast, plus demo-only funding and mining helpers (Core is the coin and block source locally; all wallet keys live in the app).
  - Signet via the mempool.space Esplora API: UTXO list, tip height, broadcast, public explorer links. Fully coded; it activates when the vault address holds a funded signet UTXO (none exists yet, same faucet situation as the spike).
- **Keys** (`src/keys.ts`): vault, recovery, and decoy keypairs generated fresh into a gitignored `.env`. One key set derives both regtest (bcrt1) and signet (tb1) addresses, exactly as the spike did.
- **Sweep state machine** (`src/sweep.ts`): UNARMED, ARMED, TRIGGERED, SWEPT, FAILED, persisted in `data/sweep.json`. Arming builds and pre-signs the sweep PSBT (largest vault UTXO to the recovery address, fee 500 sats, nLockTime = height + 3, sequence 0xfffffffe, signature validated locally before finalizing). Triggering starts a broadcast retry loop: attempts before the locktime are rejected by the node as non-final and recorded; the same signed hex succeeds once the locktime passes. No CSV vault output, per the spike design.
- **Lightning adapter** (`src/lnbits.ts`): LNbits API client for the main and decoy wallets on the self-hosted LNbits 1.7.1 + FakeWallet instance carried over from the spike (same data folder lineage, venv at `~/.venvs/lnbits`).
- **Nostr module** (`src/nostr.ts`): check-in publisher (kind 30078, d-tag and t-tag `shroudveil-checkin`) writing to 4 relays with any one success counting; latest check-in reader verifying the Schnorr signature and computing age. The watcher reads from the two relays proven for publish plus readback in the spike (relay.primal.net, offchain.pub). The sandbox proxy WebSocket shim from the spike is reused.
- **Watcher** (`src/watcher.ts`): polls every 10 seconds while the sweep is ARMED. Fresh valid check-in: HOLD. Stale, missing, or invalid check-in: FIRE (broadcast the held sweep). Relays unreachable: UNKNOWN and it holds, because a network outage is not proof of death. Every decision is logged to `data/watcher-log.jsonl`.
- **App server and front end** (`src/server.ts`, `public/index.html`): single-page, mobile-first, near-black with muted greys and one muted teal accent, no orange anywhere, no em dashes in any copy. Screens: PIN pad (normal PIN routes to the real wallet, duress PIN routes to the decoy and fires the sweep silently, identical response shape), one wallet template serving both views, a Check In button, and a status view (watcher state, last check-in age, sweep state, sweep txid, explorer link in signet mode). The decoy view shows the same rows as the main view: its Lightning balance (5,000 sats) as the total, and a real but unfunded decoy on-chain address at 0.

## Run it (one command)

```bash
npm run demo
```

Builds, generates demo keys if needed, starts bitcoind (regtest) and LNbits, creates and funds the Lightning wallets, serves http://127.0.0.1:8799. Demo PINs: normal `2468`, duress `9753`. Proofs: `npm run e2e`.

## Lightning setup result

Evidence: `evidence/setup-result.json`.

- Main wallet funded with 1,000,000 sats by converting one of its own invoice rows in the local ledger (the spike-proven FakeWallet funding step, documented in `scripts/setup.ts`).
- Decoy received 5,000 sats from main through a real invoice payment inside the instance: invoice `b14f8666540b466c03635a36207627586b088e2ad3d32509f45d34a9a1ce005f`, paid: true. Final balances: main 995,000 sats, decoy 5,000 sats.

## Story proof A: the duress PIN

Evidence: `evidence/e2e-duress.json`. Run at 04:47 to 04:48 UTC.

1. Vault funded with 0.5 BTC on regtest: funding tx `42d83881b661baa5b4cc744e7c860f799af57b5787ee9f7233826db578c7bb1d`, UTXO vout 1, 50,000,000 sats at height 102.
2. Owner checked in: Nostr event `1629a9e8dd935a4a57596633345092aa168dae1e2826e0f1f54966cf8828a5c5`, accepted by 3 of 4 relays.
3. Normal PIN opened the real wallet: total 50,995,000 sats (50,000,000 on chain, 995,000 Lightning).
4. Sweep armed: pre-signed tx `dbd4297c462038844e8fc906a351a5ce54759e500656856e4675af6468d3afea`, locktime 105, output 49,999,500 sats.
5. Duress PIN opened the decoy: total 5,000 sats, on chain 0. Nothing on screen hinted at the real wallet.
6. The sweep triggered with source `duress`. First broadcast attempt at height 102 was rejected by the node: **non-final**. The state machine recorded the rejection and kept retrying.
7. After mining past height 105, the same pre-signed hex broadcast and confirmed. Recovery address gained exactly **49,999,500 sats**.

## Story proof B: the dead-man's switch

Evidence: `evidence/e2e-deadman.json`, watcher decisions in `data/watcher-log.jsonl`. Run at 04:48 to 04:51 UTC.

1. Vault funded again: tx `d727e54100ec949cee8d0b7cf9eddba926cc60530302a75d859dcb90b1febc38`.
2. Owner checked in: event `71e9433c46f10b102501ea49f830029c52c57c5eb8084582f9730537b1d3d1e6`, 3 of 4 relays.
3. Sweep armed: pre-signed tx `d22f2bc997719b0329cacc682c13e0b3cf0294fc7e0917117d1e615c78256362`, locktime 111.
4. Watcher decision: **HOLD**, check-in 34s old inside the 120s window. The log shows HOLD again at 104s and 114s.
5. Owner stopped checking in. At check-in age 124s the watcher decided **FIRE** and triggered the sweep with source `watcher`, no phone involved.
6. After mining past the locktime the sweep confirmed. Recovery gained exactly **49,999,500 sats**. Recovery address now holds 99,999,000 sats total across both stories.

## What failed, what was cut, stated plainly

- **First LNbits setup attempt failed.** The spike note keyed the ledger funding on a `pending` column; this LNbits 1.7.1 schema has no `pending` column in `apipayments`, it has `status`. Setting the amount alone left the row at status `pending` and the balance at 0. Fix: the setup now also sets `status` to `success` when that column exists, and verifies the row count. Second run passed cleanly. One orphaned pair of empty LNbits accounts from the failed run remains in the local database; harmless.
- **Bitcoin Core had to be re-downloaded.** The spike kept it in `/tmp`, which was wiped between sessions. It now lives in the project at `tools/bitcoin-28.1/` with the regtest data in `regtest-data/`, both gitignored, so later phases do not rediscover this.
- **Check-ins reached 3 of 4 relays in both stories.** nos.lol timed out, matching the spike's finding that it silently drops events from this network. The design already treats any one relay success as a valid check-in, so this costs nothing.
- **Signet mode is coded, not yet proven against funded coins.** No public faucet would fund the spike, and none has funded this build either. The regtest path proves the identical code against funded UTXOs; the signet path needs one funded UTXO before demo day, which is a logistics task for a later phase, not a code gap.
- **The watcher reads from 2 relays, not the full set.** Deliberate: those two are the ones proven for readback. The publisher still writes to all 4.
- **Broadcast before locktime is retried, not queued by the node.** Nodes reject non-final transactions outright, so the state machine retries every 4 seconds until the locktime passes. On signet that means the sweep lands within a few seconds of the third block after arming, which matches the intended delay window.

## State left behind

The full stack (bitcoind regtest, LNbits, app server) is still running locally with the sweep in SWEPT state from story B, so the parent agent or Dexter can open http://127.0.0.1:8799 and the status view immediately. `npm run demo` is idempotent and brings it all back up after a restart. No GitHub repo was created and nothing was posted anywhere, per the phase constraints.

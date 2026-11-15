# ShroudVeil, Phase 2 Report

**Phase:** hosting on Render, repo prep, demo video script
**Date:** Sun 15 Nov 2026
**Verdict: hosting is built and proven locally but cannot be deployed yet, for exactly one reason: Render requires the GitHub repo to exist, and the repo is not public. Everything else on the phase list is done.**

---

## 1. Hosting

### Live URL: none yet, and here is the exact proof

The Render service create call was made on 15 Nov 2026 with the full configuration (name `shroudveil`, docker runtime, free plan, Frankfurt, repo `https://github.com/Heisdave/shroudveil`, branch `master`, Dockerfile at the repo root). Render rejected it with HTTP 400:

> "passed in repository URL is invalid or unfetchable: https://github.com/Heisdave/shroudveil"

Render validates and fetches the repo at creation time. The repo does not exist on GitHub, and per the phase constraints it was not created or pushed: going public needs Dexter's explicit go. No service exists, so no URL is live, and no keep-warm loop was started (the MintAnchor pattern starts it once a URL is live; starting one now would ping a URL that does not exist).

**The remaining step is one API call.** The moment the repo is public: create the service with the payload above, set any env vars with the env-vars PUT (creation-time env vars are silently dropped, per the connector doc; this app needs none beyond what Render sets itself, since demo keys are generated on boot), trigger a deploy with POST /v1/services/{id}/deploys, and poll until live. The demo will then be at https://shroudveil.onrender.com. The README's hosting section says exactly this, in the open.

### What was built for hosting

- `Dockerfile`: python:3.12-slim base, Node 24, Bitcoin Core 28.1 downloaded at build time, LNbits 1.7.1 in a venv with the spike-proven `bitstring==3.1.9` pin, `npm ci`, app built at image build time.
- `scripts/render-start.sh`: the start process. One process brings up the whole stack in demo mode: bitcoind on regtest, LNbits (fresh data folder: first install completed automatically, account creation opened, demo wallets created and funded by `scripts/setup.ts`), then the app in the foreground on `$PORT` (Render assigns it; the app already reads `PORT`, and `.env` values never override real environment variables).
- `public/index.html`: the Watcher status screen gained demo controls (Fund the vault, Arm the sweep, Mine blocks) wired to the existing `/api/demo/*` endpoints, so a judge can run both stories from the page. Before this, those endpoints were only reachable by script.

### The hosted path was proven end to end, locally, from a cold start

The identical start process was run in a scratch copy with a fresh chain, a fresh LNbits data folder, and no `.env`, on alternate ports so the Phase 1 stack was untouched:

1. Fresh boot completed with no human step: LNbits health went 307 (first-install gate), first install returned HTTP 200, the settings patch applied (`auth_allowed_methods` and `lnbits_allow_new_accounts`, the spike's exact rows), restart reached HTTP 200.
2. Setup created both wallets: main funded with 1,000,000 sats by the documented ledger step, decoy received 5,000 sats through a real invoice payment (`paid: true`). Balances exact.
3. The duress story was then driven through the API exactly as a judge would drive the page: check in accepted by 3 of 4 relays, fund 0.5 test BTC, arm, duress PIN opened the decoy (5,000 sats, on chain 0) and fired the sweep, mine past the locktime, and the status view showed sweep SWEPT with trigger `duress` and the recovery address holding exactly **49,999,500 sats** (sweep tx `ca4c9ceb2460d4a5e97f5206fa817e165a1e6b770d6bc448a71de02f2b76337a` on the scratch regtest chain).
4. The watcher was running in the hosted boot (status showed it polling with the 120 second window). The dead man story itself was proven in Phase 1 and not re-run in the scratch boot.

So: if the container runs, the demo runs. What is unproven is only whether Render's free tier runs this container well, which cannot be tested until the repo exists.

### Hosting problems hit, and their state

- **Solved: health check bug in the first start script draft.** The health probe could print `000000` (curl's `000` plus a fallback echo), which made the wait loops exit instantly and the first install fire at a server that was not up. Fixed with a single-value probe and explicit wait functions; a boot that cannot reach a healthy LNbits now fails loudly with the LNbits log tail instead of serving a broken app.
- **Solved: first install field placement.** Query parameters are rejected by LNbits 1.7.1 with HTTP 400 ("missing body"); the fields must go in the JSON body. Verified live against a fresh instance, then baked into the script.
- **Solved: the spike's two LNbits gates on a fresh install.** First install (superuser credentials) and account creation (system_settings rows) are both handled inside the start process. A mid-migration kill during early testing also taught the script to wait for the `system_settings` table to exist before patching it.
- **Standing: free-tier memory fit is unverified.** Measured locally, resident memory is roughly: bitcoind 47 MB, the app 63 MB, LNbits about 150 MB for the main process with worker processes observed around 130 MB each. The stack total can approach the free tier's 512 MB. It may fit; it may OOM under load. This is only testable on Render itself. If it OOMs, the honest degradation order is: keep the app and LNbits real, keep the regtest bitcoind (it is the smallest piece), and lean on Render restarts plus the keep-warm ping; the start process already rebuilds fresh demo state on every boot, so a restart is a reset, not a corruption. Nothing in the demo is ever faked to save memory.
- **Standing: Render's disk is ephemeral.** Every restart wipes the chain, the LNbits database, and `.env`. By design the start process treats every boot as a fresh demo: new keys, new wallets, funded on boot, PINs unchanged (normal 2468, duress 9753). A judge always lands on a clean, working demo.
- **Standing: signet mode remains unfunded.** Same faucet situation as Phase 1. The hosted demo runs on regtest, and the README already says so plainly. The status screen links a public explorer only in signet mode.

## 2. Repo prep (local only)

- `git init` done (branch `master`). **No remote exists** (`git remote` is empty) and nothing was pushed anywhere.
- `.gitignore` verified and extended. It covers: `.env` and `.env.*`, key and cert files (`*.key`, `*.pem`), `data/`, `lnbits-data/`, `regtest-data/`, `tools/`, `node_modules/`, `dist/`, `*.log` and `logs/`. Phase 1 also ignores `evidence/` (the proof JSONs stay local); that choice was left as Phase 1 made it. Exactly 25 files are tracked: source, scripts, docs, Dockerfile, package files. No `.env`, no data folders, no binaries, no logs.
- **Secret scan over the tracked files: CLEAN.** Three checks ran. (1) Pattern scan for WIF keys, xprv, private key blocks, and credential assignments: the only matches were code that generates or reads those values (variable names in `gen-env.ts`, `render-start.sh`, `stack.sh`), never a value. (2) Every live secret value in the real `.env` (all three WIFs, the Nostr secret, the RPC password, all four LNbits keys, both wallet ids) was searched for verbatim in every tracked file: zero hits. (3) 64-character hex strings in tracked files are only the regtest txids, payment hash, and Nostr event ids quoted as evidence in PHASE1-REPORT.md, plus standard sha512 integrity hashes in `package-lock.json`. Those are public proof identifiers on a local test chain, not keys.
- **One clean local commit:** `a42b4c00524dde729d96885db262e802143982e7` on `master`, 25 files, working tree clean after it. This report file was written after that commit (it records the hash) and is the only uncommitted file; it will ride the next commit.

## 3. Demo video script

Written to `~/workspace/goals/dakar-bitcoin-hack-submission-satsguard/files/shroudveil-demo-script.md`. Draft only, nothing filmed.

- Seven scenes, about 3 minutes, roughly 330 narration words: the problem (phone snatching and forced unlocks), arming in safety, the normal PIN, the duress PIN and the decoy, the sweep landing with the recovery balance on the status screen, the missed check in where the watcher fires alone, and a close on what is real (Bitcoin signatures, the pre-signed transaction, the network-enforced time lock) and the name.
- Written for the standing voice rules: Inspiring Gong at speed about 84, short pause-broken lines, each narration line is one subtitle chunk of at most two short lines, numbers spelled out for text to speech, and zero em dashes (verified by grep across the script, the README, and the page copy).
- Each scene marks what is on screen, and the filming notes cover the demo controls, the PINs, and the honest cut for the 120 second check in window.

## What the parent needs to know

1. **One decision unblocks hosting: the repo going public.** On Dexter's go, the sequence is: push this repo to `Heisdave/shroudveil`, run the one create call, trigger the deploy, add the keep-warm loop (MintAnchor pattern, self-stop after 2026-11-24), and confirm the URL in the README. Everything else is built and tested.
2. The local judge path is bulletproof today: `npm run demo`, then the status screen demo controls, or `npm run e2e` for the scripted proofs.
3. Free-tier memory fit is the one real unknown left in hosting, and it can only be settled by the first real deploy.

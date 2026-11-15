# ShroudVeil

**The wallet that hides what matters.**

ShroudVeil is a Bitcoin wallet built for a specific, common danger: phone snatching and forced transfers. Across Nigerian cities, people are robbed of their phones and forced to unlock their banking and crypto apps on the spot. A normal wallet fails completely in that moment. Whatever the attacker sees, the attacker takes.

ShroudVeil answers with concealment and pre-commitment:

- **Two PINs.** The owner sets a normal PIN and a duress PIN. The normal PIN opens the real wallet. The duress PIN opens a decoy wallet with a small, believable balance, and it looks exactly like the real thing.
- **A pre-signed sweep.** When the owner arms ShroudVeil, the app builds and signs a transaction that sends the entire on-chain vault to a recovery address, and locks it with an nLockTime. The signed transaction is held, not broadcast. Signing happens calmly, in advance, while the owner is safe.
- **The duress trigger.** Entering the duress PIN silently fires the held sweep. The attacker sees a small wallet. The real funds are already on their way to the recovery address, and the timelock means even the owner cannot reverse it in the moment.
- **A dead-man's switch.** The app publishes signed check-in events to Nostr relays. A watcher checks the newest check-in against a safety window. If check-ins stop, the watcher broadcasts the held sweep on its own. No phone needed. If the relays are simply unreachable, the watcher holds: a network outage is not proof of death.

## What is real and what is test

Honest architecture, because judges should not have to guess:

- The cryptography is real: bitcoinjs-lib key generation, PSBT construction, advance signing, signature validation, nLockTime enforcement by the network itself, Schnorr-signed Nostr events verified by an independent watcher process.
- The money is test money. Locally the chain runs on Bitcoin regtest (Bitcoin Core 28.1) and the Lightning side runs on a self-hosted LNbits with its FakeWallet backend, so Lightning payments settle for real inside the instance but are worth nothing outside it.
- A public signet mode is built in (mempool.space Esplora API). It activates the moment the vault address holds a funded signet UTXO, and the status page then links the sweep transaction on a public explorer.
- The LNbits main wallet is funded in setup by converting one of its own invoice rows in the local ledger. That step is only possible because we operate the instance, and it is documented in the setup script rather than hidden.
- Demo PINs and demo keys are generated fresh into a local `.env` file. They protect nothing of value and must never be funded with real bitcoin.

## Run it locally (one command)

```bash
npm run demo
```

That builds the app, generates demo keys, starts Bitcoin Core on regtest and the self-hosted LNbits, creates the main and decoy Lightning wallets (main funded with 1,000,000 test sats, decoy settled with 5,000 test sats through a real invoice payment), and serves the app.

- App: http://127.0.0.1:8799
- Normal PIN: `2468`
- Duress PIN: `9753`

## Hosted demo (Render): prepared, pending repo publication

The hosted build is ready and proven. The repo carries a `Dockerfile` and a start process (`scripts/render-start.sh`) that bring up the full stack in one free-tier container: Bitcoin Core on regtest, LNbits with FakeWallet (fresh install completed automatically, demo wallets created and funded on boot), and the app on the port Render assigns. The status screen in the app has demo controls (fund the vault, arm the sweep, mine blocks), so the two stories below can be run from the page itself.

That exact start process was run from a cold start during Phase 2 and the duress story was driven end to end through the API: check in accepted by 3 of 4 relays, vault funded with 0.5 test BTC, sweep armed, duress PIN opened the decoy at 5,000 sats while the sweep fired, and after mining past the locktime the recovery address held exactly 49,999,500 sats.

One step remains, and it is not a code step: Render validates the GitHub repo when a service is created, and this repo is not public yet. The create call was attempted on 15 Nov 2026 and Render rejected it with "repository URL is invalid or unfetchable" for that reason alone. The moment the repo is public, one API call creates the service (name `shroudveil`, docker runtime, free plan, Frankfurt), a manual deploy follows, and the demo will live at https://shroudveil.onrender.com. Until then, the local one-command run above is the judge path, and it is the same code and the same start process the container runs.

## Prove the two stories

With the demo running:

```bash
npm run e2e
```

1. **Duress story.** Funds the vault, checks in, arms the sweep, opens the wallet with the normal PIN, then with the duress PIN. The decoy opens with 5,000 sats while the sweep fires, is rejected as non-final until its locktime, then broadcasts and confirms into the recovery address.
2. **Dead-man story.** Funds the vault, checks in, arms the sweep, and the watcher HOLDs. Check-ins stop. After the safety window (120 seconds in the demo, hours in the product setting) the watcher FIREs on its own and the recovery address receives the funds.

Evidence lands in `evidence/` as JSON, and the watcher's decisions are logged in `data/watcher-log.jsonl`.

## Layout

- `src/chain.ts` chain adapters: regtest via Bitcoin Core RPC, signet via Esplora
- `src/sweep.ts` the pre-signed sweep state machine: UNARMED, ARMED, TRIGGERED, SWEPT
- `src/lnbits.ts` Lightning adapter for the main and decoy wallets
- `src/nostr.ts` check-in publisher and latest check-in reader
- `src/watcher.ts` the dead-man's switch loop
- `src/server.ts` API and app server (plain node:http)
- `public/index.html` the single-page app: PIN pad, wallet view, watcher status
- `scripts/` stack startup, one-time setup, and the two end-to-end proofs

## Safety notes

This is a hackathon build on test networks. The design ideas (decoy under duress, pre-signed recovery sweeps, check-in dead-man's switch) are the product. Do not use these keys, this code, or this setup with real funds.

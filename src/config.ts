import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_ROOT = path.join(__dirname, '..', '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const ENV_PATH = path.join(PROJECT_ROOT, '.env');

export function loadEnvFile(): void {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvFile();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env. Run: npm run setup`);
  return v;
}

export const config = {
  get chainMode(): 'regtest' | 'signet' {
    return (process.env.CHAIN_MODE || 'regtest') as 'regtest' | 'signet';
  },
  get port(): number {
    return parseInt(process.env.PORT || '8799', 10);
  },
  get vaultWif(): string {
    return req('VAULT_WIF');
  },
  get recoveryWif(): string {
    return req('RECOVERY_WIF');
  },
  get decoyWif(): string {
    return req('DECOY_WIF');
  },
  get nostrSecretHex(): string {
    return req('NOSTR_SECRET_HEX');
  },
  get normalPin(): string {
    return req('NORMAL_PIN');
  },
  get duressPin(): string {
    return req('DURESS_PIN');
  },
  get rpcUrl(): string {
    return process.env.BITCOIND_RPC_URL || 'http://127.0.0.1:18443';
  },
  get rpcUser(): string {
    return process.env.BITCOIND_RPC_USER || 'shroudveil';
  },
  get rpcPass(): string {
    return process.env.BITCOIND_RPC_PASS || 'shroudveil-demo';
  },
  get lnbitsUrl(): string {
    return process.env.LNBITS_URL || 'http://127.0.0.1:5001';
  },
  get lnMainAdminKey(): string {
    return req('LN_MAIN_ADMINKEY');
  },
  get lnMainInKey(): string {
    return req('LN_MAIN_INKEY');
  },
  get lnDecoyAdminKey(): string {
    return req('LN_DECOY_ADMINKEY');
  },
  get lnDecoyInKey(): string {
    return req('LN_DECOY_INKEY');
  },
  get checkinWindowSec(): number {
    return parseInt(process.env.CHECKIN_WINDOW_SEC || '120', 10);
  },
  get watcherPollSec(): number {
    return parseInt(process.env.WATCHER_POLL_SEC || '10', 10);
  },
  get sweepLockBlocks(): number {
    return parseInt(process.env.SWEEP_LOCK_BLOCKS || '3', 10);
  },
  get sweepFeeSats(): number {
    return parseInt(process.env.SWEEP_FEE_SATS || '500', 10);
  },
  get nostrRelays(): string[] {
    const raw =
      process.env.NOSTR_RELAYS ||
      'wss://relay.primal.net,wss://offchain.pub,wss://relay.snort.social,wss://nos.lol';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  },
  get watcherRelays(): string[] {
    // The watcher reads from the relays proven for publish plus readback in
    // the spike. The publisher still writes to the full set above.
    const raw =
      process.env.WATCHER_RELAYS || 'wss://relay.primal.net,wss://offchain.pub';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  },
  get esploraUrl(): string {
    return process.env.ESPLORA_URL || 'https://mempool.space/signet/api';
  },
};

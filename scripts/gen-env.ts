// Generate a fresh .env with demo-only keys if one does not exist yet.
// Everything generated here is for regtest, signet, and a local FakeWallet
// LNbits instance. None of it can hold real funds. Never commit .env.
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const root = path.join(__dirname, '..', '..');
const envPath = path.join(root, '.env');

if (fs.existsSync(envPath) && fs.readFileSync(envPath, 'utf8').includes('VAULT_WIF=')) {
  console.log('.env already exists with keys, leaving it untouched');
  process.exit(0);
}

function wif(): string {
  return ECPair.makeRandom({ network: bitcoin.networks.testnet }).toWIF();
}

const nostrSk = generateSecretKey();
const lines = [
  '# ShroudVeil demo environment. Demo keys only: regtest, signet, local LNbits.',
  '# Never fund these addresses with real bitcoin. Never commit this file.',
  'CHAIN_MODE=regtest',
  'PORT=8799',
  `VAULT_WIF=${wif()}`,
  `RECOVERY_WIF=${wif()}`,
  `DECOY_WIF=${wif()}`,
  `NOSTR_SECRET_HEX=${Buffer.from(nostrSk).toString('hex')}`,
  `NOSTR_PUBKEY=${getPublicKey(nostrSk)}`,
  'NORMAL_PIN=2468',
  'DURESS_PIN=9753',
  'BITCOIND_RPC_URL=http://127.0.0.1:18443',
  'BITCOIND_RPC_USER=shroudveil',
  `BITCOIND_RPC_PASS=${crypto.randomBytes(12).toString('hex')}`,
  'LNBITS_URL=http://127.0.0.1:5001',
  'CHECKIN_WINDOW_SEC=120',
  'WATCHER_POLL_SEC=10',
  'SWEEP_LOCK_BLOCKS=3',
  'SWEEP_FEE_SATS=500',
  '',
].join('\n');

fs.writeFileSync(envPath, lines);
console.log('wrote .env with fresh demo keys');
console.log('demo PINs: normal 2468, duress 9753');

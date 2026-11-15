// One-time LNbits setup for ShroudVeil:
//   1. create the main and decoy accounts on the self-hosted LNbits
//   2. fund main with 1,000,000 sats by converting one of its own invoice
//      rows in the local ledger (the spike-proven FakeWallet funding step;
//      only possible because we operate the instance, and only ever done
//      against this local demo database)
//   3. move 5,000 sats from main to decoy through a real invoice payment,
//      so the decoy balance is genuine settled Lightning inside the instance
//   4. store the wallet keys in .env and save a setup evidence file
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ENV_PATH, PROJECT_ROOT, config } from '../src/config';

const DECOY_SATS = 5000;
const MAIN_FUND_MSAT = 1000000000; // 1,000,000 sats

async function call(method: string, p: string, key: string, body?: unknown): Promise<any> {
  const res = await fetch(config.lnbitsUrl + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LNbits ${method} ${p}: HTTP ${res.status} ${text}`);
  return JSON.parse(text);
}

function upsertEnv(values: Record<string, string>): void {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${k}=${v}`);
    else text += `${k}=${v}\n`;
  }
  fs.writeFileSync(ENV_PATH, text);
}

async function main(): Promise<void> {
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  if (existing.includes('LN_MAIN_ADMINKEY=')) {
    console.log('LNbits wallets already in .env, skipping setup');
    return;
  }

  console.log('creating main account...');
  const mainAcct = await call('POST', '/api/v1/account', '', { name: 'SV Main' });
  console.log('creating decoy account...');
  const decoyAcct = await call('POST', '/api/v1/account', '', { name: 'SV Decoy' });

  upsertEnv({
    LN_MAIN_ADMINKEY: mainAcct.adminkey,
    LN_MAIN_INKEY: mainAcct.inkey,
    LN_MAIN_WALLET_ID: mainAcct.id,
    LN_DECOY_ADMINKEY: decoyAcct.adminkey,
    LN_DECOY_INKEY: decoyAcct.inkey,
    LN_DECOY_WALLET_ID: decoyAcct.id,
  });

  console.log('creating a 1 sat invoice on main to convert into funding...');
  const fundInv = await call('POST', '/api/v1/payments', mainAcct.inkey, {
    out: false,
    amount: 1,
    memo: 'ShroudVeil demo funding row',
  });
  const dbPath = path.join(PROJECT_ROOT, 'lnbits-data', 'database.sqlite3');
  const py = [
    'import sqlite3, sys',
    'db, checking_id, amount = sys.argv[1], sys.argv[2], int(sys.argv[3])',
    'con = sqlite3.connect(db)',
    'cols = [r[1] for r in con.execute("PRAGMA table_info(apipayments)")]',
    'sets = ["amount=?"]',
    'if "pending" in cols: sets.append("pending=0")',
    'if "status" in cols: sets.append("status=\'success\'")',
    'cur = con.execute(f"UPDATE apipayments SET {\', \'.join(sets)} WHERE checking_id=?", (amount, checking_id))',
    'con.commit()',
    'print("ledger funding rows updated:", cur.rowcount)',
  ].join('\n');
  execFileSync('python3', ['-c', py, dbPath, fundInv.payment_hash, String(MAIN_FUND_MSAT)], {
    stdio: 'inherit',
  });

  const mainBal = await call('GET', '/api/v1/wallet', mainAcct.inkey);
  console.log('main balance after funding (msat):', mainBal.balance);

  console.log(`decoy creates a ${DECOY_SATS} sat invoice, main pays it...`);
  const inv = await call('POST', '/api/v1/payments', decoyAcct.inkey, {
    out: false,
    amount: DECOY_SATS,
    memo: 'ShroudVeil decoy balance',
  });
  await call('POST', '/api/v1/payments', mainAcct.adminkey, {
    out: true,
    bolt11: inv.bolt11 || inv.payment_request,
  });
  const status = await call('GET', `/api/v1/payments/${inv.payment_hash}`, decoyAcct.inkey);
  const mainAfter = await call('GET', '/api/v1/wallet', mainAcct.inkey);
  const decoyAfter = await call('GET', '/api/v1/wallet', decoyAcct.inkey);

  const evidence = {
    mainWalletId: mainAcct.id,
    decoyWalletId: decoyAcct.id,
    fundedMsat: MAIN_FUND_MSAT,
    decoyInvoiceHash: inv.payment_hash,
    decoyPaymentPaid: !!status.paid,
    mainBalanceMsat: mainAfter.balance,
    decoyBalanceMsat: decoyAfter.balance,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(PROJECT_ROOT, 'evidence'), { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_ROOT, 'evidence', 'setup-result.json'),
    JSON.stringify(evidence, null, 2)
  );
  console.log('setup evidence:', JSON.stringify(evidence, null, 2));
  if (!status.paid) throw new Error('decoy payment did not settle');
  console.log('LNbits setup complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

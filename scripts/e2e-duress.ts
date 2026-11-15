// End-to-end proof, story A: the duress PIN.
// Precondition: the stack and app are running (npm run demo) and the sweep
// is not yet armed for this run.
// Flow: fund the vault, owner checks in and arms, normal PIN shows the real
// wallet, duress PIN opens the decoy and silently fires the held sweep,
// blocks are mined past the locktime, and the recovery address ends up
// holding the vault funds. Evidence is written to evidence/e2e-duress.json.
import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_ROOT, config } from '../src/config';

const BASE = `http://127.0.0.1:${config.port}`;
const log: string[] = [];
function say(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  log.push(line);
}

async function api(method: string, p: string, token?: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-session': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${j.error || res.status}`);
  return j;
}

async function waitFor<T>(
  what: string,
  timeoutSec: number,
  fn: () => Promise<T | null>
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() - start > timeoutSec * 1000) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function main(): Promise<void> {
  const result: Record<string, unknown> = { story: 'duress' };
  const before = await api('GET', '/api/status');
  result.recoverySatsBefore = before.recoverySats;
  result.heightBefore = before.chainHeight;
  say(`start: height ${before.chainHeight}, recovery ${before.recoverySats} sats`);

  say('funding the vault with 0.5 BTC (regtest)...');
  const fund = await api('POST', '/api/demo/fund', undefined, { amountBtc: '0.5' });
  result.fundingTxid = fund.fundingTxid;
  say(`funding tx ${fund.fundingTxid}, utxos: ${JSON.stringify(fund.utxos)}`);

  // Owner is alive and well: check in first, then arm. This is also the
  // honest product order, and it keeps the watcher in HOLD during this story.
  const unlockMain = await api('POST', '/api/unlock', undefined, { pin: config.normalPin });
  const checkin = await api('POST', '/api/checkin', unlockMain.token);
  result.checkin = checkin;
  say(`check-in published: event ${checkin.eventId}, relays ok ${checkin.relaysOk}/${checkin.relaysTried}`);

  const walletMain = await api('GET', '/api/wallet', unlockMain.token);
  result.walletMain = walletMain;
  say(`normal PIN view: total ${walletMain.totalSats} sats (on chain ${walletMain.onchainSats}, lightning ${walletMain.lightningSats})`);
  if (walletMain.view !== 'main' || walletMain.onchainSats !== 50000000) {
    throw new Error('main wallet view did not show the funded vault');
  }
  await api('POST', '/api/lock', unlockMain.token);

  const armed = await api('POST', '/api/demo/arm');
  result.armed = armed;
  say(`sweep ARMED: txid ${armed.txid}, locktime ${armed.locktime}, built at height ${armed.builtAtHeight}, output ${armed.outputSats} sats`);
  if (armed.state !== 'ARMED') throw new Error('sweep did not arm');

  // The attack: duress PIN. The decoy opens; the sweep fires silently.
  const unlockDuress = await api('POST', '/api/unlock', undefined, { pin: config.duressPin });
  const walletDecoy = await api('GET', '/api/wallet', unlockDuress.token);
  result.walletDecoy = walletDecoy;
  say(`duress PIN view: total ${walletDecoy.totalSats} sats, on chain ${walletDecoy.onchainSats}`);
  if (walletDecoy.view !== 'decoy' || walletDecoy.totalSats !== 5000) {
    throw new Error('decoy view did not show the small decoy balance');
  }

  const triggered = await waitFor('sweep TRIGGERED by duress', 30, async () => {
    const s = await api('GET', '/api/status');
    return s.sweep.state === 'TRIGGERED' || s.sweep.state === 'SWEPT' ? s : null;
  });
  result.triggerSource = triggered.sweep.triggerSource;
  result.attemptsBeforeLocktime = triggered.sweep.attempts;
  say(`sweep state ${triggered.sweep.state}, source ${triggered.sweep.triggerSource}, attempts so far: ${JSON.stringify(triggered.sweep.attempts)}`);
  if (triggered.sweep.triggerSource !== 'duress') {
    throw new Error('sweep was not triggered by the duress PIN');
  }

  // Mine past the locktime; the held pre-signed transaction then broadcasts.
  for (;;) {
    const s = await api('GET', '/api/status');
    if (s.sweep.state === 'SWEPT') break;
    if (s.chainHeight <= (armed.locktime as number)) {
      await api('POST', '/api/demo/mine', undefined, { blocks: 1 });
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (s.sweep.state === 'FAILED') throw new Error('sweep FAILED');
  }
  await api('POST', '/api/demo/mine', undefined, { blocks: 1 });

  const after = await api('GET', '/api/status');
  result.sweepFinal = after.sweep;
  result.recoverySatsAfter = after.recoverySats;
  const gained = (after.recoverySats as number) - (before.recoverySats as number);
  say(`sweep SWEPT: txid ${after.sweep.txid}, recovery gained ${gained} sats`);
  if (after.sweep.state !== 'SWEPT') throw new Error('sweep did not complete');
  if (gained !== armed.outputSats) {
    throw new Error(`recovery gained ${gained}, expected ${armed.outputSats}`);
  }
  result.pass = true;
  result.log = log;
  fs.writeFileSync(
    path.join(PROJECT_ROOT, 'evidence', 'e2e-duress.json'),
    JSON.stringify(result, null, 2)
  );
  say('PASS: duress story proven end to end');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

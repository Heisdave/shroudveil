// End-to-end proof, story B: the dead-man's switch.
// Precondition: the stack and app are running (npm run demo). Run after the
// duress story, or on any armed-capable stack.
// Flow: fund the vault, owner checks in, owner arms the sweep, the watcher
// sees the fresh check-in and HOLDs. The owner then stops checking in. After
// the safety window lapses the watcher FIREs on its own and broadcasts the
// held pre-signed sweep. Blocks are mined past the locktime and the recovery
// address ends up holding the funds. Evidence: evidence/e2e-deadman.json.
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

const sleep = (sec: number) => new Promise((r) => setTimeout(r, sec * 1000));

async function main(): Promise<void> {
  const result: Record<string, unknown> = { story: 'deadman', windowSec: config.checkinWindowSec };
  const before = await api('GET', '/api/status');
  result.recoverySatsBefore = before.recoverySats;
  say(`start: height ${before.chainHeight}, recovery ${before.recoverySats} sats, window ${config.checkinWindowSec}s`);

  say('funding the vault with 0.5 BTC (regtest)...');
  const fund = await api('POST', '/api/demo/fund', undefined, { amountBtc: '0.5' });
  result.fundingTxid = fund.fundingTxid;
  say(`funding tx ${fund.fundingTxid}`);

  // Owner checks in while alive, then arms. The watcher must HOLD.
  const unlock = await api('POST', '/api/unlock', undefined, { pin: config.normalPin });
  const checkin = await api('POST', '/api/checkin', unlock.token);
  result.checkin = checkin;
  say(`check-in published: event ${checkin.eventId}, relays ok ${checkin.relaysOk}/${checkin.relaysTried}`);
  await api('POST', '/api/lock', unlock.token);

  const armed = await api('POST', '/api/demo/arm');
  result.armed = armed;
  say(`sweep ARMED: txid ${armed.txid}, locktime ${armed.locktime}`);
  if (armed.state !== 'ARMED') throw new Error('sweep did not arm');

  const holdDeadline = Date.now() + 150000;
  for (;;) {
    const s = await api('GET', '/api/status');
    if (s.watcher.lastDecision === 'HOLD') {
      result.holdSeen = s.watcher;
      say(`watcher HOLD: ${s.watcher.lastReason}`);
      break;
    }
    if (Date.now() > holdDeadline) throw new Error('watcher never reached HOLD');
    await sleep(5);
  }

  // The owner goes silent. No more check-ins.
  say('owner stops checking in. Waiting for the window to lapse and the watcher to fire...');
  const fireDeadline = Date.now() + (config.checkinWindowSec + 240) * 1000;
  for (;;) {
    const s = await api('GET', '/api/status');
    if (s.sweep.state === 'TRIGGERED' || s.sweep.state === 'SWEPT') {
      result.triggerSource = s.sweep.triggerSource;
      result.watcherAtFire = s.watcher;
      say(`sweep ${s.sweep.state}, source ${s.sweep.triggerSource}, watcher said: ${s.watcher.lastReason}`);
      break;
    }
    if (Date.now() > fireDeadline) throw new Error('watcher never fired');
    await sleep(8);
  }
  if (result.triggerSource !== 'watcher') {
    throw new Error('sweep was not triggered by the watcher');
  }

  for (;;) {
    const s = await api('GET', '/api/status');
    if (s.sweep.state === 'SWEPT') break;
    if (s.sweep.state === 'FAILED') throw new Error('sweep FAILED');
    if (s.chainHeight <= (armed.locktime as number)) {
      await api('POST', '/api/demo/mine', undefined, { blocks: 1 });
    } else {
      await sleep(3);
    }
  }
  await api('POST', '/api/demo/mine', undefined, { blocks: 1 });

  const after = await api('GET', '/api/status');
  result.sweepFinal = after.sweep;
  result.recoverySatsAfter = after.recoverySats;
  const gained = (after.recoverySats as number) - (before.recoverySats as number);
  say(`sweep SWEPT: txid ${after.sweep.txid}, recovery gained ${gained} sats`);
  if (gained !== armed.outputSats) {
    throw new Error(`recovery gained ${gained}, expected ${armed.outputSats}`);
  }

  const logPath = path.join(PROJECT_ROOT, 'data', 'watcher-log.jsonl');
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    result.watcherLogTail = lines.slice(-8).map((l) => JSON.parse(l));
  }
  result.pass = true;
  result.log = log;
  fs.writeFileSync(
    path.join(PROJECT_ROOT, 'evidence', 'e2e-deadman.json'),
    JSON.stringify(result, null, 2)
  );
  say('PASS: dead-man story proven end to end');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

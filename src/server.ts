import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { RegtestChain, getChain } from './chain';
import { PROJECT_ROOT, config } from './config';
import { loadKeys } from './keys';
import { LnbitsClient } from './lnbits';
import { nostrPubkey, publishCheckin } from './nostr';
import { SweepService } from './sweep';
import { Watcher } from './watcher';

const chain = getChain();
const sweep = new SweepService(chain);
const watcher = new Watcher(sweep);
const ln = new LnbitsClient();

type View = 'main' | 'decoy';
const sessions = new Map<string, View>();

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sessionView(req: http.IncomingMessage): View | null {
  const token = req.headers['x-session'];
  if (typeof token !== 'string') return null;
  return sessions.get(token) || null;
}

async function walletView(view: View) {
  const keys = loadKeys();
  if (view === 'main') {
    const [vaultSats, lnSats] = await Promise.all([
      chain.getBalanceSats(keys.vaultAddress),
      ln.balanceSats('main'),
    ]);
    return {
      view,
      totalSats: vaultSats + lnSats,
      lightningSats: lnSats,
      onchainSats: vaultSats,
      onchainAddress: keys.vaultAddress,
    };
  }
  // Decoy: same shape, same rows. Its on-chain address is real but unfunded,
  // and its Lightning balance is the small decoy balance. Nothing on this
  // screen reveals that another wallet exists.
  const lnSats = await ln.balanceSats('decoy');
  return {
    view,
    totalSats: lnSats,
    lightningSats: lnSats,
    onchainSats: 0,
    onchainAddress: keys.decoyAddress,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && p === '/api/unlock') {
      const body = await readBody(req);
      const pin = String(body.pin || '');
      let view: View | null = null;
      if (pin === config.normalPin) view = 'main';
      else if (pin === config.duressPin) view = 'decoy';
      if (!view) return json(res, 401, { error: 'Wrong PIN' });
      if (view === 'decoy') {
        // The silent half of the duress story: fire the held sweep. The
        // response below is identical in shape to a normal unlock.
        sweep.trigger('duress');
      }
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, view);
      return json(res, 200, { token, view });
    }

    if (req.method === 'POST' && p === '/api/lock') {
      const token = req.headers['x-session'];
      if (typeof token === 'string') sessions.delete(token);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/wallet') {
      const view = sessionView(req);
      if (!view) return json(res, 401, { error: 'Locked' });
      return json(res, 200, await walletView(view));
    }

    if (req.method === 'POST' && p === '/api/checkin') {
      const view = sessionView(req);
      if (!view) return json(res, 401, { error: 'Locked' });
      const result = await publishCheckin();
      return json(res, 200, { ok: result.relaysOk > 0, ...result });
    }

    if (req.method === 'GET' && p === '/api/status') {
      const keys = loadKeys();
      const sweepState = sweep.publicState();
      const recoverySats = await chain
        .getBalanceSats(keys.recoveryAddress)
        .catch(() => null);
      return json(res, 200, {
        app: 'ShroudVeil',
        chainMode: config.chainMode,
        chainHeight: await chain.getHeight().catch(() => null),
        vaultAddress: keys.vaultAddress,
        recoveryAddress: keys.recoveryAddress,
        recoverySats,
        nostrPubkey: nostrPubkey(),
        checkinWindowSec: config.checkinWindowSec,
        watcher: watcher.getStatus(),
        sweep: sweepState,
        explorerTxUrl:
          sweepState.txid && chain.explorerTxUrl(sweepState.txid)
            ? chain.explorerTxUrl(sweepState.txid)
            : sweepState.txid
              ? `local regtest txid ${sweepState.txid} (no public explorer)`
              : null,
      });
    }

    // Demo helpers: local proof tooling only. On regtest, Core is the coin
    // source and the block source, so funding and mining live here.
    if (req.method === 'POST' && p === '/api/demo/fund') {
      if (!(chain instanceof RegtestChain)) {
        return json(res, 400, { error: 'Funding helper exists on regtest only' });
      }
      const body = await readBody(req);
      const keys = loadKeys();
      const txid = await chain.fundAddress(keys.vaultAddress, String(body.amountBtc || '0.5'));
      const utxos = await chain.getUtxos(keys.vaultAddress);
      return json(res, 200, { fundingTxid: txid, utxos });
    }

    if (req.method === 'POST' && p === '/api/demo/arm') {
      await sweep.arm();
      return json(res, 200, sweep.publicState());
    }

    if (req.method === 'POST' && p === '/api/demo/mine') {
      if (!(chain instanceof RegtestChain)) {
        return json(res, 400, { error: 'Mining helper exists on regtest only' });
      }
      const body = await readBody(req);
      await chain.mine(Math.max(1, Math.min(20, parseInt(body.blocks || '1', 10))));
      return json(res, 200, { height: await chain.getHeight() });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e: any) {
    return json(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(config.port, () => {
  watcher.start();
  console.log(`ShroudVeil listening on http://127.0.0.1:${config.port}`);
  console.log(`chain mode: ${config.chainMode}, watcher window: ${config.checkinWindowSec}s`);
});

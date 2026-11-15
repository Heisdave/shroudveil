import { config } from './config';
import { loadKeys, scriptOf } from './keys';

export interface Utxo {
  txid: string;
  vout: number;
  value: number; // sats
  scriptPubKey: string; // hex
  height?: number;
}

export interface ChainAdapter {
  mode: 'regtest' | 'signet';
  getHeight(): Promise<number>;
  getUtxos(address: string): Promise<Utxo[]>;
  getBalanceSats(address: string): Promise<number>;
  broadcast(hex: string): Promise<string>; // resolves txid, rejects with node error message
  explorerTxUrl(txid: string): string | null;
}

// ---------------------------------------------------------------------------
// Regtest backend: Bitcoin Core JSON-RPC over HTTP.
// Core is the block source and (for the local demo only) the coin source.
// All wallet keys live in this app, never in Core.
// ---------------------------------------------------------------------------
export class RegtestChain implements ChainAdapter {
  mode = 'regtest' as const;

  private async rpc(method: string, params: unknown[] = [], wallet?: string): Promise<any> {
    const url = config.rpcUrl + (wallet ? `/wallet/${wallet}` : '');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization:
          'Basic ' + Buffer.from(`${config.rpcUser}:${config.rpcPass}`).toString('base64'),
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'shroudveil', method, params }),
    });
    const body = (await res.json()) as any;
    if (body.error) {
      const err = new Error(body.error.message || 'RPC error');
      (err as any).code = body.error.code;
      throw err;
    }
    return body.result;
  }

  async getHeight(): Promise<number> {
    return this.rpc('getblockcount');
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    const scan = await this.rpc('scantxoutset', [
      'start',
      [{ desc: `addr(${address})` }],
    ]);
    return (scan.unspents || []).map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      value: Math.round(u.amount * 1e8),
      scriptPubKey: u.scriptPubKey,
      height: u.height,
    }));
  }

  async getBalanceSats(address: string): Promise<number> {
    const utxos = await this.getUtxos(address);
    return utxos.reduce((a, u) => a + u.value, 0);
  }

  async broadcast(hex: string): Promise<string> {
    return this.rpc('sendrawtransaction', [hex]);
  }

  explorerTxUrl(): string | null {
    return null; // local regtest has no public explorer
  }

  // Demo-only helpers (coin source and block production on the local node).
  async ensureFaucetWallet(): Promise<void> {
    const wallets: string[] = await this.rpc('listwallets');
    if (wallets.includes('faucet')) return;
    try {
      await this.rpc('createwallet', ['faucet']);
    } catch {
      await this.rpc('loadwallet', ['faucet']);
    }
  }

  async mine(n: number): Promise<void> {
    await this.ensureFaucetWallet();
    const addr: string = await this.rpc('getnewaddress', [], 'faucet');
    await this.rpc('generatetoaddress', [n, addr]);
  }

  async fundAddress(address: string, amountBtc: string): Promise<string> {
    await this.ensureFaucetWallet();
    const height = await this.getHeight();
    if (height < 101) await this.mine(101 - height);
    const txid: string = await this.rpc('sendtoaddress', [address, amountBtc], 'faucet');
    await this.mine(1);
    return txid;
  }
}

// ---------------------------------------------------------------------------
// Signet backend: mempool.space Esplora API. Same adapter shape; this path is
// complete and activates as soon as the vault address holds a funded UTXO.
// ---------------------------------------------------------------------------
export class SignetChain implements ChainAdapter {
  mode = 'signet' as const;

  private async get(path: string): Promise<any> {
    const res = await fetch(config.esploraUrl + path);
    if (!res.ok) throw new Error(`Esplora GET ${path} failed: HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getHeight(): Promise<number> {
    const h = await this.get('/blocks/tip/height');
    return typeof h === 'number' ? h : parseInt(String(h), 10);
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    const keys = loadKeys();
    const script = scriptOf(keys.vault, 'signet').toString('hex');
    const rows = (await this.get(`/address/${address}/utxo`)) as any[];
    return rows.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      scriptPubKey: script,
      height: u.status && u.status.block_height,
    }));
  }

  async getBalanceSats(address: string): Promise<number> {
    const utxos = await this.getUtxos(address);
    return utxos.reduce((a, u) => a + u.value, 0);
  }

  async broadcast(hex: string): Promise<string> {
    const res = await fetch(config.esploraUrl + '/tx', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: hex,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `Esplora broadcast failed: HTTP ${res.status}`);
    return text.trim();
  }

  explorerTxUrl(txid: string): string | null {
    return `https://mempool.space/signet/tx/${txid}`;
  }
}

export function getChain(): ChainAdapter {
  return config.chainMode === 'signet' ? new SignetChain() : new RegtestChain();
}

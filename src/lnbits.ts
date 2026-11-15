import { config } from './config';

// Thin LNbits API client for the self-hosted instance (FakeWallet backend),
// the deployment proven in the spike. Main and decoy are two separate LNbits
// accounts, created by scripts/setup.ts; their keys live in .env.
export class LnbitsClient {
  private async call(
    method: string,
    path: string,
    apiKey: string,
    body?: unknown
  ): Promise<any> {
    const res = await fetch(config.lnbitsUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    if (!res.ok) {
      throw new Error(
        `LNbits ${method} ${path} failed: HTTP ${res.status} ${parsed?.detail || text}`
      );
    }
    return parsed;
  }

  async balanceSats(which: 'main' | 'decoy'): Promise<number> {
    const key = which === 'main' ? config.lnMainInKey : config.lnDecoyInKey;
    const w = await this.call('GET', '/api/v1/wallet', key);
    return Math.floor((w.balance as number) / 1000);
  }

  async createInvoice(
    which: 'main' | 'decoy',
    amountSats: number,
    memo: string
  ): Promise<{ paymentHash: string; bolt11: string }> {
    const key = which === 'main' ? config.lnMainInKey : config.lnDecoyInKey;
    const inv = await this.call('POST', '/api/v1/payments', key, {
      out: false,
      amount: amountSats,
      memo,
    });
    return { paymentHash: inv.payment_hash, bolt11: inv.bolt11 || inv.payment_request };
  }

  async payInvoice(
    which: 'main' | 'decoy',
    bolt11: string
  ): Promise<{ paymentHash: string }> {
    const key = which === 'main' ? config.lnMainAdminKey : config.lnDecoyAdminKey;
    const pay = await this.call('POST', '/api/v1/payments', key, { out: true, bolt11 });
    return { paymentHash: pay.payment_hash };
  }

  async paymentPaid(which: 'main' | 'decoy', paymentHash: string): Promise<boolean> {
    const key = which === 'main' ? config.lnMainInKey : config.lnDecoyInKey;
    const st = await this.call('GET', `/api/v1/payments/${paymentHash}`, key);
    return !!st.paid;
  }

  /** Used by setup: create a fresh account plus its first wallet. */
  async createAccount(name: string): Promise<any> {
    return this.call('POST', '/api/v1/account', '', { name });
  }
}

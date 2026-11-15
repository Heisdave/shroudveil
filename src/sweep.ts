import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import * as fs from 'fs';
import * as path from 'path';
import { ChainAdapter, Utxo } from './chain';
import { DATA_DIR, config } from './config';
import { loadKeys, networkFor } from './keys';

export type SweepStateName = 'UNARMED' | 'ARMED' | 'TRIGGERED' | 'SWEPT' | 'FAILED';
export type TriggerSource = 'duress' | 'watcher';

export interface BroadcastAttempt {
  at: string;
  height: number;
  ok: boolean;
  error?: string;
}

export interface SweepState {
  state: SweepStateName;
  mode: string;
  vaultAddress: string;
  recoveryAddress: string;
  utxo: Utxo | null;
  locktime: number | null;
  builtAtHeight: number | null;
  outputSats: number | null;
  feeSats: number | null;
  txid: string | null;
  hex: string | null;
  armedAt: string | null;
  triggeredAt: string | null;
  triggerSource: TriggerSource | null;
  attempts: BroadcastAttempt[];
  sweptAt: string | null;
}

const STATE_PATH = path.join(DATA_DIR, 'sweep.json');

const emptyState = (): SweepState => ({
  state: 'UNARMED',
  mode: config.chainMode,
  vaultAddress: '',
  recoveryAddress: '',
  utxo: null,
  locktime: null,
  builtAtHeight: null,
  outputSats: null,
  feeSats: null,
  txid: null,
  hex: null,
  armedAt: null,
  triggeredAt: null,
  triggerSource: null,
  attempts: [],
  sweptAt: null,
});

export class SweepService {
  private state: SweepState;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private chain: ChainAdapter) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATE_PATH)) {
      try {
        this.state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      } catch {
        this.state = emptyState();
      }
    } else {
      this.state = emptyState();
    }
    // If the process restarted mid-trigger, resume trying to broadcast.
    if (this.state.state === 'TRIGGERED') this.startRetryLoop();
  }

  private save(): void {
    fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2));
  }

  getState(): SweepState {
    return this.state;
  }

  /** Public view: everything except the signed hex itself. */
  publicState() {
    const { hex, ...rest } = this.state;
    return { ...rest, hexHeld: !!hex };
  }

  /**
   * Build and PRE-SIGN the sweep: largest vault UTXO to the recovery address,
   * nLockTime = current height + SWEEP_LOCK_BLOCKS, sequence 0xfffffffe so the
   * locktime is honoured. The signed hex is held in state, never broadcast
   * until a trigger fires. This is the spike-proven construction.
   */
  async arm(): Promise<SweepState> {
    if (this.state.state === 'ARMED' || this.state.state === 'TRIGGERED') {
      return this.state;
    }
    const keys = loadKeys();
    const mode = config.chainMode;
    const height = await this.chain.getHeight();
    const utxos = await this.chain.getUtxos(keys.vaultAddress);
    if (!utxos.length) {
      throw new Error(
        `No funded UTXO at the vault address ${keys.vaultAddress} on ${mode}. ` +
          (mode === 'regtest'
            ? 'Fund it first (POST /api/demo/fund).'
            : 'The signet path activates once a faucet funds this address.')
      );
    }
    const utxo = [...utxos].sort((a, b) => b.value - a.value)[0];
    const fee = config.sweepFeeSats;
    if (utxo.value <= fee) throw new Error('Vault UTXO is too small to cover the sweep fee.');
    const locktime = height + config.sweepLockBlocks;

    const psbt = new bitcoin.Psbt({ network: networkFor(mode) });
    psbt.setLocktime(locktime);
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: Buffer.from(utxo.scriptPubKey, 'hex'),
        value: BigInt(utxo.value),
      },
      sequence: 0xfffffffe, // required for nLockTime to be honoured
    });
    psbt.addOutput({ address: keys.recoveryAddress, value: BigInt(utxo.value - fee) });
    psbt.signInput(0, keys.vault as any);
    const valid = psbt.validateSignaturesOfInput(
      0,
      (pubkey: any, msghash: any, signature: any) =>
        ecc.verify(msghash, pubkey, signature)
    );
    if (!valid) throw new Error('Sweep signature failed local validation.');
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();

    this.state = {
      state: 'ARMED',
      mode,
      vaultAddress: keys.vaultAddress,
      recoveryAddress: keys.recoveryAddress,
      utxo,
      locktime,
      builtAtHeight: height,
      outputSats: utxo.value - fee,
      feeSats: fee,
      txid: tx.getId(),
      hex: tx.toHex(),
      armedAt: new Date().toISOString(),
      triggeredAt: null,
      triggerSource: null,
      attempts: [],
      sweptAt: null,
    };
    this.save();
    return this.state;
  }

  /** Fire the held sweep. Idempotent: only the first trigger counts. */
  trigger(source: TriggerSource): SweepState {
    if (this.state.state === 'ARMED') {
      this.state.state = 'TRIGGERED';
      this.state.triggeredAt = new Date().toISOString();
      this.state.triggerSource = source;
      this.save();
      this.startRetryLoop();
    }
    return this.state;
  }

  private startRetryLoop(): void {
    if (this.retryTimer) return;
    const attempt = async () => {
      if (this.state.state !== 'TRIGGERED') {
        this.stopRetryLoop();
        return;
      }
      await this.attemptBroadcast();
      if (this.state.state === 'TRIGGERED' && this.state.attempts.length >= 180) {
        this.state.state = 'FAILED';
        this.save();
        this.stopRetryLoop();
      }
    };
    void attempt();
    this.retryTimer = setInterval(attempt, 4000);
  }

  private stopRetryLoop(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * One broadcast attempt of the held pre-signed hex. Before the locktime the
   * network rejects it as non-final; the state machine records that honestly
   * and keeps retrying, exactly as proven in the spike.
   */
  async attemptBroadcast(): Promise<BroadcastAttempt> {
    const height = await this.chain.getHeight().catch(() => -1);
    try {
      const txid = await this.chain.broadcast(this.state.hex as string);
      const rec: BroadcastAttempt = { at: new Date().toISOString(), height, ok: true };
      this.state.attempts.push(rec);
      this.state.state = 'SWEPT';
      this.state.txid = txid;
      this.state.sweptAt = new Date().toISOString();
      this.save();
      this.stopRetryLoop();
      return rec;
    } catch (e: any) {
      const rec: BroadcastAttempt = {
        at: new Date().toISOString(),
        height,
        ok: false,
        error: String(e && e.message ? e.message : e),
      };
      this.state.attempts.push(rec);
      this.save();
      return rec;
    }
  }
}

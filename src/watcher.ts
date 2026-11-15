import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, config } from './config';
import { fetchLatestCheckin } from './nostr';
import { SweepService } from './sweep';

export type WatcherDecision = 'HOLD' | 'FIRE' | 'UNKNOWN' | 'IDLE';

export interface WatcherStatus {
  running: boolean;
  windowSec: number;
  pollSec: number;
  lastPollAt: string | null;
  lastDecision: WatcherDecision;
  lastReason: string;
  lastCheckAgeSec: number | null;
  lastEventId: string | null;
}

const LOG_PATH = path.join(DATA_DIR, 'watcher-log.jsonl');

/**
 * The dead-man's switch. While the sweep is ARMED it polls the relays for
 * the newest signed check-in:
 *   fresh and signature valid  -> HOLD (owner alive)
 *   stale, missing, or invalid -> FIRE (broadcast the held sweep)
 *   relays unreachable         -> UNKNOWN, and it holds. A network outage is
 *                                 not proof of death, so it never fires blind.
 */
export class Watcher {
  private timer: NodeJS.Timeout | null = null;
  private status: WatcherStatus = {
    running: false,
    windowSec: config.checkinWindowSec,
    pollSec: config.watcherPollSec,
    lastPollAt: null,
    lastDecision: 'IDLE',
    lastReason: 'watcher not started',
    lastCheckAgeSec: null,
    lastEventId: null,
  };

  constructor(private sweep: SweepService) {}

  start(): void {
    if (this.timer) return;
    this.status.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), config.watcherPollSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.running = false;
  }

  getStatus(): WatcherStatus {
    return this.status;
  }

  private log(entry: Record<string, unknown>): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  }

  async poll(): Promise<WatcherStatus> {
    this.status.lastPollAt = new Date().toISOString();
    const sweepState = this.sweep.getState().state;
    if (sweepState !== 'ARMED') {
      this.status.lastDecision = 'IDLE';
      this.status.lastReason = `sweep is ${sweepState}, nothing to guard`;
      return this.status;
    }
    const latest = await fetchLatestCheckin();
    if (latest.error) {
      this.status.lastDecision = 'UNKNOWN';
      this.status.lastReason = `relay check failed: ${latest.error}`;
      this.log({ decision: 'UNKNOWN', reason: this.status.lastReason });
      return this.status;
    }
    if (!latest.found) {
      this.status.lastDecision = 'FIRE';
      this.status.lastReason = 'no check-in found on any relay';
      this.status.lastCheckAgeSec = null;
      this.log({ decision: 'FIRE', reason: this.status.lastReason });
      this.sweep.trigger('watcher');
      return this.status;
    }
    this.status.lastCheckAgeSec = latest.ageSec ?? null;
    this.status.lastEventId = latest.eventId ?? null;
    if (!latest.signatureValid) {
      this.status.lastDecision = 'FIRE';
      this.status.lastReason = 'latest check-in has an invalid signature';
      this.log({
        decision: 'FIRE',
        reason: this.status.lastReason,
        eventId: latest.eventId,
      });
      this.sweep.trigger('watcher');
      return this.status;
    }
    if ((latest.ageSec ?? Infinity) > config.checkinWindowSec) {
      this.status.lastDecision = 'FIRE';
      this.status.lastReason = `check-in is ${latest.ageSec}s old, window is ${config.checkinWindowSec}s`;
      this.log({
        decision: 'FIRE',
        reason: this.status.lastReason,
        eventId: latest.eventId,
        ageSec: latest.ageSec,
      });
      this.sweep.trigger('watcher');
      return this.status;
    }
    this.status.lastDecision = 'HOLD';
    this.status.lastReason = `check-in is ${latest.ageSec}s old, inside the ${config.checkinWindowSec}s window`;
    this.log({
      decision: 'HOLD',
      reason: this.status.lastReason,
      eventId: latest.eventId,
      ageSec: latest.ageSec,
    });
    return this.status;
  }
}

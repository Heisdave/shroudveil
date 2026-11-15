import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools';
import { config } from './config';
import { setupWebSocket } from './ws-setup';

// Subpath imports resolve at runtime through the package exports map; the
// classic TS node resolution cannot see their types, so require them here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SimplePool } = require('nostr-tools/pool');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Relay } = require('nostr-tools/relay');

setupWebSocket();

export const CHECKIN_KIND = 30078;
export const CHECKIN_TAG = 'shroudveil-checkin';

export function nostrPubkey(): string {
  const sk = Uint8Array.from(Buffer.from(config.nostrSecretHex, 'hex'));
  return getPublicKey(sk);
}

export interface CheckinResult {
  eventId: string;
  relaysOk: number;
  relaysTried: number;
}

/** The phone side: sign and publish a check-in to every configured relay.
 *  Any one success counts as a valid check-in (spike finding). */
export async function publishCheckin(): Promise<CheckinResult> {
  const sk = Uint8Array.from(Buffer.from(config.nostrSecretHex, 'hex'));
  const event = finalizeEvent(
    {
      kind: CHECKIN_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', CHECKIN_TAG],
        ['t', CHECKIN_TAG],
      ],
      content: JSON.stringify({ type: 'checkin', app: 'shroudveil', status: 'alive' }),
    },
    sk
  );
  let ok = 0;
  for (const url of config.nostrRelays) {
    try {
      const relay = new Relay(url);
      relay.connectionTimeout = 15000;
      relay.publishTimeout = 15000;
      await relay.connect();
      await relay.publish(event);
      ok++;
      relay.close();
    } catch {
      /* one relay failing never blocks a check-in */
    }
  }
  return { eventId: event.id, relaysOk: ok, relaysTried: config.nostrRelays.length };
}

export interface LatestCheckin {
  found: boolean;
  eventId?: string;
  createdAt?: number;
  ageSec?: number;
  signatureValid?: boolean;
  relaysQueried: number;
  error?: string;
}

/** The watcher side: read the newest check-in back from the relay set,
 *  verify its Schnorr signature, and report its age. A relay failure returns
 *  found=false with an error, and the watcher treats that as UNKNOWN, never
 *  as proof of death. */
export async function fetchLatestCheckin(
  relayOverride?: string[]
): Promise<LatestCheckin> {
  const relays = relayOverride || config.watcherRelays;
  const pool = new SimplePool();
  try {
    const query = pool.querySync(relays, {
      kinds: [CHECKIN_KIND],
      authors: [nostrPubkey()],
      '#d': [CHECKIN_TAG],
    });
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('relay query timed out')), 25000)
    );
    const events = await Promise.race([query, timeout]);
    if (!events.length) {
      return { found: false, relaysQueried: relays.length };
    }
    const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
    const latest = sorted[0];
    const sigOk = verifyEvent(latest as any);
    return {
      found: true,
      eventId: latest.id,
      createdAt: latest.created_at,
      ageSec: Math.floor(Date.now() / 1000) - latest.created_at,
      signatureValid: sigOk,
      relaysQueried: relays.length,
    };
  } catch (e: any) {
    return {
      found: false,
      relaysQueried: relays.length,
      error: String(e && e.message ? e.message : e),
    };
  } finally {
    try {
      pool.close(relays);
    } catch {
      /* ignore */
    }
  }
}

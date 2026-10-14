/**
 * The status bar's connection light, worked out from the desk's own polled reads (book and ticker). There is no
 * separate socket yet (the WebSocket the old desk tried answers 503 on the local stack), so "connected" means
 * "the scheduler is getting answers". `data/poll.ts` keeps the last good answer on screen for a while after
 * failures; the age of that answer is what tells a fresh feed from a stale one.
 */
import type { Loadable } from '../../../data/types';

export type ConnectionState = 'connecting' | 'live' | 'delayed' | 'reconnecting';

/** The slowest read here (the ticker) polls every 5 s, plus up to 20% jitter and the 2 s tick that checks; past 12 s something is late. */
export const DELAYED_AFTER_MS = 12_000;

/**
 * - any read failed (`error`) and has no good answer left -> reconnecting
 * - every read has an answer, the oldest is within `DELAYED_AFTER_MS` -> live
 * - answers exist but the oldest is older than that -> delayed
 * - still waiting for the first answers -> connecting
 */
export function connectionOf(reads: ReadonlyArray<Loadable<unknown>>, now: number): ConnectionState {
  if (reads.some((read) => read.status === 'error')) return 'reconnecting';
  // A refusal (signed out, market closed) is an answer from the service, not a lost connection.
  const ready = reads.filter((read): read is Extract<Loadable<unknown>, { status: 'ready' }> => read.status === 'ready');
  if (ready.length === 0) return reads.some((read) => read.status === 'refused') ? 'live' : 'connecting';
  const oldest = Math.min(...ready.map((read) => read.asOf));
  return now - oldest > DELAYED_AFTER_MS ? 'delayed' : 'live';
}

/**
 * The service's clock minus ours, from a book snapshot: the snapshot's own timestamp against the moment we received
 * it. The error is one network round trip, which is fine for a clock shown to the second. Null when it cannot be
 * trusted (no snapshot, or a gap over a day, which would be a wrong clock or a frozen book rather than skew).
 */
export function clockOffsetMs(serverTimestamp: number | null | undefined, receivedAt: number | null | undefined): number | null {
  if (typeof serverTimestamp !== 'number' || typeof receivedAt !== 'number') return null;
  if (!Number.isFinite(serverTimestamp) || !Number.isFinite(receivedAt)) return null;
  const offset = serverTimestamp - receivedAt;
  return Math.abs(offset) > 24 * 3_600_000 ? null : offset;
}

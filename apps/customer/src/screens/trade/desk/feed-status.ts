/**
 * What the data status chip says, apart from React so it can be tested. Every stream is judged on its own: there is no
 * single "connected" flag (a book can be fresh while the order list failed). The desk polls, so a stream is "old"
 * when its last good answer is older than its own polling interval allows, not when a socket drops.
 */
import type { Loadable } from './deps';

export type StreamId = 'session' | 'book' | 'ticker' | 'orders' | 'balances';
/** ok = fresh; old = last good answer is stale; down = the last read failed; loading = no answer yet; off = needs sign-in. */
export type StreamState = 'ok' | 'old' | 'down' | 'loading' | 'off';
export interface Stream {
  id: StreamId;
  state: StreamState;
  /** Age in whole seconds of the last good answer, when there is one. */
  ageSeconds: number | null;
}
export type Overall = 'ok' | 'delayed' | 'problem';

/**
 * How long a stream's last good answer may be before it is called old: two polling intervals and a second of slack, so a
 * single missed poll shows at once. (The data layer keeps showing the last good answer for three intervals before it
 * reports an error, so without this a failed read would look healthy until then.)
 */
export const staleAfterMs = (intervalMs: number): number => intervalMs * 2 + 1_000;

export function streamOf(
  id: StreamId,
  load: Loadable<unknown>,
  args: {
    now: number;
    intervalMs: number;
    signedIn?: boolean;
    privateRead?: boolean;
    /** The time the SERVICE stamped the data with (the book's snapshot time), judged against `stampStaleMs` as well. */
    stampedAt?: number;
    stampStaleMs?: number;
  },
): Stream {
  if (args.privateRead && !args.signedIn) return { id, state: 'off', ageSeconds: null };
  if (load.status === 'loading' || load.status === 'empty') return { id, state: 'loading', ageSeconds: null };
  if (load.status === 'refused') return { id, state: load.code === 'auth.required' ? 'off' : 'down', ageSeconds: null };
  if (load.status === 'error') return { id, state: 'down', ageSeconds: null };
  const polled = Math.max(0, args.now - load.asOf);
  const stamped = args.stampedAt === undefined ? 0 : Math.max(0, args.now - args.stampedAt);
  const old = polled >= staleAfterMs(args.intervalMs) || (args.stampStaleMs !== undefined && stamped >= args.stampStaleMs);
  return { id, state: old ? 'old' : 'ok', ageSeconds: Math.floor(Math.max(polled, stamped) / 1000) };
}

export function overall(streams: readonly Stream[]): Overall {
  if (streams.some((stream) => stream.state === 'down')) return 'problem';
  if (streams.some((stream) => stream.state === 'old')) return 'delayed';
  return 'ok';
}

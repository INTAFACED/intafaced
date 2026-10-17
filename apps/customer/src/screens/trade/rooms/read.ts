/**
 * Polled reads for the rooms, through the tab's one scheduler (`data/poll.ts`): identical requests are shared, polling
 * pauses while the tab is hidden, and a failure keeps the last good answer for a while. Private reads are keyed by the
 * signed-in user so one person's rows can never show for another.
 */
import { useEffect, useMemo, useState } from 'react';
import { constantSource, type Source } from '../../../data/source';
import type { Fetcher } from '../../../data/poll';
import { useDataEnv, useSource, type Loadable } from './ui';
import { createRoomApi, type RoomApi } from './api';
import { useSession } from './ui';

export const ROOM_INTERVALS = {
  policy: 60_000,
  markets: 300_000,
  deskStatus: 30_000,
  progress: 10_000,
  quote: 5_000,
} as const;

/** After this long without a good answer a polled region is called stale (three missed polls at the slowest room cadence). */
export const STALE_AFTER_MS = 45_000;

const SIGNED_OUT: Loadable<never> = { status: 'refused', code: 'auth.required' };
const OFF: Loadable<never> = { status: 'empty' };

export function useRoomApi(): RoomApi {
  const { api } = useSession();
  return useMemo(() => createRoomApi(api), [api]);
}

/** A public read (no sign-in needed). `enabled` false stops all polling. */
export function usePublicRead<T>(
  key: string,
  load: (signal: AbortSignal) => ReturnType<Fetcher<T>>,
  intervalMs: number,
  enabled = true,
): Loadable<T> {
  const env = useDataEnv();
  const source = useMemo<Source<T>>(
    () => (enabled ? env.poller.source<T>(key, load, { intervalMs }) : (constantSource(OFF) as Source<T>)),
    // `load` closes over stable inputs the caller put in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env, key, intervalMs, enabled],
  );
  return useSource(source);
}

/** A read that needs a signed-in user. Signed out is a typed refusal, never an empty list. */
export function usePrivateRead<T>(
  key: string,
  load: (signal: AbortSignal) => ReturnType<Fetcher<T>>,
  intervalMs: number,
  enabled = true,
): Loadable<T> {
  const env = useDataEnv();
  const source = useMemo<Source<T>>(() => {
    if (!env.userId) return constantSource(SIGNED_OUT) as Source<T>;
    if (!enabled) return constantSource(OFF) as Source<T>;
    return env.poller.source<T>(`${key}:${env.userId}`, load, { intervalMs });
  }, [env, key, intervalMs, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return useSource(source);
}

/** Re-render on a timer, for things that age (a countdown, a staleness chip). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The time of the newest good answer, for the freshness chip. */
export function asOfOf(value: Loadable<unknown>): number | null {
  return value.status === 'ready' ? value.asOf : null;
}

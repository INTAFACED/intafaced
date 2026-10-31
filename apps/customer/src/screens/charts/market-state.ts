// hand-declared-ok: svc-trade has no browser-safe schema in packages/contracts for the market lifecycle, the book halt, the clock or the public tape answer.
/**
 * The reads the chart's data status needs beyond the candles: the market's lifecycle state (svc-trade's
 * `/market-lifecycle/:symbol`), the matching book's halt (svc-trade's `/market-halt/:symbol`, which reads matching's board),
 * the server clock (`/time`, so a trade's age is judged on the server's clock), and the newest executed trade (the public
 * tape's `/trades/:symbol`). A failed read is never shown as a good one.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { useDataEnv, useSource } from '../../data/hooks';
import type { Loadable } from '../../data/types';
import { readServerClock } from '../../shared/server-clock';
import { STATE_POLL_MS, type BookHaltView, type LifecycleView } from './data-status';

export { STATE_POLL_MS };

/** The server clock is read less often: its offset moves slowly. */
const CLOCK_POLL_MS = 60_000;

const lifecycleSchema = z
  .object({ state: z.string(), effectiveAt: z.string().nullish(), evidenceRefs: z.array(z.string()).nullish() })
  .passthrough();
const haltSchema = z
  .object({
    halted: z.boolean(),
    venueHalted: z.boolean(),
    // Informational: a time that is missing or not an ISO string reads as unknown, never as an unreadable halt.
    haltedSince: z.unknown().optional(),
    venueHaltedSince: z.unknown().optional(),
  })
  .passthrough();

/** An ISO time from the route as epoch ms; null when it names none or names one that does not parse. */
const msOf = (iso: unknown): number | null => {
  const ms = typeof iso === 'string' && iso !== '' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const tapeSchema = z.array(z.object({ timestamp: z.number() }).passthrough());

type Raw<T> = { ok: true; data: T } | { ok: false; reason: string; code?: string; status?: number };

/** The market's lifecycle state and when it took effect. A 503 (no authority) is an error, never an OPEN default. */
export function useMarketLifecycle(symbol: string): Loadable<LifecycleView> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.poller.source<LifecycleView>(
          `chart-lifecycle:${symbol}`,
          async (signal) => {
            const res = (await env.api.rest(`/market-lifecycle/${encodeURIComponent(symbol)}`, lifecycleSchema, { signal })) as Raw<
              z.infer<typeof lifecycleSchema>
            >;
            if (!res.ok) return res;
            return {
              ok: true,
              data: {
                state: res.data.state,
                effectiveAt: msOf(res.data.effectiveAt),
                evidenceRefs: res.data.evidenceRefs ?? [],
              },
            };
          },
          { intervalMs: STATE_POLL_MS },
        ),
      [env, symbol],
    ),
  );
}

/** The matching book's halt for this market and for the venue. A 503 (matching not readable) is an error, never open. */
export function useBookHalt(symbol: string): Loadable<BookHaltView> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.poller.source<BookHaltView>(
          `chart-book-halt:${symbol}`,
          async (signal) => {
            const res = (await env.api.rest(`/market-halt/${encodeURIComponent(symbol)}`, haltSchema, { signal })) as Raw<
              z.infer<typeof haltSchema>
            >;
            if (!res.ok) return res;
            return {
              ok: true,
              data: {
                halted: res.data.halted,
                venueHalted: res.data.venueHalted,
                haltedSinceMs: msOf(res.data.haltedSince),
                venueHaltedSinceMs: msOf(res.data.venueHaltedSince),
              },
            };
          },
          { intervalMs: STATE_POLL_MS },
        ),
      [env, symbol],
    ),
  );
}

/**
 * The server clock minus the client clock, in ms. Read as the midpoint of the request, so the network's delay does not
 * become a clock difference. Used to judge a trade's age on the server's own clock.
 */
export function useServerClock(): Loadable<number> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.poller.source<number>(
          'chart-server-clock',
          async (signal) => {
            const res = await readServerClock(env.api, { signal });
            return res.ok ? { ok: true, data: res.data.offsetMs } : res;
          },
          { intervalMs: CLOCK_POLL_MS },
        ),
      [env],
    ),
  );
}

/** The newest executed trade's time in epoch ms (server clock); null when the market has traded nothing. */
export function useLastTrade(symbol: string): Loadable<number | null> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.poller.source<number | null>(
          `chart-last-trade:${symbol}`,
          async (signal) => {
            const res = (await env.api.rest(`/trades/${encodeURIComponent(symbol)}`, tapeSchema, {
              query: { limit: 1 },
              signal,
            })) as Raw<z.infer<typeof tapeSchema>>;
            if (!res.ok) return res;
            const newest = res.data.reduce<number | null>(
              (best, print) => (best === null || print.timestamp > best ? print.timestamp : best),
              null,
            );
            return { ok: true, data: newest };
          },
          { intervalMs: STATE_POLL_MS },
        ),
      [env, symbol],
    ),
  );
}

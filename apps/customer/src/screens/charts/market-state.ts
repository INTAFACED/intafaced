/**
 * The reads the chart's data status needs beyond the candles: the market's lifecycle state (svc-trade's
 * `/market-lifecycle/:symbol`), the matching book's halt (svc-trade's `/market-halt/:symbol`, which reads matching's board),
 * the server clock (`/time`, so a trade's age is judged on the server's clock), and the newest executed trade (the public
 * tape's `/trades/:symbol`). A failed read is never shown as a good one.
 */
import { useMemo } from 'react';
import { marketHaltSchema, marketLifecycleSchema, tradeTapeTimesSchema } from '@intafaced/contracts/trade-desk-reads';
import type { z } from 'zod';
import { useDataEnv, useSource } from '../../data/hooks';
import { constantSource } from '../../data/source';
import type { Loadable } from '../../data/types';
import { readServerClock } from '../../shared/server-clock';
import { STATE_POLL_MS, type BookHaltView, type LifecycleView } from './data-status';

export { STATE_POLL_MS };

const OFF: Loadable<never> = { status: 'empty' };

/** The server clock is read less often: its offset moves slowly. */
const CLOCK_POLL_MS = 60_000;

/** An ISO time from the route as epoch ms; null when it names none or names one that does not parse. */
const msOf = (iso: unknown): number | null => {
  const ms = typeof iso === 'string' && iso !== '' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

type Raw<T> = { ok: true; data: T } | { ok: false; reason: string; code?: string; status?: number };

/** The market's lifecycle state and when it took effect. A 503 (no authority) is an error, never an OPEN default. */
export function useMarketLifecycle(symbol: string, enabled = true): Loadable<LifecycleView> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        enabled
          ? env.poller.source<LifecycleView>(
              `chart-lifecycle:${symbol}`,
              async (signal) => {
                const res = (await env.api.rest(`/market-lifecycle/${encodeURIComponent(symbol)}`, marketLifecycleSchema, {
                  signal,
                })) as Raw<z.infer<typeof marketLifecycleSchema>>;
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
            )
          : constantSource<LifecycleView>(OFF),
      [env, symbol, enabled],
    ),
  );
}

/** The matching book's halt for this market and for the venue. A 503 (matching not readable) is an error, never open. */
export function useBookHalt(symbol: string, enabled = true): Loadable<BookHaltView> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        enabled
          ? env.poller.source<BookHaltView>(
              `chart-book-halt:${symbol}`,
              async (signal) => {
                const res = (await env.api.rest(`/market-halt/${encodeURIComponent(symbol)}`, marketHaltSchema, { signal })) as Raw<
                  z.infer<typeof marketHaltSchema>
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
            )
          : constantSource<BookHaltView>(OFF),
      [env, symbol, enabled],
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
export function useLastTrade(symbol: string, enabled = true): Loadable<number | null> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        enabled
          ? env.poller.source<number | null>(
              `chart-last-trade:${symbol}`,
              async (signal) => {
                const res = (await env.api.rest(`/trades/${encodeURIComponent(symbol)}`, tradeTapeTimesSchema, {
                  query: { limit: 1 },
                  signal,
                })) as Raw<z.infer<typeof tradeTapeTimesSchema>>;
                if (!res.ok) return res;
                const newest = res.data.reduce<number | null>(
                  (best, print) => (best === null || print.timestamp > best ? print.timestamp : best),
                  null,
                );
                return { ok: true, data: newest };
              },
              { intervalMs: STATE_POLL_MS },
            )
          : constantSource<number | null>(OFF),
      [env, symbol, enabled],
    ),
  );
}

/**
 * The newest trade time this tab has read for each market, kept for the session after the tape stops answering, so a chart
 * opened during our own outage still names its last tick ("Down ... Last trade <time>."). Only ever the time a read
 * returned, never a guess, and never a reason to call the chart live (data-status.ts).
 */
const lastTradeSeen = new Map<string, number>();

/** Notes the newest trade a read returned and gives the newest one this tab has seen for the market, or null. */
export function rememberLastTrade(symbol: string, read: Loadable<number | null>): number | null {
  if (read.status === 'ready' && read.data !== null) {
    const known = lastTradeSeen.get(symbol);
    if (known === undefined || read.data > known) lastTradeSeen.set(symbol, read.data);
  }
  return lastTradeSeen.get(symbol) ?? null;
}

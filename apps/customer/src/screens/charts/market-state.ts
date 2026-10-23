// hand-declared-ok: svc-trade has no browser-safe schema in packages/contracts for the market lifecycle or the public tape answer.
/**
 * The two reads the chart's data status needs beyond the candles: the market's lifecycle state (svc-trade's
 * `/market-lifecycle/:symbol`, the route that says a market is halted or not open) and the newest executed trade (the
 * public tape's `/trades/:symbol`, whose time is the age the status chip judges). Both poll with the same budget as the
 * candles, and a failed read is never shown as a good one.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { useDataEnv, useSource } from '../../data/hooks';
import type { Loadable } from '../../data/types';
import type { LifecycleView } from './data-status';

export const STATE_POLL_MS = 10_000;

const lifecycleSchema = z
  .object({ state: z.string(), effectiveAt: z.string().nullish(), evidenceRefs: z.array(z.string()).nullish() })
  .passthrough();
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
            const effective = res.data.effectiveAt ? Date.parse(res.data.effectiveAt) : NaN;
            return {
              ok: true,
              data: {
                state: res.data.state,
                effectiveAt: Number.isFinite(effective) ? effective : null,
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

/** The newest executed trade's time in epoch ms; null when the market has traded nothing. */
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

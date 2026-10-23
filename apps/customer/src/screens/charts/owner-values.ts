/**
 * The charts module's owner values, as the service publishes them (`GET /api/v1/charts/owner-values`, svc-trade). Each
 * value is the owner's to set on the founder page (`/trade-ops/charts/settings`); a blank one is `null`, and every
 * control that needs it refuses with the typed reason below. The front end never holds one of these numbers itself.
 *
 * hand-declared-ok: svc-trade's `/charts/owner-values` answer has no browser-safe schema in packages/contracts.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { useDataEnv, useSource } from '../../data/hooks';
import type { Loadable } from '../../data/types';

const count = z.number().int().positive().nullable();
export const chartOwnerValuesSchema = z.object({
  compareCap: count,
  chartCountLimit: count,
  drawingCap: count,
  brushPointCap: count,
  delayedBoundarySeconds: count,
  /** The longest main-thread task the chart may hold while ticks stream, in ms; blank while the owner has not set it. */
  renderBudgetMs: count,
  /** The market's data class, for the `?symbol=` asked; null when ops has not set it. */
  dataClass: z.enum(['real_time', 'delayed', 'end_of_day']).nullable(),
});
export type ChartOwnerValues = z.infer<typeof chartOwnerValuesSchema>;

/** The refusal a control shows when the owner value it needs is blank. */
export const OWNER_VALUE_UNSET = 'trade.chart.owner_value_unset' as const;

const OWNER_VALUES_POLL_MS = 60_000;

export function useChartOwnerValues(symbol: string): Loadable<ChartOwnerValues> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.poller.source<ChartOwnerValues>(
          `chart-owner-values:${symbol}`,
          (signal) =>
            env.api.rest('/charts/owner-values', chartOwnerValuesSchema, { query: { symbol }, signal }) as Promise<
              { ok: true; data: ChartOwnerValues } | { ok: false; reason: string; code?: string; status?: number }
            >,
          { intervalMs: OWNER_VALUES_POLL_MS },
        ),
      [env, symbol],
    ),
  );
}

/** One value from a read, or why it cannot be used: still loading, the read failed, or the owner has not set it. */
export function ownerValue<K extends keyof ChartOwnerValues>(
  read: Loadable<ChartOwnerValues>,
  key: K,
): { ok: true; value: NonNullable<ChartOwnerValues[K]> } | { ok: false; why: 'loading' | 'unavailable' | 'unset' } {
  if (read.status === 'loading') return { ok: false, why: 'loading' };
  if (read.status !== 'ready') return { ok: false, why: 'unavailable' };
  const value = read.data[key];
  return value === null ? { ok: false, why: 'unset' } : { ok: true, value: value as NonNullable<ChartOwnerValues[K]> };
}

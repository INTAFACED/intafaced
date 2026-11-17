/**
 * Ramp metrics for the finance desk, as the partner reports them (J-bank-28 #3, BK-ord-01).
 *
 * Ramp orders are the partner's (OWNER 226), so this reads the partner's own report (`ramps/ramp-partner-book.ts`):
 * orders by the partner's state, its health, and the orders whose quote ran out at the partner unpaid. svc-bank's own
 * rows are not counted here. With no ramp partner wired the answer is `{ partner: null }`, which the desk shows as
 * "no data", never as zero orders. Read only, `admin:read`.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import { RAMP_PARTNER_ORDER_STATES, type RampPartnerReport } from '../ramps/ramp-partner-book.js';
import type { OnrampPartner } from '../ramps/payin-sim.js';

export interface RampMetricsView {
  partner: {
    label: string;
    asOf: string;
    health: 'operational';
    lastOpenedAt: string | null;
    lastPaidAt: string | null;
    orders: { state: (typeof RAMP_PARTNER_ORDER_STATES)[number]; count: number }[];
    quoteExpiries: { count: number; latest: { orderId: string; expiredAt: string }[] };
  } | null;
}

const iso = (at: Date | null) => (at ? at.toISOString() : null);

export function rampMetricsView(report: RampPartnerReport | null): RampMetricsView {
  if (!report) return { partner: null };
  return {
    partner: {
      label: report.label,
      asOf: report.asOf.toISOString(),
      health: report.health,
      lastOpenedAt: iso(report.lastOpenedAt),
      lastPaidAt: iso(report.lastPaidAt),
      orders: RAMP_PARTNER_ORDER_STATES.map((state) => ({ state, count: report.orders[state] })),
      quoteExpiries: {
        count: report.quoteExpiries.count,
        latest: report.quoteExpiries.latest.map((e) => ({ orderId: e.orderId, expiredAt: e.expiredAt.toISOString() })),
      },
    },
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export const rampMetricsOutput = z.object({
  partner: z
    .object({
      label: z.string(),
      asOf: z.string(),
      health: z.literal('operational'),
      lastOpenedAt: z.string().nullable(),
      lastPaidAt: z.string().nullable(),
      orders: z.array(z.object({ state: z.enum(RAMP_PARTNER_ORDER_STATES), count: z.number().int().nonnegative() })),
      quoteExpiries: z.object({
        count: z.number().int().nonnegative(),
        latest: z.array(z.object({ orderId: z.string(), expiredAt: z.string() })),
      }),
    })
    .nullable(),
});

export function rampMetricsProcedure(partner: () => OnrampPartner | null | undefined, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(z.object({}).strict().optional())
    .output(rampMetricsOutput)
    .query(() => guard(async () => rampMetricsView(partner()?.book?.report() ?? null)));
}

import { z } from 'zod';
import { publicProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { NAV_METRIC_DAYS_MAX, windowDays, type NavMetricStore } from './counts.js';

/** No store on this deployment: counts are not kept, and the desk must not read that as none. */
export const NAV_METRICS_STORAGE_UNCONFIGURED = 'notify.nav_metrics_storage_unconfigured' as const;
/** The founder read names its window; a blank window is never a default. */
export const NAV_METRICS_WINDOW_UNSET = 'notify.nav_metrics_window_unset' as const;

const unconfigured = () =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: `${NAV_METRICS_STORAGE_UNCONFIGURED} — navigation counts are not stored here` });

/**
 * `navMetrics.searchMiss`: the customer app's header search found nothing for a submitted search. Public (a signed-out
 * search counts too) and takes no input, so nothing about the person or the words can reach the count.
 * `navMetrics.searchMisses`: the founders' read, per UTC day over a window they name, marked as a lower bound.
 */
export function navMetricsRouter(store: NavMetricStore | undefined, now: () => Date = () => new Date()) {
  return router({
    searchMiss: publicProcedure.output(z.object({ counted: z.literal(true) })).mutation(async () => {
      if (!store) throw unconfigured();
      await store.count('search_miss', now());
      return { counted: true as const };
    }),
    searchMisses: scopedProcedure('admin:read', { module: 'notify' })
      .input(z.object({ days: z.number().int().min(1).max(NAV_METRIC_DAYS_MAX).optional() }).optional())
      .output(
        z.object({
          kind: z.literal('search_miss'),
          from: z.string(),
          to: z.string(),
          days: z.array(z.object({ day: z.string(), count: z.number().int().nonnegative() })),
          /** Sent once with no retry: a lost count stays lost. */
          lowerBound: z.literal(true),
        }),
      )
      .query(async ({ input }) => {
        if (input?.days === undefined)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${NAV_METRICS_WINDOW_UNSET} — name how many days to read` });
        if (!store) throw unconfigured();
        const { from, to } = windowDays(now(), input.days);
        return { kind: 'search_miss' as const, from, to, days: await store.read('search_miss', from, to), lowerBound: true as const };
      }),
  });
}

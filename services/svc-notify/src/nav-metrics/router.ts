import { router, TRPCError } from '@intafaced/contracts';
import { windowDays, type NavMetricStore } from './counts.js';
import { NOTIFY_NAV_METRICS_SEARCH_MISSES, NOTIFY_NAV_METRICS_SEARCH_MISS } from '@intafaced/contracts/notify-nav-metrics-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { notifyRefusal } from '../record-refusal.js';

/** No store on this deployment: counts are not kept, and the desk must not read that as none. */
export const NAV_METRICS_STORAGE_UNCONFIGURED = 'notify.nav_metrics_storage_unconfigured' as const;
/** The founder read names its window; a blank window is never a default. */
export const NAV_METRICS_WINDOW_UNSET = 'notify.nav_metrics_window_unset' as const;

const unconfigured = () =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: `${NAV_METRICS_STORAGE_UNCONFIGURED} — navigation counts are not stored here` });

/**
 * `navMetrics.searchMiss`: the customer app's header search found nothing. Public (a signed-out search counts too), and
 * its only input is the kind, held strict, so nothing about the person or the words can reach the count.
 * `navMetrics.searchMisses`: the founders' read, per UTC day over a window they name, marked approximate.
 */
export function navMetricsRouter(store: NavMetricStore | undefined, now: () => Date = () => new Date()) {
  return router({
    searchMiss: mountRecord(
      NOTIFY_NAV_METRICS_SEARCH_MISS,
      async () => {
        if (!store) throw unconfigured();
        await store.count('search_miss', now());
        return { counted: true as const };
      },
      notifyRefusal,
    ),
    searchMisses: mountRecord(
      NOTIFY_NAV_METRICS_SEARCH_MISSES,
      async ({ input }) => {
        if (input?.days === undefined)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${NAV_METRICS_WINDOW_UNSET} — name how many days to read` });
        if (!store) throw unconfigured();
        const { from, to } = windowDays(now(), input.days);
        return { kind: 'search_miss' as const, from, to, days: await store.read('search_miss', from, to), approximate: true as const };
      },
      notifyRefusal,
    ),
  });
}

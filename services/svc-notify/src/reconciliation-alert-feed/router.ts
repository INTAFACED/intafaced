import { router } from '@intafaced/contracts/trpc';
import type { ReconAlertFeedStore } from './feed.js';
import { NOTIFY_RECONCILIATION_ALERT_FEED_LIST } from '@intafaced/contracts/notify-reconciliation-alert-feed-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { notifyRefusal } from '../record-refusal.js';

/**
 * `reconciliationAlertFeed.list` (`admin:read`): the transitions svc-notify received for one reconciliation alert, one per
 * business key, oldest first, and whether its consumers are attached to the bus. The console shows it on the alert beside
 * svc-ops' own timeline.
 */
export function reconAlertFeedRouter(store: ReconAlertFeedStore, attached: () => boolean) {
  return router({
    list: mountRecord(
      NOTIFY_RECONCILIATION_ALERT_FEED_LIST,
      async ({ input }) => {
        const alertId = input.alertId.toLowerCase();
        return { alertId, bus: attached() ? ('attached' as const) : ('detached' as const), entries: await store.list(alertId) };
      },
      notifyRefusal,
    ),
  });
}

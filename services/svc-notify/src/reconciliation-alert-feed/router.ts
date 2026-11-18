import { router, scopedProcedure } from '@intafaced/contracts';
import { notifyReconAlertFeedInputSchema, notifyReconAlertFeedSchema } from '@intafaced/contracts/ops-reconciliation-alerts';
import type { ReconAlertFeedStore } from './feed.js';

/**
 * `reconciliationAlertFeed.list` (`admin:read`): the transitions svc-notify received for one reconciliation alert, one per
 * business key, oldest first, and whether its consumers are attached to the bus. The console shows it on the alert beside
 * svc-ops' own timeline.
 */
export function reconAlertFeedRouter(store: ReconAlertFeedStore, attached: () => boolean) {
  return router({
    list: scopedProcedure('admin:read', { module: 'notify' })
      .input(notifyReconAlertFeedInputSchema)
      .output(notifyReconAlertFeedSchema)
      .query(async ({ input }) => {
        const alertId = input.alertId.toLowerCase();
        return { alertId, bus: attached() ? ('attached' as const) : ('detached' as const), entries: await store.list(alertId) };
      }),
  });
}

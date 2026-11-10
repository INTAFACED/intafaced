import type { EventBus } from '@intafaced/events';
import type { VenueDelistingNotices } from './venue/venue-listing.js';

/**
 * The venue delisting notice on the event bus (J-cex-spot-16). It lives outside `src/venue/` so that folder, the
 * customer's own venue door, reaches no event bus (`venue/venue-posts-nothing.test.ts`, J-wallet-09). The notice moves
 * no money: it tells desks a listed market is dated to leave.
 */
export function busVenueDelistingNotices(bus: Pick<EventBus, 'publish'>): VenueDelistingNotices {
  return {
    async publish(n) {
      await bus.publish(
        'venueDelistingScheduled',
        {
          venueId: n.venueId,
          symbol: n.symbol,
          delistsAt: n.delistsAt.toISOString(),
          scheduledAt: n.scheduledAt.toISOString(),
          noticeKey: n.noticeKey,
        },
        { idempotencyKey: n.noticeKey },
      );
    },
  };
}

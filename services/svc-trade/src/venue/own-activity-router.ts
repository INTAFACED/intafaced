/**
 * `venue.ownActivity`: svc-tax's door to a person's own venue spot trading (own-activity.ts). Service-only:
 * `serviceProcedureFor(TRADE_VENUE_ACTIVITY_CALLERS)` proves the caller is svc-tax before the input is parsed. A read; a
 * POST only because the caller signs the body. The venue down answers SERVICE_UNAVAILABLE, never an empty list.
 */
import {
  router,
  serviceProcedureFor,
  tradeVenueActivityInputSchema,
  tradeVenueActivitySchema,
  TRADE_VENUE_ACTIVITY_CALLERS,
  TRPCError,
} from '@intafaced/contracts';
import { VenueRefusalError, type UserVenue } from '@intafaced/venue-contracts';
import type { PreparedActionStore } from './prepared-action-store.js';
import { readOwnVenueActivity } from './own-activity.js';

export interface OwnVenueActivityDeps {
  /** The connected venue; null when the door is off on this deployment. */
  readonly venue: (() => Promise<UserVenue>) | null;
  readonly store: PreparedActionStore;
}

/** Mounted as `venue` on the root router. Unwired (no deps), it answers the door off. */
export function ownVenueActivityRouter(deps?: OwnVenueActivityDeps) {
  return router({
    ownActivity: serviceProcedureFor(TRADE_VENUE_ACTIVITY_CALLERS)
      .input(tradeVenueActivityInputSchema)
      .output(tradeVenueActivitySchema)
      .mutation(async ({ input }) => {
        if (!deps) return { state: 'off' as const };
        try {
          return await readOwnVenueActivity({ venue: deps.venue, store: deps.store, userId: input.userId });
        } catch (err) {
          const detail = err instanceof VenueRefusalError ? `trade.venue.${err.refusal.code}` : 'trade.venue_activity_unavailable';
          throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: `the venue could not be read just now [${detail}]`, cause: err });
        }
      }),
  });
}

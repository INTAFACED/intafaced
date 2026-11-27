/**
 * `venue.ownActivity`: svc-tax's door to a person's own venue spot trading (own-activity.ts). Service-only:
 * `serviceProcedureFor(TRADE_VENUE_ACTIVITY_CALLERS)` proves the caller is svc-tax before the input is parsed. A read; a
 * POST only because the caller signs the body. The venue down answers SERVICE_UNAVAILABLE, never an empty list.
 */
import {
  tradeVenueActivityInputSchema,
  tradeVenueActivitySchema,
  TRADE_VENUE_ACTIVITY_CALLERS,
} from '@intafaced/contracts/trade-venue-activity';
import { TRADE_DESK_SNAPSHOT } from '@intafaced/contracts/trade-desk-snapshot';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { router, serviceProcedureFor, TRPCError } from '@intafaced/contracts/trpc';
import { VenueRefusalError, type UserVenue } from '@intafaced/venue-contracts';
import type { PreparedActionStore } from './prepared-action-store.js';
import { readOwnVenueActivity } from './own-activity.js';
import { readDeskSnapshot } from './desk-snapshot.js';

/** The venue down, for `venue.deskSnapshot`: 503 `trade.desk_snapshot_unavailable`, never an empty list. */
class DeskSnapshotUnavailableError extends Error {
  readonly code = 'trade.desk_snapshot_unavailable' as const;
}

const deskRefusal: RefusalOf = (err) =>
  err instanceof DeskSnapshotUnavailableError
    ? { code: err.code, error: new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: err.message, cause: err }) }
    : undefined;

export interface OwnVenueActivityDeps {
  /** The connected venue; null when the door is off on this deployment. */
  readonly venue: (() => Promise<UserVenue>) | null;
  readonly store: PreparedActionStore;
  readonly now?: () => Date;
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
    /** `venue.deskSnapshot`: svc-notify's read of a person's own perpetual desk for its read-only Telegram alerts. */
    deskSnapshot: mountRecord(
      TRADE_DESK_SNAPSHOT,
      async ({ input }) => {
        if (!deps) return { state: 'off' as const };
        try {
          return await readDeskSnapshot({ venue: deps.venue, store: deps.store, input, now: deps.now ?? (() => new Date()) });
        } catch (err) {
          const detail = err instanceof VenueRefusalError ? `trade.venue.${err.refusal.code}` : 'trade.desk_snapshot_unavailable';
          throw new DeskSnapshotUnavailableError(`the venue could not be read just now [${detail}]`, { cause: err });
        }
      },
      deskRefusal,
    ),
  });
}

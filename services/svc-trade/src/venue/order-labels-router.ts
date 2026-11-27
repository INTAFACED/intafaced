/**
 * `trade.venueOrderLabels.list`: the person's own order labels on their own venue account (J-derivatives-04 #2), from our
 * record only, for a browser that reads its own orders from the venue itself. The door is a record
 * (`@intafaced/contracts/trade-venue-order-labels-procedures`). Refusals keep their typed code on `data.cause.code`.
 * With the user-venue door off it answers 503 `trade.user_venue_off`.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { VENUE_ORDER_LABELS_LIST } from '@intafaced/contracts/trade-venue-order-labels-procedures';
import { UserVenueDoorError, type UserVenueDoor } from './user-venue-door.js';

const refusalOf: RefusalOf = (err) => {
  if (!(err instanceof UserVenueDoorError)) return undefined;
  if (err.code === 'trade.user_venue_off')
    return { code: err.code, error: new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: err.message, cause: err }) };
  if (err.code === 'trade.venue_request_invalid')
    return { code: err.code, error: new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err }) };
  return undefined;
};

export function venueOrderLabelsRouter(door: Pick<UserVenueDoor, 'orderLabelsOf'> | null | undefined) {
  return router({
    list: mountRecord(
      VENUE_ORDER_LABELS_LIST,
      ({ ctx, input }) => {
        if (!door) throw new UserVenueDoorError('no venue is connected on this deployment', 'trade.user_venue_off', 503);
        return door.orderLabelsOf(ctx.principal, input.owner);
      },
      refusalOf,
    ),
  });
}

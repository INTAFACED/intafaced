/**
 * `trade.autoTopUp.*`: auto top-up of an isolated position's margin on the person's own venue account (J-derivatives-06
 * #4; auto-top-up.ts). Every door is a record (`@intafaced/contracts/trade-auto-top-up-procedures`). Refusals keep their
 * typed code on `data.cause.code`. With the user-venue door off there is no auto top-up, and every door answers 503
 * `trade.auto_top_up_unavailable`.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import {
  AUTO_TOP_UP_GET,
  AUTO_TOP_UP_OFF,
  AUTO_TOP_UP_SET,
  AUTO_TOP_UP_SUBMIT_PERMISSION,
} from '@intafaced/contracts/trade-auto-top-up-procedures';
import { VenueRefusalError } from '@intafaced/venue-contracts';
import { AutoTopUpError, type VenueAutoTopUp } from './auto-top-up.js';
import { UserVenueDoorError } from './user-venue-door.js';

const STATUS: Record<AutoTopUpError['code'], TRPCError['code']> = {
  'trade.auto_top_up_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.auto_top_up_agent_key_unset': 'SERVICE_UNAVAILABLE',
  'trade.auto_top_up_request_invalid': 'BAD_REQUEST',
  'trade.auto_top_up_field_invalid': 'BAD_REQUEST',
  'trade.auto_top_up_no_position': 'CONFLICT',
  'trade.auto_top_up_not_asked': 'CONFLICT',
};

/** The door's and the venue's own refusals (a malformed wallet, a venue that refused) leave as a request refusal, in their words. */
function asAutoTopUpError(err: unknown): AutoTopUpError | undefined {
  if (err instanceof AutoTopUpError) return err;
  if (err instanceof UserVenueDoorError && err.status < 500) return new AutoTopUpError(err.message, 'trade.auto_top_up_request_invalid');
  if (err instanceof VenueRefusalError) return new AutoTopUpError(err.refusal.detail, 'trade.auto_top_up_request_invalid');
  return undefined;
}

const refusalOf: RefusalOf = (err) => {
  const e = asAutoTopUpError(err);
  return e ? { code: e.code, error: new TRPCError({ code: STATUS[e.code], message: e.message, cause: e }) } : undefined;
};

export function autoTopUpRouter(autoTopUp: VenueAutoTopUp | null | undefined) {
  const call = async <T>(fn: (a: VenueAutoTopUp) => Promise<T>): Promise<T> => {
    if (!autoTopUp)
      throw new AutoTopUpError('Auto top-up runs on your own venue account, and no venue is connected', 'trade.auto_top_up_unavailable');
    return fn(autoTopUp);
  };
  return router({
    get: mountRecord(AUTO_TOP_UP_GET, ({ ctx, input }) => call((a) => a.get(ctx.principal, input.owner, input.symbol)), refusalOf),
    set: mountRecord(AUTO_TOP_UP_SET, ({ ctx, input }) => call((a) => a.set(ctx.principal, input)), refusalOf),
    submitPermission: mountRecord(
      AUTO_TOP_UP_SUBMIT_PERMISSION,
      ({ ctx, input }) => call((a) => a.submitPermission(ctx.principal, input)),
      refusalOf,
    ),
    off: mountRecord(AUTO_TOP_UP_OFF, ({ ctx, input }) => call((a) => a.off(ctx.principal, input.owner, input.symbol)), refusalOf),
  });
}

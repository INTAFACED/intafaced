/**
 * `trade.profitLock.*`: the person's weekly Profit lock on their own venue account (J-wallet-26; profit-lock.ts). Every
 * door is a record (`@intafaced/contracts/trade-profit-lock-procedures`). Refusals keep their typed code on
 * `data.cause.code`. With the user-venue door off there is no lock, and every door answers 503
 * `trade.profit_lock_unavailable`.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { PROFIT_LOCK_DECLINE, PROFIT_LOCK_GET, PROFIT_LOCK_SET } from '@intafaced/contracts/trade-profit-lock-procedures';
import { VenueRefusalError } from '@intafaced/venue-contracts';
import { ProfitLockError, type VenueProfitLocks } from './profit-lock.js';
import { UserVenueDoorError } from './user-venue-door.js';

const STATUS: Record<ProfitLockError['code'], TRPCError['code']> = {
  'trade.profit_lock_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.profit_lock_request_invalid': 'BAD_REQUEST',
  'trade.profit_lock_field_invalid': 'BAD_REQUEST',
  'trade.profit_lock_address_ours': 'BAD_REQUEST',
  'trade.profit_lock_address_mistyped': 'BAD_REQUEST',
  'trade.profit_lock_no_offer': 'CONFLICT',
};

/** The door's and the venue's own refusals (a malformed wallet, a venue that refused) leave as a request refusal, in their words. */
function asProfitLockError(err: unknown): ProfitLockError | undefined {
  if (err instanceof ProfitLockError) return err;
  if (err instanceof UserVenueDoorError && err.status < 500) return new ProfitLockError(err.message, 'trade.profit_lock_request_invalid');
  if (err instanceof VenueRefusalError) return new ProfitLockError(err.refusal.detail, 'trade.profit_lock_request_invalid');
  return undefined;
}

const refusalOf: RefusalOf = (err) => {
  const e = asProfitLockError(err);
  return e ? { code: e.code, error: new TRPCError({ code: STATUS[e.code], message: e.message, cause: e }) } : undefined;
};

export function profitLockRouter(locks: VenueProfitLocks | null | undefined) {
  const call = async <T>(fn: (l: VenueProfitLocks) => Promise<T>): Promise<T> => {
    if (!locks)
      throw new ProfitLockError('Profit lock watches your own venue account, and no venue is connected', 'trade.profit_lock_unavailable');
    return fn(locks);
  };
  return router({
    get: mountRecord(PROFIT_LOCK_GET, ({ ctx, input }) => call((l) => l.get(ctx.principal, input.owner)), refusalOf),
    set: mountRecord(PROFIT_LOCK_SET, ({ ctx, input }) => call((l) => l.set(ctx.principal, input)), refusalOf),
    decline: mountRecord(
      PROFIT_LOCK_DECLINE,
      ({ ctx, input }) => call((l) => l.decline(ctx.principal, input.owner, input.offerKey)),
      refusalOf,
    ),
  });
}

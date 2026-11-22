/**
 * `trade.bots.recurring.*`: the recurring buy of a basket on the person's own venue account (J-copy-bots-otc-16;
 * recurring-buys.ts). Every door is a record (`@intafaced/contracts/trade-recurring-procedures`). Refusals keep their typed
 * code on `data.cause.code`. With the user-venue door off there is no recurring buy, and every door answers 503
 * `trade.recurring_unavailable`.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import {
  RECURRING_CREATE,
  RECURRING_GET,
  RECURRING_LIST,
  RECURRING_SUBMIT_PERMISSION,
  RECURRING_TERMINATE,
  RECURRING_UPDATE,
} from '@intafaced/contracts/trade-recurring-procedures';
import { TradeError } from '../spot/types.js';
import { RecurringError, type RecurringBuys } from './recurring-buys.js';

const VERIFICATION_CODES = new Set(['trade.bots_verification_insufficient', 'trade.bots_verification_level_not_set']);

export function recurringTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof RecurringError) {
    const code =
      error.code === 'trade.recurring_not_found'
        ? 'NOT_FOUND'
        : error.code === 'trade.recurring_request_conflict' ||
            error.code === 'trade.recurring_not_signing' ||
            error.code === 'trade.recurring_ended'
          ? 'CONFLICT'
          : error.code === 'trade.recurring_unavailable'
            ? 'SERVICE_UNAVAILABLE'
            : 'BAD_REQUEST';
    return new TRPCError({ code, message: error.message, cause: error });
  }
  if (error instanceof TradeError && VERIFICATION_CODES.has(error.code)) {
    return new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
  }
  return error;
}

const refusalOf: RefusalOf = (err) => {
  const wire = recurringTrpcError(err);
  if (!(wire instanceof TRPCError)) return undefined;
  const cause: unknown = wire.cause;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? { code, error: wire } : undefined;
};

export function recurringRouter(recurring: RecurringBuys | null | undefined) {
  const call = async <T>(fn: (r: RecurringBuys) => Promise<T>): Promise<T> => {
    if (!recurring)
      throw new RecurringError('Recurring buys trade on your own venue account, and no venue is connected', 'trade.recurring_unavailable');
    return fn(recurring);
  };
  return router({
    create: mountRecord(RECURRING_CREATE, ({ ctx, input }) => call((r) => r.create(ctx.principal, input, ctx.region)), refusalOf),
    submitPermission: mountRecord(
      RECURRING_SUBMIT_PERMISSION,
      ({ ctx, input }) => call((r) => r.submitPermission(ctx.principal, input)),
      refusalOf,
    ),
    get: mountRecord(RECURRING_GET, ({ ctx, input }) => call((r) => r.get(ctx.principal, input.ruleId)), refusalOf),
    list: mountRecord(RECURRING_LIST, ({ ctx }) => call(async (r) => [...(await r.list(ctx.principal))]), refusalOf),
    update: mountRecord(RECURRING_UPDATE, ({ ctx, input }) => call((r) => r.update(ctx.principal, input)), refusalOf),
    terminate: mountRecord(RECURRING_TERMINATE, ({ ctx, input }) => call((r) => r.terminate(ctx.principal, input.ruleId)), refusalOf),
  });
}

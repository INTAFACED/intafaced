/**
 * `trade.dailyLoss.*`: the person's opt-in daily loss limit on their own venue account (daily-loss-limit.ts). Every door
 * is a record (`@intafaced/contracts/trade-daily-loss-procedures`). Refusals keep their typed code on `data.cause.code`.
 * With the user-venue door off, every door answers 503 `trade.daily_loss_unavailable`.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { DAILY_LOSS_GET, DAILY_LOSS_OFF, DAILY_LOSS_SET } from '@intafaced/contracts/trade-daily-loss-procedures';
import { VenueRefusalError } from '@intafaced/venue-contracts';
import { DailyLossError, type VenueDailyLossLimits } from './daily-loss-limit.js';

const STATUS: Record<DailyLossError['code'], TRPCError['code']> = {
  'trade.daily_loss_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.daily_loss_request_invalid': 'BAD_REQUEST',
  'trade.daily_loss_field_invalid': 'BAD_REQUEST',
};

function asDailyLossError(err: unknown): DailyLossError | undefined {
  if (err instanceof DailyLossError) return err;
  if (err instanceof VenueRefusalError) return new DailyLossError(err.refusal.detail, 'trade.daily_loss_request_invalid');
  return undefined;
}

const refusalOf: RefusalOf = (err) => {
  const e = asDailyLossError(err);
  return e ? { code: e.code, error: new TRPCError({ code: STATUS[e.code], message: e.message, cause: e }) } : undefined;
};

export function dailyLossRouter(limits: VenueDailyLossLimits | null | undefined) {
  const call = async <T>(fn: (l: VenueDailyLossLimits) => Promise<T>): Promise<T> => {
    if (!limits)
      throw new DailyLossError(
        'A daily loss limit counts your own venue account, and no venue is connected',
        'trade.daily_loss_unavailable',
      );
    return fn(limits);
  };
  return router({
    get: mountRecord(
      DAILY_LOSS_GET,
      ({ ctx, input }) => call((l) => l.get(ctx.principal, input.owner, { terms: input.terms === true })),
      refusalOf,
    ),
    set: mountRecord(DAILY_LOSS_SET, ({ ctx, input }) => call((l) => l.set(ctx.principal, input)), refusalOf),
    off: mountRecord(DAILY_LOSS_OFF, ({ ctx, input }) => call((l) => l.off(ctx.principal, input.owner)), refusalOf),
  });
}

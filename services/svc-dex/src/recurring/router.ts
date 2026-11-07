import { TRPCError, publicJurisdictionProcedure, router } from '@intafaced/contracts';
import {
  dexRecurringCancelOutputSchema,
  dexRecurringListInputSchema,
  dexRecurringListOutputSchema,
  dexRecurringOptionsInputSchema,
  dexRecurringOptionsOutputSchema,
  dexRecurringPrepareInputSchema,
  dexRecurringPrepareOutputSchema,
  dexRecurringRefInputSchema,
} from '@intafaced/contracts/protocol-dex-orders';
import { z } from 'zod';
import { OrderSessionRefused, type OrderSessions } from '../auth/order-session.js';
import { orderSessionTrpcError } from '../auth/router.js';
import { RecurringRefused, recurringCodes } from './errors.js';
import type { RecurringBuys } from './plans.js';

/** The HTTP shape of a recurring-buy refusal, its code leading the message. */
export function recurringTrpcError(err: RecurringRefused): TRPCError {
  const code =
    err.code === recurringCodes.notFound
      ? 'NOT_FOUND'
      : err.code === recurringCodes.notEditable || err.code === recurringCodes.closed
        ? 'CONFLICT'
        : err.code === recurringCodes.unwired
          ? 'SERVICE_UNAVAILABLE'
          : err.code.endsWith('_unset')
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
  return new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
}

async function guarded<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof OrderSessionRefused) throw orderSessionTrpcError(err);
    if (err instanceof RecurringRefused) throw recurringTrpcError(err);
    throw err;
  }
}

/**
 * `recurring.*`: the person's recurring buys (D-limit-dca-05). Starting a plan needs the wallet's order session. A plan is
 * public on chain, so its record, its cancel call (which only the maker's own wallet can send) and the edit and pause
 * refusals are read by the wallet's address. `edit` and `pause` always refuse: a plan's terms are fixed on chain.
 */
export function recurringRouter(buys: RecurringBuys, sessions: OrderSessions) {
  const door = publicJurisdictionProcedure('dex', 'protocol');
  const who = (token: string) => sessions.principal(token);
  return router({
    options: door
      .input(dexRecurringOptionsInputSchema)
      .output(dexRecurringOptionsOutputSchema)
      .mutation(() => guarded(() => buys.options())),
    prepare: door
      .input(dexRecurringPrepareInputSchema)
      .output(dexRecurringPrepareOutputSchema)
      .mutation(({ input }) =>
        guarded(() => {
          const { accessToken, ...rest } = input;
          return buys.prepare(who(accessToken), rest);
        }),
      ),
    list: door
      .input(dexRecurringListInputSchema)
      .output(dexRecurringListOutputSchema)
      .mutation(({ input }) => guarded(() => buys.list(input.wallet, input.fresh === true))),
    edit: door
      .input(dexRecurringRefInputSchema)
      .output(z.never())
      .mutation(({ input }) => guarded(() => buys.refuseChange(input.wallet, input.id))),
    pause: door
      .input(dexRecurringRefInputSchema)
      .output(z.never())
      .mutation(({ input }) => guarded(() => buys.refuseChange(input.wallet, input.id))),
    cancel: door
      .input(dexRecurringRefInputSchema)
      .output(dexRecurringCancelOutputSchema)
      .mutation(({ input }) => guarded(() => buys.cancelCall(input.wallet, input.id))),
  });
}

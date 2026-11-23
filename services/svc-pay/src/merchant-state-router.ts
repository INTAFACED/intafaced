import { accountControlLookupInputSchema, accountControlStateSchema } from '@intafaced/contracts/account-controls';
import { router, protectedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { MerchantAccountControls, MerchantControlError } from './merchant-account-controls.js';
import type { MerchantStateService } from './merchant-state-service.js';
import { PAY_MERCHANT_STATE_HISTORY, PAY_MERCHANT_STATE_SET } from '@intafaced/contracts/pay-merchant-state-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from './record-refusal.js';

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MerchantControlError) {
      let code: 'FORBIDDEN' | 'UNAUTHORIZED' | 'PRECONDITION_FAILED' | 'SERVICE_UNAVAILABLE' = 'PRECONDITION_FAILED';
      if (error.code === 'operator.denied') code = 'FORBIDDEN';
      else if (error.code === 'mfa.required') code = 'UNAUTHORIZED';
      // Identity could not be asked: the caller did nothing wrong and retrying
      // later may work. 503, never a 412 that reads as "fix your request".
      else if (error.code === 'authority.unavailable') code = 'SERVICE_UNAVAILABLE';
      throw new TRPCError({
        code,
        message: error.code,
        cause: error,
      });
    }
    throw error;
  }
}
/** Legacy writer and new founder console share one reason/version/UUID command and guard. */
export function createMerchantStateRouter(_state: MerchantStateService, controls?: MerchantAccountControls) {
  const available = () => {
    if (!controls) throw new MerchantControlError('authority.unavailable');
    return controls;
  };
  const change = mountRecord(
    PAY_MERCHANT_STATE_SET,
    ({ ctx, input }) =>
      mapped(async () => {
        const result = await available().change(ctx, input);
        /*
         * `change` audits a refusal caused by an unreachable authority and
         * returns it as data (HTTP 200). Nothing was allowed, but 200 tells a
         * client its command was handled. The audit row is already committed;
         * only the transport answer changes.
         */
        if (result.outcome === 'refused' && result.code === 'authority.unavailable')
          throw new MerchantControlError('authority.unavailable');
        return result;
      }),
    payRefusal,
  );
  const getState = protectedProcedure
    .input(accountControlLookupInputSchema)
    .output(accountControlStateSchema.nullable())
    .query(({ ctx, input }) => mapped(() => available().getState(ctx, input)));
  const history = mountRecord(PAY_MERCHANT_STATE_HISTORY, ({ ctx, input }) => mapped(() => available().history(ctx, input)), payRefusal);
  return router({ accountControls: router({ change, getState, history }), merchantState: router({ set: change, history }) });
}
export type MerchantStateRouter = ReturnType<typeof createMerchantStateRouter>;

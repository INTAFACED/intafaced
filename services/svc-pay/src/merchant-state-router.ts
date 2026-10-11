import { z } from 'zod';
import {
  router,
  protectedProcedure,
  TRPCError,
  accountControlInputSchema,
  accountControlResultSchema,
  accountControlLookupInputSchema,
  accountControlStateSchema,
  accountControlHistoryInputSchema,
} from '@intafaced/contracts';
import { MerchantAccountControls, MerchantControlError } from './merchant-account-controls.js';
import type { MerchantStateService } from './merchant-state-service.js';

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MerchantControlError) {
      let code: 'FORBIDDEN' | 'UNAUTHORIZED' | 'PRECONDITION_FAILED' = 'PRECONDITION_FAILED';
      if (error.code === 'operator.denied') code = 'FORBIDDEN';
      else if (error.code === 'mfa.required') code = 'UNAUTHORIZED';
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
  const change = protectedProcedure
    .input(accountControlInputSchema)
    .output(accountControlResultSchema)
    .mutation(({ ctx, input }) => mapped(() => available().change(ctx, input)));
  const getState = protectedProcedure
    .input(accountControlLookupInputSchema)
    .output(accountControlStateSchema.nullable())
    .query(({ ctx, input }) => mapped(() => available().getState(ctx, input)));
  const history = protectedProcedure
    .input(accountControlHistoryInputSchema)
    .output(z.array(accountControlResultSchema))
    .query(({ ctx, input }) => mapped(() => available().history(ctx, input)));
  return router({ accountControls: router({ change, getState, history }), merchantState: router({ set: change, history }) });
}
export type MerchantStateRouter = ReturnType<typeof createMerchantStateRouter>;

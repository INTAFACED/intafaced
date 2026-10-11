import { z } from 'zod';
import {
  accountControlInputSchema,
  accountControlLookupInputSchema,
  accountControlHistoryInputSchema,
  accountControlStateSchema,
  accountControlResultSchema,
  accountOperatorEntitlementSchema,
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  router,
  protectedProcedure,
  serviceProcedure,
  TRPCError,
  type AccountControlInput,
  type Context,
} from '@intafaced/contracts';
import { FounderControlError, founderEntitlementChangeSchema, type FounderControls } from './founder-controls.js';

export type FounderControlsPort = Pick<
  FounderControls,
  'change' | 'getState' | 'history' | 'changeEntitlement' | 'operatorEntitlement' | 'operatorStatus' | 'currentAuthority'
>;
export const identityRestrictionInputSchema = accountControlInputSchema.refine(
  (input) => input.target.area === 'identity',
  'Identity target required',
);
export const identityFreezeInputSchema = identityRestrictionInputSchema.refine(
  (input) => input.action === 'restrict',
  'Restrict action required',
);
export const identityRestoreInputSchema = identityRestrictionInputSchema.refine(
  (input) => input.action === 'restore',
  'Restore action required',
);

export async function callFounderControl(
  controls: Pick<FounderControlsPort, 'change'> | undefined,
  context: Context,
  input: AccountControlInput,
) {
  if (!controls)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Founder controls are unconfigured',
      cause: new FounderControlError('identity.controls_unconfigured', 'Founder controls are unconfigured'),
    });
  return controlCall(() => controls.change(context, input));
}
export async function controlCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof FounderControlError)
      throw new TRPCError({
        code: error.code === 'mfa.required' ? 'UNAUTHORIZED' : error.code === 'operator.denied' ? 'FORBIDDEN' : 'PRECONDITION_FAILED',
        message: error.message,
        cause: error,
      });
    throw error;
  }
}

export function createFounderControlsRouter(controls: FounderControlsPort) {
  return router({
    accountControls: router({
      change: protectedProcedure
        .input(identityRestrictionInputSchema)
        .output(accountControlResultSchema)
        .mutation(({ ctx, input }) => callFounderControl(controls, ctx, input)),
      history: protectedProcedure
        .input(accountControlHistoryInputSchema.refine((input) => input.target.area === 'identity', 'Identity target required'))
        .output(z.array(accountControlResultSchema))
        .query(({ ctx, input }) => controlCall(() => controls.history(ctx, input))),
      getState: protectedProcedure
        .input(accountControlLookupInputSchema.refine((input) => input.target.area === 'identity', 'Identity target required'))
        .output(accountControlStateSchema.nullable())
        .query(({ ctx, input }) => controlCall(() => controls.getState(ctx, input))),
      changeOperatorEntitlement: protectedProcedure
        .input(founderEntitlementChangeSchema)
        .mutation(({ ctx, input }) => controlCall(() => controls.changeEntitlement(ctx, input))),
      operatorStatus: protectedProcedure
        .input(z.object({}).strict())
        .output(accountOperatorEntitlementSchema)
        .query(({ ctx }) => controlCall(() => controls.operatorStatus(ctx))),
      // POST reads retain exact body bytes for required service HMAC verification.
      // Enabled is a query-time observation, never account-change or future
      // admission authority. Consumers must not positive-cache.
      operatorEntitlement: serviceProcedure
        .input(z.object({ userId: z.string().uuid() }).strict())
        .output(accountOperatorEntitlementSchema)
        .mutation(({ ctx, input }) => controlCall(() => controls.operatorEntitlement(ctx, input.userId))),
      currentAuthority: serviceProcedure
        .input(currentAuthorityInputSchema)
        .output(currentAuthorityResultSchema)
        .mutation(({ input }) => controls.currentAuthority(input)),
    }),
  });
}

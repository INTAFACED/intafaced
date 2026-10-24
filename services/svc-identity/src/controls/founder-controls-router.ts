import { z } from 'zod';
import {
  scopedProcedure,
  accountControlInputSchema,
  identityAccountControlInputSchema,
  accountControlLookupInputSchema,
  accountControlHistoryInputSchema,
  accountControlStateSchema,
  accountControlResultSchema,
  accountOperatorEntitlementSchema,
  accountClosureInputSchema,
  accountClosureLookupInputSchema,
  accountClosureHistoryInputSchema,
  accountClosureStateSchema,
  accountClosureResultSchema,
  accountArchiveInputSchema,
  accountArchiveLookupInputSchema,
  accountArchiveHistoryInputSchema,
  accountArchiveStateSchema,
  accountArchiveResultSchema,
  accountArchiveProposalsSchema,
  accountTierListSchema,
  accountTierMoveInputSchema,
  accountTierLookupInputSchema,
  accountTierHistoryInputSchema,
  accountTierStateSchema,
  accountTierResultSchema,
  serviceOperatorEntitlementInputSchema,
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  router,
  protectedProcedure,
  serviceProcedure,
  TRPCError,
  type IdentityAccountControlInput,
  type Context,
} from '@intafaced/contracts';
import { FounderControlError, founderEntitlementChangeSchema, type FounderControls } from './founder-controls.js';
import {
  RestrictedListCursorError,
  RestrictedListDeniedError,
  RestrictedListLimitUnsetError,
  type RestrictedAccountPage,
} from './restricted-accounts.js';

export type FounderControlsPort = Pick<
  FounderControls,
  | 'change'
  | 'getState'
  | 'history'
  | 'changeEntitlement'
  | 'operatorEntitlement'
  | 'serviceOperatorEntitlement'
  | 'operatorStatus'
  | 'currentAuthority'
  | 'listRestricted'
  | 'closure'
  | 'closureState'
  | 'closureHistory'
  | 'archive'
  | 'archiveState'
  | 'archiveHistory'
  | 'archiveProposals'
  | 'tiers'
  | 'tierMove'
  | 'tierState'
  | 'tierHistory'
>;
export const identityRestrictionInputSchema = accountControlInputSchema.refine(
  (input) => input.target.area === 'identity',
  'Identity target required',
);
export const identityFreezeInputSchema = identityRestrictionInputSchema.refine(
  (input) => input.action === 'restrict',
  'Restrict action required',
);
/** A restore carries the `identity.account_unfreeze` approval a second person signed (`approvalId`); identity spends it. */
export const identityRestoreInputSchema = identityAccountControlInputSchema
  .refine((input) => input.target.area === 'identity', 'Identity target required')
  .refine((input) => input.action === 'restore', 'Restore action required');

export async function callFounderControl(
  controls: Pick<FounderControlsPort, 'change'> | undefined,
  context: Context,
  input: IdentityAccountControlInput,
) {
  if (!controls)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Founder controls are unconfigured',
      cause: new FounderControlError('identity.controls_unconfigured', 'Founder controls are unconfigured'),
    });
  return controlCall(() => controls.change(context, input));
}
async function listRestrictedCall(
  controls: Pick<FounderControlsPort, 'listRestricted'>,
  context: Context,
  input: { area?: 'identity' | 'trading'; limit?: number | null; cursor?: string },
): Promise<RestrictedAccountPage> {
  try {
    return await controls.listRestricted(context, input);
  } catch (error) {
    if (error instanceof RestrictedListLimitUnsetError || error instanceof RestrictedListCursorError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${error.message} [${error.code}]`, cause: error });
    }
    if (error instanceof RestrictedListDeniedError || error instanceof FounderControlError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
    }
    throw error;
  }
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
        .input(
          identityAccountControlInputSchema.refine(
            (input) => input.target.area === 'identity' || input.target.area === 'trading',
            'Identity or trading target required',
          ),
        )
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
      // Staff close and reopen (J-ops-console-04 #7): a live founder with a second person's approval, spent here.
      closure: protectedProcedure
        .input(accountClosureInputSchema)
        .output(accountClosureResultSchema)
        .mutation(({ ctx, input }) => controlCall(() => controls.closure(ctx, input))),
      closureState: protectedProcedure
        .input(accountClosureLookupInputSchema)
        .output(accountClosureStateSchema.nullable())
        .query(({ ctx, input }) => controlCall(() => controls.closureState(ctx, input))),
      closureHistory: protectedProcedure
        .input(accountClosureHistoryInputSchema)
        .output(z.array(accountClosureResultSchema))
        .query(({ ctx, input }) => controlCall(() => controls.closureHistory(ctx, input))),
      // Archive of a closed customer record (J-ops-console-04 #10): four-eyes, irreversible, and the dormancy proposals.
      archive: protectedProcedure
        .input(accountArchiveInputSchema)
        .output(accountArchiveResultSchema)
        .mutation(({ ctx, input }) => controlCall(() => controls.archive(ctx, input))),
      archiveState: protectedProcedure
        .input(accountArchiveLookupInputSchema)
        .output(accountArchiveStateSchema.nullable())
        .query(({ ctx, input }) => controlCall(() => controls.archiveState(ctx, input))),
      archiveHistory: protectedProcedure
        .input(accountArchiveHistoryInputSchema)
        .output(z.array(accountArchiveResultSchema))
        .query(({ ctx, input }) => controlCall(() => controls.archiveHistory(ctx, input))),
      archiveProposals: protectedProcedure
        .input(z.object({}).strict())
        .output(accountArchiveProposalsSchema)
        .query(({ ctx }) => controlCall(() => controls.archiveProposals(ctx))),
      // Account product tiers (J-ops-console-04 #11): the owner's tier list, and a move a second live founder approved.
      tiers: protectedProcedure
        .input(z.object({}).strict())
        .output(accountTierListSchema)
        .query(({ ctx }) => controlCall(() => controls.tiers(ctx))),
      tierMove: protectedProcedure
        .input(accountTierMoveInputSchema)
        .output(accountTierResultSchema)
        .mutation(({ ctx, input }) => controlCall(() => controls.tierMove(ctx, input))),
      tierState: protectedProcedure
        .input(accountTierLookupInputSchema)
        .output(accountTierStateSchema.nullable())
        .query(({ ctx, input }) => controlCall(() => controls.tierState(ctx, input))),
      tierHistory: protectedProcedure
        .input(accountTierHistoryInputSchema)
        .output(z.array(accountTierResultSchema))
        .query(({ ctx, input }) => controlCall(() => controls.tierHistory(ctx, input))),
      listRestricted: scopedProcedure('admin:read')
        .input(
          z
            .object({
              area: z.enum(['identity', 'trading']).optional(),
              limit: z.number().nullable().optional(),
              cursor: z.string().min(1).max(500).optional(),
            })
            .strict(),
        )
        .output(
          z
            .object({
              rows: z.array(
                z
                  .object({
                    accountId: z.string().guid(),
                    area: z.enum(['identity', 'trading']),
                    since: z.string().datetime({ offset: true }),
                    reason: z.string(),
                    actor: z.string().guid(),
                  })
                  .strict(),
              ),
              nextCursor: z.string().nullable(),
            })
            .strict(),
        )
        .query(({ ctx, input }) => listRestrictedCall(controls, ctx, input)),
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
        .input(z.object({ userId: z.string().guid() }).strict())
        .output(accountOperatorEntitlementSchema)
        .mutation(({ ctx, input }) => controlCall(() => controls.operatorEntitlement(ctx, input.userId))),
      // Service-only: no principal is forwarded. The caller names the user and the session it authenticated
      // at the edge; identity checks both live. Consumers must not positive-cache an enabled answer.
      serviceOperatorEntitlement: serviceProcedure
        .input(serviceOperatorEntitlementInputSchema)
        .output(accountOperatorEntitlementSchema)
        .mutation(({ ctx, input }) => controlCall(() => controls.serviceOperatorEntitlement(ctx, input))),
      currentAuthority: serviceProcedure
        .input(currentAuthorityInputSchema)
        .output(currentAuthorityResultSchema)
        .mutation(({ input }) => controls.currentAuthority(input)),
    }),
  });
}

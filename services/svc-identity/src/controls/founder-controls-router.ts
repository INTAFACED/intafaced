import { z } from 'zod';
import type { IdentityAccountControlInput, Context } from '@intafaced/contracts';
import {
  accountOperatorEntitlementSchema,
  customerDetailReviewSchema,
  customerDetailReviewsInputSchema,
  customerDetailsEditInputSchema,
  customerDetailsLookupInputSchema,
  customerDetailsResultSchema,
  customerDetailsStateSchema,
  serviceOperatorEntitlementInputSchema,
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
} from '@intafaced/contracts/account-controls';
import { scopedProcedure, router, protectedProcedure, serviceProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { FounderControlError, founderEntitlementChangeSchema, type FounderControls } from './founder-controls.js';
import type { AccountLimitsDesk } from './account-limits.js';
import type { CustomerDetailsDesk } from './customer-details.js';
import {
  RestrictedListCursorError,
  RestrictedListDeniedError,
  RestrictedListLimitUnsetError,
  type RestrictedAccountPage,
} from './restricted-accounts.js';
import {
  IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_PROPOSALS,
  IDENTITY_ACCOUNT_CONTROLS_DETAILS_DECIDE,
  IDENTITY_ACCOUNT_CONTROLS_TIERS,
  IDENTITY_ACCOUNT_CONTROLS_CLOSURE_STATE,
  IDENTITY_ACCOUNT_CONTROLS_DETAILS_HISTORY,
  IDENTITY_ACCOUNT_CONTROLS_TIER_STATE,
  IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_HISTORY,
  IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_STATE,
  IDENTITY_ACCOUNT_CONTROLS_LIMITS_HISTORY,
  IDENTITY_ACCOUNT_CONTROLS_LIMITS,
  IDENTITY_ACCOUNT_CONTROLS_GET_STATE,
  IDENTITY_ACCOUNT_CONTROLS_HISTORY,
  IDENTITY_ACCOUNT_CONTROLS_CHANGE,
  IDENTITY_ACCOUNT_CONTROLS_LIMITS_CLEAR,
  IDENTITY_ACCOUNT_CONTROLS_ARCHIVE,
  IDENTITY_ACCOUNT_CONTROLS_CLOSURE,
  IDENTITY_ACCOUNT_CONTROLS_TIER_MOVE,
  IDENTITY_ACCOUNT_CONTROLS_CLOSURE_HISTORY,
  IDENTITY_ACCOUNT_CONTROLS_TIER_HISTORY,
  IDENTITY_ACCOUNT_CONTROLS_OPERATOR_STATUS,
  IDENTITY_ACCOUNT_CONTROLS_LIMITS_SET,
} from '@intafaced/contracts/identity-account-controls-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';
import { identityFreezeInputSchema } from '@intafaced/contracts/identity-compliance-procedures';

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
export type CustomerDetailsPort = Pick<CustomerDetailsDesk, 'state' | 'edit' | 'decide' | 'reviews' | 'history'>;
export type AccountLimitsPort = Pick<AccountLimitsDesk, 'state' | 'set' | 'clear' | 'history'>;

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

/** Without a details desk (no wiring), the details doors refuse as unconfigured rather than answer with nothing. */
function detailsDesk(details: CustomerDetailsPort | undefined): CustomerDetailsPort {
  if (details) return details;
  throw new FounderControlError('identity.details_unconfigured', 'identity.details_unconfigured');
}

/** Without a limits desk (no wiring), the limit doors refuse as unconfigured rather than answer with nothing. */
function limitsDesk(limits: AccountLimitsPort | undefined): AccountLimitsPort {
  if (limits) return limits;
  throw new FounderControlError('identity.controls_unconfigured', 'identity.controls_unconfigured');
}

export function createFounderControlsRouter(controls: FounderControlsPort, details?: CustomerDetailsPort, limits?: AccountLimitsPort) {
  return router({
    accountControls: router({
      change: mountRecord(IDENTITY_ACCOUNT_CONTROLS_CHANGE, ({ ctx, input }) => callFounderControl(controls, ctx, input), codedRefusal),
      history: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_HISTORY,
        ({ ctx, input }) => controlCall(() => controls.history(ctx, input)),
        codedRefusal,
      ),
      getState: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_GET_STATE,
        ({ ctx, input }) => controlCall(() => controls.getState(ctx, input)),
        codedRefusal,
      ),
      // Staff close and reopen (J-ops-console-04 #7): a live founder with a second person's approval, spent here.
      closure: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_CLOSURE,
        ({ ctx, input }) => controlCall(() => controls.closure(ctx, input)),
        codedRefusal,
      ),
      closureState: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_CLOSURE_STATE,
        ({ ctx, input }) => controlCall(() => controls.closureState(ctx, input)),
        codedRefusal,
      ),
      closureHistory: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_CLOSURE_HISTORY,
        ({ ctx, input }) => controlCall(() => controls.closureHistory(ctx, input)),
        codedRefusal,
      ),
      // Archive of a closed customer record (J-ops-console-04 #10): four-eyes, irreversible, and the dormancy proposals.
      archive: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_ARCHIVE,
        ({ ctx, input }) => controlCall(() => controls.archive(ctx, input)),
        codedRefusal,
      ),
      archiveState: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_STATE,
        ({ ctx, input }) => controlCall(() => controls.archiveState(ctx, input)),
        codedRefusal,
      ),
      archiveHistory: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_HISTORY,
        ({ ctx, input }) => controlCall(() => controls.archiveHistory(ctx, input)),
        codedRefusal,
      ),
      archiveProposals: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_PROPOSALS,
        ({ ctx }) => controlCall(() => controls.archiveProposals(ctx)),
        codedRefusal,
      ),
      // Account product tiers (J-ops-console-04 #11): the owner's tier list, and a move a second live founder approved.
      tiers: mountRecord(IDENTITY_ACCOUNT_CONTROLS_TIERS, ({ ctx }) => controlCall(() => controls.tiers(ctx)), codedRefusal),
      tierMove: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_TIER_MOVE,
        ({ ctx, input }) => controlCall(() => controls.tierMove(ctx, input)),
        codedRefusal,
      ),
      tierState: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_TIER_STATE,
        ({ ctx, input }) => controlCall(() => controls.tierState(ctx, input)),
        codedRefusal,
      ),
      tierHistory: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_TIER_HISTORY,
        ({ ctx, input }) => controlCall(() => controls.tierHistory(ctx, input)),
        codedRefusal,
      ),
      // Customer details (J-ops-console-04 #9): open details apply at once; name, date of birth and tax number go through a
      // compliance review the other founder passes. Values are encrypted at rest; the history names fields, never values.
      details: protectedProcedure
        .input(customerDetailsLookupInputSchema)
        .output(customerDetailsStateSchema.nullable())
        .query(({ ctx, input }) => controlCall(() => detailsDesk(details).state(ctx, input))),
      detailsEdit: protectedProcedure
        .input(customerDetailsEditInputSchema)
        .output(customerDetailsResultSchema)
        .mutation(({ ctx, input }) => controlCall(() => detailsDesk(details).edit(ctx, input))),
      detailsDecide: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_DETAILS_DECIDE,
        ({ ctx, input }) => controlCall(() => detailsDesk(details).decide(ctx, input)),
        codedRefusal,
      ),
      detailsReviews: protectedProcedure
        .input(customerDetailReviewsInputSchema)
        .output(z.array(customerDetailReviewSchema))
        .query(({ ctx, input }) => controlCall(() => detailsDesk(details).reviews(ctx, input))),
      detailsHistory: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_DETAILS_HISTORY,
        ({ ctx, input }) => controlCall(() => detailsDesk(details).history(ctx, input)),
        codedRefusal,
      ),
      // Limit overrides (J-ops-console-04 #12): a temporary override of one rail's figures for one asset, ending at a stored
      // time; above the owner ceiling it spends the other founder's approval.
      limits: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_LIMITS,
        ({ ctx, input }) => controlCall(() => limitsDesk(limits).state(ctx, input)),
        codedRefusal,
      ),
      limitsSet: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_LIMITS_SET,
        ({ ctx, input }) => controlCall(() => limitsDesk(limits).set(ctx, input)),
        codedRefusal,
      ),
      limitsClear: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_LIMITS_CLEAR,
        ({ ctx, input }) => controlCall(() => limitsDesk(limits).clear(ctx, input)),
        codedRefusal,
      ),
      limitsHistory: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_LIMITS_HISTORY,
        ({ ctx, input }) => controlCall(() => limitsDesk(limits).history(ctx, input)),
        codedRefusal,
      ),
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
      operatorStatus: mountRecord(
        IDENTITY_ACCOUNT_CONTROLS_OPERATOR_STATUS,
        ({ ctx }) => controlCall(() => controls.operatorStatus(ctx)),
        codedRefusal,
      ),
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
export { identityFreezeInputSchema };

import type { Principal } from '@intafaced/auth';
import { AuthError, hasScope, requireMfa, requireScope } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  merchantAnalyticsFeesSchema,
  merchantAnalyticsInputSchema,
  merchantAnalyticsVolumeSchema,
  merchantBusinessProfileConfirmInputSchema,
  merchantBusinessProfileDecideResultSchema,
  merchantBusinessProfileReviewInputSchema,
  merchantBusinessProfileReviewResultSchema,
  merchantBusinessProfileSchema,
  merchantBusinessProfileSubmitInputSchema,
  merchantBusinessProfileSubmitResultSchema,
  merchantMyAccessSchema,
  merchantOnboardingProgressSchema,
  merchantPortalMerchantInputSchema,
  merchantProfileHistoryInputSchema,
  merchantProfileHistorySchema,
  merchantProfileSecondApprovalInputSchema,
  merchantProfileSecondApprovalResultSchema,
  anyScopeProcedure,
  router,
  scopedProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { consumePayApproval, unwiredApprovalConsumer, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { merchantProfileReviewFields } from '../approval-bindings.js';
import { createMerchantCustomerEmails } from '../customer-emails/router.js';
import type { MerchantAreaFence } from '../merchant-ownership.js';
import type { MerchantTeamRead } from '../merchant-team-read.js';
import { isInteractivePrincipal } from '../merchant-ops/roles.js';
import type { PayService } from '../payment-service.js';
import { listMyAccess } from './access.js';
import { MerchantAnalyticsService } from './analytics.js';
import { PortalError, wrapPortal } from './errors.js';
import { readOnboardingProgress } from './onboarding.js';
import { MerchantProfileService, type ProfileWriter } from './profile.js';
import { ownMerchantRead } from '../own-merchant-read.js';

/**
 * Merchant portal procedures.
 *
 * `merchant.myAccess` lists memberships of the signed principal only. It does
 * not take a merchant id, and it does not invent a membership from a merchant
 * row the caller does not own or actively belong to.
 *
 * Profile writes are owner or admin, and only from an interactive session.
 * A PayFac parent that can read a child cannot write that child's profile.
 * While KYB is `none` or `rejected`, one interactive owner or admin applies
 * sensitive identity fields directly. While KYB is `pending`, a request that
 * names any sensitive identity field is refused entirely. After approval, `businessProfile.review` (`admin:compliance`)
 * applies them, the same operator class as `merchant.decideKyb`. Review checks
 * that the request is `pending_review` and that the presented change hash
 * matches, before it consumes the founder approval.
 */
export function merchantPortalExtensions(deps: {
  sql: Sql;
  pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>;
  trees: MerchantAreaFence | null;
  team: MerchantTeamRead;
  approvals?: ActionApprovalConsumer;
}) {
  const approvals = deps.approvals ?? unwiredApprovalConsumer();
  const profile = new MerchantProfileService(deps.sql, deps.pay, deps.trees, deps.team);
  const analytics = new MerchantAnalyticsService(deps.sql, deps.pay, deps.trees, deps.team);
  const read = ownMerchantRead();
  /**
   * Profile writes take `pay:write` or `pay:onboard`, and say which one the session still holds, so the
   * service can let the owner of a business that is not verified yet fill in its details (J-merchant-02 #1)
   * and an admin of a verified one change them (`ProfileWriter`).
   */
  const profileWrite = anyScopeProcedure(['pay:write', 'pay:onboard'], { module: 'pay' }).use(async ({ ctx, next }) => {
    let scope: ProfileWriter['scope'] = 'pay:onboard';
    if (hasScope(ctx.principal.scopes, 'pay:write')) {
      // A second live lookup: anyScopeProcedure does not say which scope it accepted.
      try {
        requireScope(ctx.principal, 'pay:write');
        await ctx.ownerPayGrant?.assertStillGranted(ctx.principal, 'pay:write');
        scope = 'pay:write';
      } catch (err) {
        // A withdrawn grant or a missing second factor: anyScopeProcedure accepted the session on `pay:onboard`,
        // so the narrower rules apply. Anything else (the lookup failing) is not a decision about the grant.
        if (!(err instanceof AuthError) && !(err instanceof TRPCError && err.message === 'pay.owner_grant_withdrawn')) throw err;
      }
    }
    return next({ ctx: { ...ctx, profileScope: scope } });
  });
  const writer = (ctx: { principal: Principal | null | undefined; profileScope: ProfileWriter['scope'] }): ProfileWriter => ({
    userId: interactive(ctx.principal),
    scope: ctx.profileScope,
  });
  const compliance = scopedProcedure('admin:compliance', { module: 'pay' });

  const userIdOf = (principal: { userId?: string } | null | undefined): string => {
    if (!principal?.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
    return principal.userId;
  };
  const interactive = (principal: Principal | null | undefined): string => {
    if (!principal || !isInteractivePrincipal(principal)) throw new PortalError('pay.profile_interactive_only', 'forbidden');
    return principal.userId;
  };

  const merchant = {
    myAccess: read
      .input(z.object({}).strict())
      .output(merchantMyAccessSchema)
      .query(({ ctx }) =>
        wrapPortal(async () => {
          const userId = userIdOf(ctx.principal);
          return listMyAccess(deps.sql, userId, ctx.principal ? isInteractivePrincipal(ctx.principal) : false);
        }),
      ),
    businessProfile: router({
      get: read
        .input(merchantPortalMerchantInputSchema)
        .output(merchantBusinessProfileSchema)
        .query(({ ctx, input }) => wrapPortal(async () => profile.get(ctx.principal?.userId, input.merchantId))),
      history: read
        .input(merchantProfileHistoryInputSchema)
        .output(merchantProfileHistorySchema)
        .query(({ ctx, input }) => wrapPortal(async () => profile.history(ctx.principal?.userId, input))),
      submit: profileWrite
        .input(merchantBusinessProfileSubmitInputSchema)
        .output(merchantBusinessProfileSubmitResultSchema)
        .mutation(({ ctx, input }) => wrapPortal(async () => profile.submit(writer(ctx), input))),
      confirm: profileWrite
        .input(merchantBusinessProfileConfirmInputSchema)
        .output(merchantBusinessProfileDecideResultSchema)
        .mutation(({ ctx, input }) => wrapPortal(async () => profile.decide(writer(ctx), input))),
      setSecondApproval: profileWrite
        .input(merchantProfileSecondApprovalInputSchema)
        .output(merchantProfileSecondApprovalResultSchema)
        .mutation(({ ctx, input }) => wrapPortal(async () => profile.setSecondApproval(writer(ctx), input))),
      /**
       * Compliance decide. `admin:compliance`, MFA, and an identity approval,
       * matching `merchant.decideKyb`. A merchant session cannot apply a
       * sensitive identity change through confirm.
       */
      review: compliance
        .input(merchantBusinessProfileReviewInputSchema)
        .output(merchantBusinessProfileReviewResultSchema)
        .mutation(({ ctx, input }) =>
          wrapPortal(async () => {
            requireMfa(ctx.principal);
            const reviewerId = ctx.principal?.userId;
            if (!reviewerId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
            await profile.assertPendingReview(input.merchantId, input.requestId, input.expectedChangeHash);
            const confirmOperatorId = await consumePayApproval(
              approvals,
              input,
              'pay.merchant_profile_review',
              merchantProfileReviewFields({
                merchantId: input.merchantId,
                requestId: input.requestId,
                decision: input.decision,
                expectedChangeHash: input.expectedChangeHash,
                reason: input.reason,
              }),
            );
            const decided = await profile.review(reviewerId, input);
            return { ...decided, confirmOperatorId };
          }),
        ),
    }),
    onboarding: router({
      progress: read
        .input(merchantPortalMerchantInputSchema)
        .output(merchantOnboardingProgressSchema)
        .query(({ ctx, input }) =>
          wrapPortal(async () => {
            const loaded = await profile.get(ctx.principal?.userId, input.merchantId);
            return readOnboardingProgress(deps.sql, deps.pay, deps.trees, deps.team, ctx.principal?.userId, loaded);
          }),
        ),
    }),
    // Not merged as its own `merchant` key: `createPayRouter` already owns that key and spreads this object.
    customerEmails: createMerchantCustomerEmails({ sql: deps.sql }),
  };
  return {
    merchant,
    merchantAnalytics: router({
      volume: read
        .input(merchantAnalyticsInputSchema)
        .output(merchantAnalyticsVolumeSchema)
        .query(({ ctx, input }) => wrapPortal(async () => analytics.volume(ctx.principal?.userId, input))),
      fees: read
        .input(merchantAnalyticsInputSchema)
        .output(merchantAnalyticsFeesSchema)
        .query(({ ctx, input }) => wrapPortal(async () => analytics.fees(ctx.principal?.userId, input))),
    }),
  };
}

/** Standalone mount for tests. The live app folds these into `createPayRouter` so `merchant.*` is one router. */
export function createMerchantPortalRouter(deps: Parameters<typeof merchantPortalExtensions>[0]) {
  const ext = merchantPortalExtensions(deps);
  return router({ merchant: router(ext.merchant), merchantAnalytics: ext.merchantAnalytics });
}

export type MerchantPortalRouter = ReturnType<typeof createMerchantPortalRouter>;

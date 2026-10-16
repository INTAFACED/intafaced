import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  merchantAnalyticsFeesSchema,
  merchantAnalyticsInputSchema,
  merchantAnalyticsVolumeSchema,
  merchantBusinessProfileConfirmInputSchema,
  merchantBusinessProfileDecideResultSchema,
  merchantBusinessProfileSchema,
  merchantBusinessProfileSubmitInputSchema,
  merchantBusinessProfileSubmitResultSchema,
  merchantMyAccessSchema,
  merchantOnboardingProgressSchema,
  merchantPortalMerchantInputSchema,
  merchantProfileHistoryInputSchema,
  merchantProfileHistorySchema,
  router,
  scopedProcedure,
  TRPCError,
} from '@intafaced/contracts';
import type { MerchantAreaFence } from '../merchant-ownership.js';
import type { MerchantTeamRead } from '../merchant-team-read.js';
import { isInteractivePrincipal } from '../merchant-ops/roles.js';
import type { PayService } from '../payment-service.js';
import { listMyAccess } from './access.js';
import { MerchantAnalyticsService } from './analytics.js';
import { PortalError, wrapPortal } from './errors.js';
import { readOnboardingProgress } from './onboarding.js';
import { MerchantProfileService } from './profile.js';

/**
 * Merchant portal procedures.
 *
 * `merchant.myAccess` lists memberships of the signed principal only. It does
 * not take a merchant id, and it does not invent a membership from a merchant
 * row the caller does not own or actively belong to.
 *
 * Profile writes are owner or admin, and only from an interactive session.
 * A PayFac parent that can read a child cannot write that child's profile.
 */
export function merchantPortalExtensions(deps: {
  sql: Sql;
  pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>;
  trees: MerchantAreaFence | null;
  team: MerchantTeamRead;
}) {
  const profile = new MerchantProfileService(deps.sql, deps.pay, deps.trees, deps.team);
  const analytics = new MerchantAnalyticsService(deps.sql, deps.pay, deps.trees, deps.team);
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const write = scopedProcedure('pay:write', { module: 'pay' });

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
      .query(({ ctx }) => wrapPortal(async () => listMyAccess(deps.sql, userIdOf(ctx.principal)))),
    businessProfile: router({
      get: read
        .input(merchantPortalMerchantInputSchema)
        .output(merchantBusinessProfileSchema)
        .query(({ ctx, input }) => wrapPortal(async () => profile.get(ctx.principal?.userId, input.merchantId))),
      history: read
        .input(merchantProfileHistoryInputSchema)
        .output(merchantProfileHistorySchema)
        .query(({ ctx, input }) => wrapPortal(async () => profile.history(ctx.principal?.userId, input))),
      submit: write
        .input(merchantBusinessProfileSubmitInputSchema)
        .output(merchantBusinessProfileSubmitResultSchema)
        .mutation(({ ctx, input }) => wrapPortal(async () => profile.submit(interactive(ctx.principal), input))),
      confirm: write
        .input(merchantBusinessProfileConfirmInputSchema)
        .output(merchantBusinessProfileDecideResultSchema)
        .mutation(({ ctx, input }) => wrapPortal(async () => profile.decide(interactive(ctx.principal), input))),
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

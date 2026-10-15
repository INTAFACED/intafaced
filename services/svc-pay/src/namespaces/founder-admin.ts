import {
  router,
  founderMerchantListInputSchema,
  founderMerchantListSchema,
  founderMerchantDrilldownInputSchema,
  founderMerchantDrilldownSchema,
  founderGlobalMetricsInputSchema,
  founderGlobalMetricsSchema,
  founderChangeSubmitInputSchema,
  founderChangeSubmitResultSchema,
  founderChangeConfirmInputSchema,
  founderApprovalQueueInputSchema,
  founderApprovalQueueSchema,
  founderTreasuryExposureSchema,
} from '@intafaced/contracts';
import { z } from 'zod';
import type { FounderAuthority } from '../founder-authority.js';
import { notBuilt } from './errors.js';
import { founderProcedure } from './founder-procedure.js';

/**
 * `founderAdmin.*` — the global founder panel (W2/W4 replace these stubs).
 *
 * EVERY procedure here MUST be built from `founderProcedure`. Do not use
 * `scopedProcedure('admin:read')`: that scope can sit on a long-lived API key.
 * The static inventory test (G7) fails the build if one is not.
 */
export function createFounderAdminRouter(founderAuthority: FounderAuthority) {
  const founder = founderProcedure(founderAuthority);
  return router({
    founderAdmin: router({
      merchants: router({
        list: founder
          .input(founderMerchantListInputSchema)
          .output(founderMerchantListSchema)
          .query(() => notBuilt('founderAdmin.merchants.list')),
        drilldown: founder
          .input(founderMerchantDrilldownInputSchema)
          .output(founderMerchantDrilldownSchema)
          .query(() => notBuilt('founderAdmin.merchants.drilldown')),
      }),
      metrics: router({
        global: founder
          .input(founderGlobalMetricsInputSchema)
          .output(founderGlobalMetricsSchema)
          .query(() => notBuilt('founderAdmin.metrics.global')),
      }),
      changes: router({
        submit: founder
          .input(founderChangeSubmitInputSchema)
          .output(founderChangeSubmitResultSchema)
          .mutation(() => notBuilt('founderAdmin.changes.submit')),
        confirm: founder
          .input(founderChangeConfirmInputSchema)
          .output(founderChangeSubmitResultSchema)
          .mutation(() => notBuilt('founderAdmin.changes.confirm')),
      }),
      approvals: router({
        list: founder
          .input(founderApprovalQueueInputSchema)
          .output(founderApprovalQueueSchema)
          .query(() => notBuilt('founderAdmin.approvals.list')),
      }),
      treasury: router({
        exposure: founder
          .input(z.object({}).strict())
          .output(founderTreasuryExposureSchema)
          .query(() => notBuilt('founderAdmin.treasury.exposure')),
      }),
    }),
  });
}

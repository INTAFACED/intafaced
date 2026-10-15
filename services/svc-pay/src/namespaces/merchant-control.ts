import { z } from 'zod';
import {
  router,
  scopedProcedure,
  merchantControlGetInputSchema,
  merchantControlProfileSchema,
  merchantControlApprovalListInputSchema,
  merchantControlApprovalDecideInputSchema,
  payoutApprovalSchema,
} from '@intafaced/contracts';
import { notBuilt } from './errors.js';

/**
 * `merchantControl.*` — the merchant-facing control room (W1 replaces these stubs).
 * Operator changes to tier, caps, pricing and reserve are NOT here: they are
 * founder-only and live under `founderAdmin.*`.
 */
export function createMerchantControlRouter() {
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const write = scopedProcedure('pay:write', { module: 'pay' });
  return router({
    merchantControl: router({
      get: read
        .input(merchantControlGetInputSchema)
        .output(merchantControlProfileSchema)
        .query(() => notBuilt('merchantControl.get')),
      approvals: router({
        list: read
          .input(merchantControlApprovalListInputSchema)
          .output(z.array(payoutApprovalSchema))
          .query(() => notBuilt('merchantControl.approvals.list')),
        decide: write
          .input(merchantControlApprovalDecideInputSchema)
          .output(payoutApprovalSchema)
          .mutation(() => notBuilt('merchantControl.approvals.decide')),
      }),
    }),
  });
}

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
import type { Principal } from '@intafaced/auth';
import type { ControlService } from '../control/service.js';
import { toContractApproval } from '../control/approvals.js';
import {
  approvalCancelInputSchema,
  approvalRequestInputSchema,
  pricingPreviewInputSchema,
  pricingQuoteSchema,
  usageInputSchema,
  usageViewSchema,
} from '../control/schemas.js';
import { guarded } from './control-errors.js';
import { notBuilt } from './errors.js';

/**
 * `merchantControl.*` — the merchant-facing control room.
 * Operator changes to tier, caps, pricing and reserve are NOT here: they are
 * founder-only and live under `founderAdmin.*`.
 *
 * Without a `ControlService` (a service built without the control room) every
 * procedure stays the W0 `pay.not_built` stub, so a bare router never answers
 * with made-up data. With one, every procedure is merchant-scoped: another
 * merchant's id and an id that does not exist get the same `pay.merchant_not_found`.
 * The procedures work whatever `PAY_MERCHANT_CONTROLS` says; that switch only
 * decides whether the money-path guards enforce.
 */
export function createMerchantControlRouter(control?: ControlService) {
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const write = scopedProcedure('pay:write', { module: 'pay' });
  const payout = scopedProcedure('pay:payout', { module: 'pay' });

  if (!control) {
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

  const principalOf = (ctx: { principal: Principal | null }): Principal => ctx.principal as Principal;

  return router({
    merchantControl: router({
      get: read
        .input(merchantControlGetInputSchema)
        .output(merchantControlProfileSchema)
        .query(({ ctx, input }) =>
          guarded(async () => {
            await control.assertCanView(principalOf(ctx), input.merchantId);
            return control.profile(input.merchantId);
          }),
        ),
      usage: read
        .input(usageInputSchema)
        .output(usageViewSchema)
        .query(({ ctx, input }) =>
          guarded(async () => {
            await control.assertCanView(principalOf(ctx), input.merchantId);
            return control.usage(input.merchantId);
          }),
        ),
      pricing: router({
        preview: read
          .input(pricingPreviewInputSchema)
          .output(pricingQuoteSchema)
          .query(({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return control.previewPricing(input);
            }),
          ),
      }),
      approvals: router({
        list: read
          .input(merchantControlApprovalListInputSchema)
          .output(z.array(payoutApprovalSchema))
          .query(({ ctx, input }) => guarded(async () => (await control.approvals.list(principalOf(ctx), input)).map(toContractApproval))),
        request: payout
          .input(approvalRequestInputSchema)
          .output(payoutApprovalSchema)
          .mutation(({ ctx, input }) => guarded(async () => toContractApproval(await control.approvals.request(principalOf(ctx), input)))),
        decide: write
          .input(merchantControlApprovalDecideInputSchema)
          .output(payoutApprovalSchema)
          .mutation(({ ctx, input }) => guarded(async () => toContractApproval(await control.approvals.decide(principalOf(ctx), input)))),
        cancel: payout
          .input(approvalCancelInputSchema)
          .output(payoutApprovalSchema)
          .mutation(({ ctx, input }) => guarded(async () => toContractApproval(await control.approvals.cancel(principalOf(ctx), input)))),
      }),
    }),
  });
}

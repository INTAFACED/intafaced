import { z } from 'zod';
import {
  router,
  scopedProcedure,
  merchantControlGetInputSchema,
  merchantControlProfileSchema,
  merchantControlApprovalListInputSchema,
  merchantControlApprovalPageSchema,
  merchantControlApprovalDecideInputSchema,
  merchantTierListInputSchema,
  merchantTierListSchema,
  merchantPricingHistoryInputSchema,
  merchantPricingHistorySchema,
  merchantLimitOpenInputSchema,
  merchantLimitOpenSchema,
  merchantLimitIncreaseInputSchema,
  merchantLimitIncreaseResultSchema,
  merchantLimitWithdrawInputSchema,
  merchantLimitWithdrawResultSchema,
  payoutApprovalSchema,
} from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { ControlError } from '../control/errors.js';
import type { ControlService } from '../control/service.js';
import { isInteractivePrincipal, type MerchantRole } from '../merchant-ops/roles.js';
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
import { merchantReserveViewSchema } from '../merchant-pay-dev-out/reserve-read.js';
import { refuseTopUpUnwired } from '../merchant-pay-dev-out/top-up.js';
import { ownMerchantRead } from '../own-merchant-read.js';

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
/** Who may file or withdraw a cap ask. Reads stay on the wider control-room door. */
const LIMIT_ASK_ROLES = new Set<MerchantRole>(['owner', 'admin', 'finance']);

/**
 * Interactive session only: an API key (`kid`), a session without MFA, or a
 * sub-account is refused before any merchant lookup, so the refusal does not
 * say whether that merchant exists.
 */
async function assertLimitAsk(control: ControlService, principal: Principal, merchantId: string): Promise<void> {
  if (!isInteractivePrincipal(principal)) throw new ControlError('pay.interactive_required');
  await control.assertCanView(principal, merchantId);
  const role = await control.roleOnMerchant(principal, merchantId);
  if (role === null || !LIMIT_ASK_ROLES.has(role)) throw new ControlError('pay.merchant_not_found');
}

export function createMerchantControlRouter(control?: ControlService) {
  const read = ownMerchantRead();
  const write = scopedProcedure('pay:write', { module: 'pay' });
  const payout = scopedProcedure('pay:payout', { module: 'pay' });

  if (!control) {
    return router({
      merchantControl: router({
        get: read
          .input(merchantControlGetInputSchema)
          .output(merchantControlProfileSchema)
          .query(() => notBuilt('merchantControl.get')),
        reserve: read
          .input(merchantControlGetInputSchema)
          .output(merchantReserveViewSchema)
          .query(() => notBuilt('merchantControl.reserve')),
        topUp: router({
          // No answer shape until a top-up rail exists: any answer at all fails the output check.
          options: read
            .input(merchantControlGetInputSchema)
            .output(z.never())
            .query(() => notBuilt('merchantControl.topUp.options')),
        }),
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
      /** M-money-out-01: reserve rule and recorded amounts, labelled recorded and not withheld. */
      reserve: read
        .input(merchantControlGetInputSchema)
        .output(merchantReserveViewSchema)
        .query(({ ctx, input }) =>
          guarded(async () => {
            await control.assertCanView(principalOf(ctx), input.merchantId);
            return control.reserve(input.merchantId);
          }),
        ),
      /**
       * M-money-out-02: what a top-up of this business can use. No top-up rail is wired, so after the ownership
       * check it always refuses `pay.topup_unconfigured` and never invents an instruction (merchant-pay-dev-out/top-up.ts).
       */
      topUp: router({
        // No answer shape until a top-up rail exists: any answer at all fails the output check.
        options: read
          .input(merchantControlGetInputSchema)
          .output(z.never())
          .query(({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return refuseTopUpUnwired();
            }),
          ),
      }),
      usage: read
        .input(usageInputSchema)
        .output(usageViewSchema)
        .query(({ ctx, input }) =>
          guarded(async () => {
            await control.assertCanView(principalOf(ctx), input.merchantId);
            return control.usage(input.merchantId);
          }),
        ),
      tiers: router({
        list: read
          .input(merchantTierListInputSchema)
          .output(merchantTierListSchema)
          .query(({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return control.merchantTierList(input.merchantId);
            }),
          ),
      }),
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
        history: read
          .input(merchantPricingHistoryInputSchema)
          .output(merchantPricingHistorySchema)
          .query(({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return control.pricingHistory(input.merchantId, input.limit);
            }),
          ),
      }),
      limits: router({
        open: read
          .input(merchantLimitOpenInputSchema)
          .output(merchantLimitOpenSchema)
          .query(({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return control.openLimitRequest(input.merchantId);
            }),
          ),
        requestIncrease: write
          .input(merchantLimitIncreaseInputSchema)
          .output(merchantLimitIncreaseResultSchema)
          .mutation(({ ctx, input }) =>
            guarded(async () => {
              const principal = principalOf(ctx);
              await assertLimitAsk(control, principal, input.merchantId);
              return control.requestLimitIncrease(principal, input);
            }),
          ),
        withdraw: write
          .input(merchantLimitWithdrawInputSchema)
          .output(merchantLimitWithdrawResultSchema)
          .mutation(({ ctx, input }) =>
            guarded(async () => {
              const principal = principalOf(ctx);
              await assertLimitAsk(control, principal, input.merchantId);
              return control.withdrawLimitRequest(principal, input);
            }),
          ),
      }),
      approvals: router({
        list: read
          .input(merchantControlApprovalListInputSchema)
          .output(merchantControlApprovalPageSchema)
          .query(({ ctx, input }) =>
            guarded(async () => {
              const page = await control.approvals.list(principalOf(ctx), input);
              return {
                items: page.items.map(toContractApproval),
                nextCursor: page.nextCursor,
                dailyPayoutRemaining: page.dailyPayoutRemaining,
              };
            }),
          ),
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

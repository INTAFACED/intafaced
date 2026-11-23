import { z } from 'zod';
import {
  merchantControlGetInputSchema,
  merchantControlProfileSchema,
  merchantControlApprovalListInputSchema,
  merchantControlApprovalPageSchema,
  merchantControlApprovalDecideInputSchema,
  payoutApprovalSchema,
} from '@intafaced/contracts/merchant-control';
import { router, anyScopeProcedure } from '@intafaced/contracts/trpc';
import type { Principal } from '@intafaced/auth';
import { ControlError } from '../control/errors.js';
import type { ControlService } from '../control/service.js';
import { isInteractivePrincipal, type MerchantRole } from '../merchant-ops/roles.js';
import { toContractApproval } from '../control/approvals.js';
import { guarded } from './control-errors.js';
import { teamMemberWrite } from '../team-member-write.js';
import { notBuilt } from './errors.js';
import { merchantReserveViewSchema } from '@intafaced/contracts/merchant-control';
import { refuseTopUpUnwired } from '../merchant-pay-dev-out/top-up.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import { projectTierList } from '../team-read-projection.js';
import {
  PAY_MERCHANT_CONTROL_GET,
  PAY_MERCHANT_CONTROL_RESERVE,
  PAY_MERCHANT_CONTROL_TOP_UP_OPTIONS,
  PAY_MERCHANT_CONTROL_USAGE,
  PAY_MERCHANT_CONTROL_PRICING_PREVIEW,
  PAY_MERCHANT_CONTROL_APPROVALS_CANCEL,
  PAY_MERCHANT_CONTROL_APPROVALS_REQUEST,
  PAY_MERCHANT_CONTROL_LIMITS_OPEN,
  PAY_MERCHANT_CONTROL_LIMITS_WITHDRAW,
  PAY_MERCHANT_CONTROL_PRICING_HISTORY,
  PAY_MERCHANT_CONTROL_LIMITS_REQUEST_INCREASE,
  PAY_MERCHANT_CONTROL_TIERS_LIST,
} from '@intafaced/contracts/pay-merchant-control-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from '../record-refusal.js';

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
  /**
   * A payout decision is the checker's, and the checkers are the team: admin and finance hold `payout.approve` in the
   * role table, while the owner grant law gives `pay:write` to the owner alone. So deciding is a team member's write
   * (`teamMemberWrite`: an owner on a live `pay:write`, or an active member of a KYB-approved business that is not shut,
   * on `pay:onboard`), and who may decide is the role check in `approvals.decide` (`canApprovePayout`, a person in a live
   * session, never the maker). It moves no money: sending stays the owner's, under `pay:payout`.
   */
  const decide = control
    ? teamMemberWrite(() => control.db)
    : // Not built: the same scopes reach the typed not-built refusal.
      anyScopeProcedure(['pay:write', 'pay:onboard'], { module: 'pay' });

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
          decide: decide
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
      get: mountRecord(
        PAY_MERCHANT_CONTROL_GET,
        ({ ctx, input }) =>
          guarded(async () => {
            await control.assertCanView(principalOf(ctx), input.merchantId);
            return control.profile(input.merchantId);
          }),
        payRefusal,
      ),
      /** M-money-out-01: reserve rule and recorded amounts, labelled recorded and not withheld. */
      reserve: mountRecord(
        PAY_MERCHANT_CONTROL_RESERVE,
        ({ ctx, input }) =>
          guarded(async () => {
            await control.assertCanView(principalOf(ctx), input.merchantId);
            return control.reserve(input.merchantId);
          }),
        payRefusal,
      ),
      /**
       * M-money-out-02: what a top-up of this business can use. No top-up rail is wired, so after the ownership
       * check it always refuses `pay.topup_unconfigured` and never invents an instruction (merchant-pay-dev-out/top-up.ts).
       */
      topUp: router({
        // No answer shape until a top-up rail exists: any answer at all fails the output check.
        options: mountRecord(
          PAY_MERCHANT_CONTROL_TOP_UP_OPTIONS,
          ({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return refuseTopUpUnwired();
            }),
          payRefusal,
        ),
      }),
      usage: mountRecord(
        PAY_MERCHANT_CONTROL_USAGE,
        ({ ctx, input }) =>
          guarded(async () => {
            await control.assertCanView(principalOf(ctx), input.merchantId);
            return control.usage(input.merchantId);
          }),
        payRefusal,
      ),
      tiers: router({
        list: mountRecord(
          PAY_MERCHANT_CONTROL_TIERS_LIST,
          ({ ctx, input }) =>
            guarded(async () => {
              const principal = principalOf(ctx);
              await control.assertCanView(principal, input.merchantId);
              const role = await control.roleOnMerchant(principal, input.merchantId);
              return projectTierList(await control.merchantTierList(input.merchantId), role);
            }),
          payRefusal,
        ),
      }),
      pricing: router({
        preview: mountRecord(
          PAY_MERCHANT_CONTROL_PRICING_PREVIEW,
          ({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return control.previewPricing(input);
            }),
          payRefusal,
        ),
        history: mountRecord(
          PAY_MERCHANT_CONTROL_PRICING_HISTORY,
          ({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return control.pricingHistory(input.merchantId, input.limit);
            }),
          payRefusal,
        ),
      }),
      limits: router({
        open: mountRecord(
          PAY_MERCHANT_CONTROL_LIMITS_OPEN,
          ({ ctx, input }) =>
            guarded(async () => {
              await control.assertCanView(principalOf(ctx), input.merchantId);
              return control.openLimitRequest(input.merchantId);
            }),
          payRefusal,
        ),
        requestIncrease: mountRecord(
          PAY_MERCHANT_CONTROL_LIMITS_REQUEST_INCREASE,
          ({ ctx, input }) =>
            guarded(async () => {
              const principal = principalOf(ctx);
              await assertLimitAsk(control, principal, input.merchantId);
              return control.requestLimitIncrease(principal, input);
            }),
          payRefusal,
        ),
        withdraw: mountRecord(
          PAY_MERCHANT_CONTROL_LIMITS_WITHDRAW,
          ({ ctx, input }) =>
            guarded(async () => {
              const principal = principalOf(ctx);
              await assertLimitAsk(control, principal, input.merchantId);
              return control.withdrawLimitRequest(principal, input);
            }),
          payRefusal,
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
        request: mountRecord(
          PAY_MERCHANT_CONTROL_APPROVALS_REQUEST,
          ({ ctx, input }) => guarded(async () => toContractApproval(await control.approvals.request(principalOf(ctx), input))),
          payRefusal,
        ),
        decide: decide
          .input(merchantControlApprovalDecideInputSchema)
          .output(payoutApprovalSchema)
          .mutation(({ ctx, input }) => guarded(async () => toContractApproval(await control.approvals.decide(principalOf(ctx), input)))),
        cancel: mountRecord(
          PAY_MERCHANT_CONTROL_APPROVALS_CANCEL,
          ({ ctx, input }) => guarded(async () => toContractApproval(await control.approvals.cancel(principalOf(ctx), input))),
          payRefusal,
        ),
      }),
    }),
  });
}

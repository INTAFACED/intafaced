import { z } from 'zod';
import type { Sql } from 'postgres';
import { AuthError, requireMfa } from '@intafaced/auth';
import {
  payCheckoutSettingsGetInputSchema,
  payCheckoutSettingsSchema,
  payCreateLinkInputSchema,
  payCreateLinkOutputSchema,
  payGetLinkInputSchema,
  payLinkListInputSchema,
  payLinkListItemSchema,
  payLinkListPageSchema,
  payMerchantFailureSchema,
  payPageSchema,
  payPaymentListInputSchema,
  payPricingSnapshotViewSchema,
  paySettlementLineSchema,
  paySettlementLinesInputSchema,
  payPayoutDestinationItemSchema,
  payPayoutDestinationListInputSchema,
  payPayoutLifecycleInputSchema,
  payPayoutLifecycleSchema,
  payRefundGetInputSchema,
  payRefundItemSchema,
  payRefundListInputSchema,
  paySettlementListInputSchema,
  payStatementListInputSchema,
  payStatementPageSchema,
  merchantStarterFeeSchema,
  router,
  scopedProcedure,
  anyScopeProcedure,
  publicProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { merchantPortalExtensions } from './merchant-portal/router.js';
import { credentialAuthority } from './payment-authority.js';
import { formatAmount, LedgerError, parseAmount } from '@intafaced/ledger-client';
import { DualControlError } from './dual-control.js';
import {
  ActionApprovalConsumeError,
  consumePayApproval,
  readApprovalIds,
  type ActionApprovalConsumer,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';
import { PAY_MERCHANT_DECIDE_KYB, kybApprovalFields, loadKybDecisionBinding } from './kyb-decision-binding.js';
import { ControlError } from './control/errors.js';
import { toTrpcError as controlToTrpcError } from './namespaces/control-errors.js';
import { PayError, type PayService } from './payment-service.js';
import type { MerchantStarterFee } from './starter-fee.js';
import { DestinationKindError } from './payout-destination.js';
import {
  assertOnlyPayoutDestinations,
  PayoutDestinationMissingError,
  type MerchantPayoutDestinations,
} from './merchant-payout-destination.js';
import type { UserMoneyService, WithdrawalRecord } from './user-money-service.js';
import type { RailRegistry } from './rails/registry.js';
import { RAIL_CAPABILITIES, RAIL_MODES } from './rails/rail-adapter.js';
import { PublicCheckoutUnavailable, SandboxRailRefusal } from './rails/posture.js';
import { PayGuardRefusal } from './seams/guards.js';
import { isInteractivePrincipal, seesFullPricing } from './merchant-ops/roles.js';
import {
  loadDestinationHoldSeconds,
  notifyMerchantOwners,
  PayoutDestinationChange,
  roleOnMerchantForDestination,
  verifyDestinationStepUp,
} from './payout-destination-change.js';
import { assertMerchantAreaAccess, refuseAsMissing, type MerchantAreaFence } from './merchant-ownership.js';
import { allowMerchantRead, type MerchantReadAudience } from './merchant-read-access.js';
import { logPaymentFactsReadFailure } from './payment-facts-log.js';
import { projectPricingSnapshot, projectTeamHistoryEvent } from './team-read-projection.js';
import type { MerchantReadPermission, MerchantTeamRead } from './merchant-team-read.js';
import { merchantNameInputSchema } from './merchant-names.js';
import { areaForSurface, type PayfacSurface } from './payfac-permissions.js';
import { assertRoutingInputsPresent, RoutingInputError } from './routing-inputs.js';
import {
  REFERENCE_RAIL_ROUTING_PROFILES,
  selectSmartCheckoutRail,
  SmartRoutingNoRailError,
  toRoutingDecisionRecord,
  type RailRoutingProfile,
} from './routing/decide.js';
import { evaluateFraud } from './fraud/evaluate.js';
import { describeFraudPolicy } from './fraud/fraud-policy.js';
import { describeRoutingPolicy } from './routing/routing-policy.js';
import { defaultFraudReviewQueue, FraudReviewError, type FraudReviewCase } from './fraud/review-queue.js';
import { PostgresFraudReviewQueue, type DurableReviewCase } from './fraud/review-queue-store.js';
import {
  defaultDisputeCaseStore,
  DisputeCaseError,
  refuseChargebackUncovered,
  type ChargebackLedgerRefuse,
  type DisputeCaseStore,
} from './fraud/dispute-case.js';
import { describeCmsPluginStatus } from './plugins/cms-status.js';
import { describePluginsPolicy } from './plugins/plugins-policy.js';
import {
  CMS_PLUGIN_FAMILIES,
  CMS_PLUGIN_SOCKET,
  getCmsPluginStatus,
  PAY_PLUGIN_CMS_UNWIRED,
  SHIPPED_CMS_PLUGIN_FAMILY,
  UNWIRED_CMS_PLUGIN_FAMILIES,
} from './plugins/cms-unwired.js';
import { PAY_PUBLIC_API_BASE } from './plugins/reference-client.js';

/**
 * svc-pay's internal tRPC surface (§2 — cross-service calls go through
 * packages/contracts).
 *
 * MONEY CROSSES THIS BOUNDARY AS A DECIMAL STRING, always, in both directions.
 * `amountSchema` rejects anything else, including a JSON number, so a caller
 * that has been doing float arithmetic finds out here rather than 18 decimal
 * places later.
 *
 * Every procedure that moves value carries a scope AND the jurisdiction guard
 * (`{ module: 'pay' }`). §22: pay is a custodial Fiat Plane module — value
 * lands in a ledger account we control — so the matrix applies. Lane A
 * (permissionless merchant contracts, §24) is a different service on the
 * Protocol Plane and does not route through here.
 */

const amountSchema = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

const assetIdSchema = z.string().min(1).max(16);

const paymentView = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  profileId: z.string().uuid().nullable(),
  amount: amountSchema,
  assetId: assetIdSchema,
  method: z.string(),
  railAdapter: z.string(),
  railRef: z.string().nullable(),
  status: z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']),
  capturedAmount: amountSchema,
  refundedAmount: amountSchema,
  createdAt: z.string().datetime({ offset: true }),
  /** Stored when the fee was decided. Null when no snapshot row exists. Never recomputed. */
  pricingSnapshot: payPricingSnapshotViewSchema.nullable(),
  /** Catalog code and sentence. Null when the payment has not failed. */
  failure: payMerchantFailureSchema.nullable(),
});

const settlementView = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  window: z.string(),
  assetId: assetIdSchema,
  gross: amountSchema,
  fees: amountSchema,
  net: amountSchema,
  payoutMethod: z.string().nullable(),
  payoutRef: z.string().nullable(),
  status: z.enum(['pending', 'posted', 'paid_out', 'failed']),
});

const settlementDetailView = settlementView.extend({
  createdAt: z.string().datetime({ offset: true }).nullable(),
  sentAt: z.string().datetime({ offset: true }).nullable(),
  settledAt: z.string().datetime({ offset: true }).nullable(),
  failedAt: z.string().datetime({ offset: true }).nullable(),
  failure: payMerchantFailureSchema.nullable(),
  pricingSnapshot: payPricingSnapshotViewSchema.nullable(),
});

/**
 * A checkout session on the wire.
 *
 * NOTHING HERE IDENTIFIES ANYTHING BUT THIS SESSION. No merchantId, no linkId,
 * no paymentId, no railAdapter — the caller is anonymous, so the response
 * carries what one payer needs in order to pay and nothing they could use to
 * enumerate a merchant or correlate two links.
 */
const checkoutSessionView = z.object({
  id: z.string().uuid(),
  status: z.enum(['open', 'completed', 'expired', 'cancelled']),
  label: z.string(),
  amount: amountSchema,
  currency: assetIdSchema,
  method: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  instruction: z.object({ reference: z.string(), amount: amountSchema, currency: assetIdSchema }).nullable(),
});

const depositView = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  assetId: assetIdSchema,
  amount: amountSchema,
  rail: z.string(),
  railRef: z.string(),
  status: z.enum(['pending', 'credited']),
  createdAt: z.string().datetime({ offset: true }),
});

const withdrawalView = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  assetId: assetIdSchema,
  amount: amountSchema,
  rail: z.string(),
  destination: z.object({ kind: z.string(), ref: z.string() }),
  clientRef: z.string(),
  railRef: z.string().nullable(),
  attempts: z.number().int(),
  failureCode: z.string().nullable(),
  status: z.enum(['pending', 'held', 'sent', 'failed']),
  createdAt: z.string().datetime({ offset: true }),
});

type PaymentViewOut = z.infer<typeof paymentView>;
type SettlementViewOut = z.infer<typeof settlementView>;
type SettlementDetailOut = z.infer<typeof settlementDetailView>;
type WithdrawalViewOut = z.infer<typeof withdrawalView>;

function reviewReasons(c: FraudReviewCase | DurableReviewCase): Array<{ ruleId: string; detail: string }> {
  if ('decision' in c) return c.decision.reasons.map((r) => ({ ruleId: r.ruleId, detail: r.detail }));
  return c.reasons.map((r) => ({ ruleId: r.ruleId, detail: r.detail }));
}

/**
 * A merchant may only touch payments/settlements it owns — or, when a PayFac
 * fence is wired, ones it holds the matching permission area over.
 *
 * HOW MERCHANTS RELATE TO USERS. `pay.merchants` carries `user_id` and inserts
 * `ON CONFLICT (user_id) DO NOTHING` (`payment-service.ts`), so there is still
 * exactly one merchant per user. Self-action is ownership. Parent action is
 * area (`payment`, `payment.refund`, `settlement`, `settlement.payout`, …).
 *
 * WHY NOT_FOUND AND NOT FORBIDDEN — a distinct "exists but not yours" answer
 * is an existence oracle, so a foreign id is refused exactly like a missing one
 * (merchant-ownership.ts `merchantNotFound` / `refuseAsMissing`). The real
 * reason is operator-only (isolation-log.ts). Do not reintroduce FORBIDDEN here.
 */
/** Present only for a sandbox API key. Sessions and live keys omit it. */
function sandboxKeyEnv(principal: { key_env?: string } | null | undefined): { keyEnv: 'sandbox' } | Record<string, never> {
  return principal?.key_env === 'sandbox' ? { keyEnv: 'sandbox' } : {};
}

export function createPayRouter(
  pay: PayService,
  rails: RailRegistry,
  userMoney: UserMoneyService,
  trees: MerchantAreaFence | null = null,
  destinations: MerchantPayoutDestinations = assertOnlyPayoutDestinations(),
  approvals: ActionApprovalConsumer = unwiredApprovalConsumer(),
  teamReads: MerchantTeamRead | null = null,
  disputeCases: DisputeCaseStore = defaultDisputeCaseStore,
  /** Portal profile, onboarding, and analytics. Absent in unit stubs that do not pass a database. */
  portalSql: Sql | null = null,
  /** Local-test starter fee. Null means the product fee is not set yet. */
  starterFee: MerchantStarterFee | null = null,
) {
  const fraudReviews =
    portalSql && typeof portalSql.unsafe === 'function' && typeof portalSql.json === 'function'
      ? new PostgresFraudReviewQueue(portalSql)
      : null;

  const destinationChange = new PayoutDestinationChange(
    destinations,
    async (userId, merchantId) => {
      if (!portalSql) throw new PayError('Payout destination changes need the pay database', 'pay.payout_destination_missing');
      return roleOnMerchantForDestination(portalSql, userId, merchantId);
    },
    verifyDestinationStepUp,
    approvals,
    loadDestinationHoldSeconds(process.env.PAY_DESTINATION_HOLD_SECONDS),
    portalSql
      ? notifyMerchantOwners(portalSql)
      : async () => {
          throw new PayError('Payout destination changes need the pay database', 'pay.payout_destination_missing');
        },
  );

  const setDestination = (
    principal: { userId: string; sid: string; kid?: string; mfa?: boolean; sub_account?: string } | null | undefined,
    input: {
      merchantId: string;
      railId: string;
      kind: string;
      ref: string;
      stepUpApprovalId?: string | null;
    },
  ) => {
    if (principal == null || !principal.userId || !principal.sid) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
    }
    return destinationChange.set({
      caller: {
        userId: principal.userId,
        sessionId: principal.sid,
        viaApiKey: principal.kid !== undefined,
        interactive: isInteractivePrincipal(principal),
      },
      merchantId: input.merchantId,
      railId: input.railId,
      kind: input.kind,
      ref: input.ref,
      stepUpApprovalId: input.stepUpApprovalId,
    });
  };

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toTrpcError(err);
    }
  };

  const assertAccess = (principalUserId: string | undefined, merchantId: string, surface: PayfacSurface) =>
    assertMerchantAreaAccess(pay, principalUserId, merchantId, areaForSurface(surface), trees);

  /**
   * Reads: the owner (or a PayFac area grant), or an active team member whose
   * role holds the read. Writes stay on `assertAccess` alone.
   */
  const assertRead = (
    principalUserId: string | undefined,
    merchantId: string,
    surface: PayfacSurface,
    permission: MerchantReadPermission,
  ) =>
    allowMerchantRead({
      ownerCheck: () => assertAccess(principalUserId, merchantId, surface),
      team: teamReads,
      userId: principalUserId,
      merchantId,
      permission,
    });

  /** Fence on a payment's merchant; somebody else's payment id reads as a payment that does not exist. */
  const assertPaymentAccess = (principalUserId: string | undefined, paymentId: string, merchantId: string, surface: PayfacSurface) =>
    refuseAsMissing(
      assertAccess(principalUserId, merchantId, surface),
      () => new PayError(`Payment ${paymentId} not found`, 'pay.payment_not_found'),
    );
  const assertSettlementAccess = (principalUserId: string | undefined, settlementId: string, merchantId: string, surface: PayfacSurface) =>
    refuseAsMissing(
      assertAccess(principalUserId, merchantId, surface),
      () => new PayError(`Settlement ${settlementId} not found`, 'pay.settlement_not_found'),
    );
  const assertPaymentRead = (principalUserId: string | undefined, paymentId: string, merchantId: string) =>
    refuseAsMissing(
      assertRead(principalUserId, merchantId, 'trpc.payment.get', 'payments.read'),
      () => new PayError(`Payment ${paymentId} not found`, 'pay.payment_not_found'),
    );
  const assertSettlementRead = (principalUserId: string | undefined, settlementId: string, merchantId: string) =>
    refuseAsMissing(
      assertRead(principalUserId, merchantId, 'trpc.settlement.get', 'settlements.read'),
      () => new PayError(`Settlement ${settlementId} not found`, 'pay.settlement_not_found'),
    );

  const paymentOut = async (
    view: Awaited<ReturnType<PayService['getPayment']>>,
    audience: MerchantReadAudience,
    afterCommit: boolean,
  ): Promise<PaymentViewOut> => {
    let facts: { pricingSnapshot: { fee: string } | null; failure: PaymentViewOut['failure'] } = {
      pricingSnapshot: null,
      failure: null,
    };
    try {
      facts = (await pay.paymentFacts?.(view.id)) ?? facts;
    } catch (err) {
      // The mutation has committed. A facts read must not turn that into an error
      // the client will retry.
      if (!afterCommit) throw err;
      logPaymentFactsReadFailure(view.id);
    }
    return {
      ...toPaymentOut(view),
      pricingSnapshot: projectPricingSnapshot(facts.pricingSnapshot, audience),
      failure: facts.failure,
    };
  };

  const settlementDetailOut = (row: Parameters<typeof toSettlementDetail>[0], audience: MerchantReadAudience): SettlementDetailOut => {
    const detail = toSettlementDetail(row);
    return { ...detail, pricingSnapshot: projectPricingSnapshot(detail.pricingSnapshot, audience) };
  };

  const portal = portalSql && teamReads ? merchantPortalExtensions({ sql: portalSql, pay, trees, team: teamReads, approvals }) : null;

  return router({
    health: publicProcedure
      .output(z.object({ ok: z.literal(true), service: z.string(), rails: z.array(z.string()) }))
      .query(() => ({ ok: true as const, service: 'svc-pay', rails: rails.ids() })),

    /** Public payment-link resolve — checkout intent only, no merchant secrets. */
    resolveLink: publicProcedure
      .input(z.object({ token: z.string().min(8).max(200) }))
      .output(
        z.object({
          id: z.string().uuid(),
          merchantId: z.string().uuid(),
          profileId: z.string().uuid().nullable(),
          label: z.string(),
          amount: amountSchema.nullable(),
          currency: z.string().nullable(),
          expiresAt: z.string().nullable(),
          remainingUses: z.number().int().nullable(),
          checkoutConfig: z.record(z.unknown()),
        }),
      )
      .query(({ input }) => wrap(() => pay.resolvePaymentLink(input.token))),

    /**
     * HOSTED CHECKOUT — the public, unauthenticated payment path (§6.1).
     *
     * `publicProcedure`, deliberately and unavoidably: it takes money from
     * somebody who is not logged in, which is what a hosted checkout IS. What
     * makes that safe is not a scope, because there is no principal to hang one
     * on. It is the four properties the service enforces:
     *
     *   · THE AMOUNT IS NOT THE CALLER'S. On a fixed-amount link the input
     *     `amount` is ignored outright — not compared, not validated against the
     *     link, ignored — and the session freezes the link's number.
     *   · THERE IS NO RAIL INPUT, AND THERE WILL NOT BE ONE. The rail is chosen
     *     server-side from `PAY_CHECKOUT_RAILS` via smart routing (geo/method/risk).
     *     A hosted checkout that can name a rail is the route back to the
     *     sandbox-withdrawal P0. Country is a routing dim, not a rail name.
     *     Risk comes from operator `PAY_CHECKOUT_RISK_BAND`, never the payer.
     *   · A SANDBOX RAIL IS REFUSED on the public surface under `live-only`,
     *     even though sandbox `authorize`/`capture` are allowed on the merchant
     *     integration path. See `assertRailMayAcceptPublicPayment`.
     *   · THE SESSION IS NOT A PAYMENT AUTHORITY. Nothing here can mark anything
     *     paid; only a verified rail webhook can.
     */
    checkout: router({
      open: publicProcedure
        .input(
          z.object({
            token: z.string().min(8).max(200),
            /** Honoured only on a link that fixes no amount. Otherwise ignored. */
            amount: amountSchema.optional(),
            /** Honoured only on a link that fixes no currency. Otherwise ignored. */
            assetId: assetIdSchema.optional(),
            /** Payer-stated ISO country. Blank → pay.routing_input_missing. Not a rail id. */
            geoCountry: z.string().max(8).optional(),
            /** Method (`crypto`/`card`), never a rail adapter id. */
            method: z.string().max(32).optional(),
          }),
        )
        .output(z.object({ sessionToken: z.string(), session: checkoutSessionView }))
        .mutation(({ input }) =>
          wrap(async () => {
            const { sessionToken, session } = await pay.openCheckoutSession({
              linkToken: input.token,
              amount: input.amount === undefined ? undefined : parseAmount(input.amount),
              assetId: input.assetId,
              geoCountry: input.geoCountry,
              method: input.method,
            });
            return { sessionToken, session };
          }),
        ),

      /**
       * Poll a session by its OWN token.
       *
       * A separate token from the link's, because a link is a many-payer
       * capability and a session is one payer's: addressing sessions by the link
       * token would let anybody holding the URL read a stranger's checkout.
       */
      status: publicProcedure
        .input(z.object({ sessionToken: z.string().min(8).max(200) }))
        .output(checkoutSessionView)
        .query(({ input }) => wrap(() => pay.getCheckoutSession(input.sessionToken))),
    }),

    /**
     * What an operator dashboard renders, and what routing will read (§6.1).
     *
     * `mode` is on the wire because `usable: true, healthy: true` is what this
     * endpoint said about `card-sandbox` — and it was accurate and useless. A
     * console cannot answer "can users withdraw today" from health alone; a
     * sandbox is perfectly healthy at simulating.
     */
    railHealth: scopedProcedure('pay:read', { module: 'pay' })
      .output(
        z.array(
          z.object({
            id: z.string(),
            /**
             * DERIVED FROM THE PORT, not restated here.
             *
             * These two were hand-written literal unions — a second copy of a
             * vocabulary that already has an authority in `rails/rail-adapter.ts`.
             * The copy is what goes stale. Widening `RailCapability` for card
             * operations, or `RailMode` to carry `absent`, left this schema
             * narrower than the thing it describes, and a zod OUTPUT schema that
             * is narrower than its payload does not report a drift: it throws at
             * serialisation time, on an operator dashboard, in production.
             *
             * Reading the constants makes the compiler the thing that notices,
             * which it did — this line failed to build the moment the port grew.
             */
            capabilities: z.array(z.enum(RAIL_CAPABILITIES)),
            mode: z.enum(RAIL_MODES),
            usable: z.boolean(),
            healthy: z.boolean(),
            latencyMs: z.number(),
            reason: z.string().optional(),
          }),
        ),
      )
      .query(() =>
        rails.health().map((h) => ({
          id: h.id,
          capabilities: [...h.capabilities],
          mode: h.mode,
          usable: h.usable,
          healthy: h.healthy,
          latencyMs: h.latencyMs,
          reason: h.reason,
        })),
      ),

    merchant: router({
      ...(portal?.merchant ?? {}),
      /**
       * Ownership: userId is always the authenticated principal. Body userId
       * was dropped so a caller with pay:write cannot create a merchant under
       * another account (full audit L2-1).
       * Door is pay:onboard. Client mode and pricing are ignored: the server
       * starter fee and gateway mode are the only account this door opens.
       */
      create: scopedProcedure('pay:onboard', { module: 'pay' })
        .input(
          z.object({
            mode: z.enum(['gateway', 'psp', 'payfac']).default('gateway'),
            pricing: z.object({ feeBps: z.number().int().min(0).max(10_000) }),
            settlementPrefs: z.record(z.unknown()).optional(),
            /** Optional names (0071). Stored once, for the signed-in principal's own merchant only. */
            displayName: merchantNameInputSchema.optional(),
            legalName: merchantNameInputSchema.optional(),
          }),
        )
        .output(z.object({ id: z.string().uuid(), userId: z.string().uuid(), mode: z.string(), feeBps: z.number().nullable() }))
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const userId = ctx.principal?.userId;
            if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
            if (!starterFee) {
              throw new PayError(
                'The starter fee is not published. An account cannot be opened until it is.',
                'pay.starter_fee_unpublished',
              );
            }
            const merchant = await pay.createMerchant({
              userId,
              mode: 'gateway',
              pricing: { feeBps: starterFee.bps },
              settlementPrefs: input.settlementPrefs,
              displayName: input.displayName,
              legalName: input.legalName,
            });
            return { id: merchant.id, userId: merchant.userId, mode: merchant.mode, feeBps: merchant.pricing.feeBps ?? null };
          }),
        ),

      /**
       * Add or change the stored payout destination. Step-up, owner or admin,
       * never an API key. A payout cannot call this. The first destination is
       * active after step-up. A change stays pending until the hold passes.
       */
      setPayoutDestination: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            railId: z.string().min(1),
            kind: z.string().min(1),
            ref: z.string().min(1),
            stepUpApprovalId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            kind: z.string(),
            ref: z.string(),
            railId: z.string(),
            status: z.enum(['active', 'pending']),
            activatesAt: z.string().nullable(),
          }),
        )
        .mutation(({ ctx, input }) => wrap(async () => setDestination(ctx.principal, input))),

      /** Current merchant for the principal — null when not yet onboarded. */
      me: anyScopeProcedure(['pay:onboard', 'pay:read'], { module: 'pay' })
        .output(
          z
            .object({
              id: z.string().uuid(),
              userId: z.string().uuid(),
              mode: z.enum(['gateway', 'psp', 'payfac']),
              status: z.enum(['pending', 'active', 'suspended', 'closed']),
              kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
              kybRef: z.string().nullable(),
              feeBps: z.number().nullable(),
              /** Null when the starter fee is not set. `local_test` is not INTAFACED pricing. */
              starterFee: merchantStarterFeeSchema.nullable(),
            })
            .nullable(),
        )
        .query(({ ctx }) =>
          wrap(async () => {
            const userId = ctx.principal?.userId;
            if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
            const merchant = await pay.getMerchantByUserId(userId);
            if (!merchant) return null;
            return {
              id: merchant.id,
              userId: merchant.userId,
              mode: merchant.mode,
              status: merchant.status,
              kybStatus: merchant.kybStatus,
              kybRef: merchant.kybRef,
              feeBps: merchant.pricing.feeBps ?? null,
              starterFee,
            };
          }),
        ),

      /**
       * The published starter fee, including for a caller who has no merchant yet.
       * Null means the fee is not configured.
       */
      starterFee: anyScopeProcedure(['pay:onboard', 'pay:read'], { module: 'pay' })
        .output(z.object({ starterFee: merchantStarterFeeSchema.nullable() }))
        .query(() => ({ starterFee })),

      /**
       * KYB stub submit — dossier reference only. Does not invent a partner decision.
       * Digital KYB vendors are `pay.psp`.
       */
      submitKyb: scopedProcedure('pay:onboard', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid(), kybRef: z.string().min(1).max(128) }))
        .output(
          z.object({
            id: z.string().uuid(),
            kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
            kybRef: z.string().nullable(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.submitKyb');
            const merchant = await pay.submitKyb(input);
            return { id: merchant.id, kybStatus: merchant.kybStatus, kybRef: merchant.kybRef };
          }),
        ),

      /**
       * Operator digital-KYB decide (`pay.psp`). `admin:compliance` — not merchant `pay:write`.
       * Works under live-only. Does not invent a vendor, fee bps, or Layer A scopes.
       * No merchant-ownership fence: the operator is not the merchant.
       *
       * Identity action-bound approval is the second person. Typed-in
       * `confirmOperatorId` is attribution at most. MFA is still required locally
       * (`admin:compliance` is not INTERACTIVE_ONLY). Missing approval ids refuse.
       *
       * The approval hash is the live identity hash. A proposal filed against
       * an older identity does not consume. The proposer reads
       * `kyb.decisionBinding` and sends the same fields to identity
       * (`kybDecisionPayloadHash`). The consume runs under the merchant row
       * lock, after that identity still matches, and before the status write.
       */
      decideKyb: scopedProcedure('admin:compliance', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            decision: z.enum(['approved', 'rejected']),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            id: z.string().uuid(),
            kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
            kybRef: z.string().nullable(),
            confirmOperatorId: z.string(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            requireMfa(ctx.principal);
            readApprovalIds(input);
            if (!portalSql) {
              throw new PayError('KYB decide cannot bind the merchant profile', 'pay.kyb_profile_unbound');
            }
            const binding = await loadKybDecisionBinding(portalSql, input.merchantId);
            if (!binding) throw new PayError(`Merchant ${input.merchantId} not found`, 'pay.merchant_not_found');
            let confirmOperatorId = '';
            const merchant = await pay.decideKyb({
              merchantId: input.merchantId,
              decision: input.decision,
              identityHash: binding.identityHash,
              beforeWrite: async () => {
                confirmOperatorId = await consumePayApproval(
                  approvals,
                  input,
                  PAY_MERCHANT_DECIDE_KYB,
                  kybApprovalFields({
                    merchantId: binding.merchantId,
                    decision: input.decision,
                    identityHash: binding.identityHash,
                  }),
                );
              },
            });
            return { id: merchant.id, kybStatus: merchant.kybStatus, kybRef: merchant.kybRef, confirmOperatorId };
          }),
        ),

      /**
       * KYB stub decide — allowed only when valueMovement is allow-sandbox.
       * Under live-only → `pay.kyb_operator_required` (use `merchant.decideKyb`).
       */
      decideKybStub: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid(), decision: z.enum(['approved', 'rejected']) }))
        .output(
          z.object({
            id: z.string().uuid(),
            kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
            kybRef: z.string().nullable(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.decideKybStub');
            const merchant = await pay.decideKybStub(input);
            return { id: merchant.id, kybStatus: merchant.kybStatus, kybRef: merchant.kybRef };
          }),
        ),

      profile: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            checkoutConfig: z.record(z.unknown()).optional(),
            feeRouting: z.record(z.unknown()).optional(),
            domains: z.array(z.string()).optional(),
          }),
        )
        .output(z.object({ id: z.string().uuid(), merchantId: z.string().uuid() }))
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.profile');
            return pay.createProfile(input);
          }),
        ),

      /**
       * The checkout profile the write above stored, newest row for this merchant.
       * No row is `not_configured`. Same area as the write (`checkout.profile`).
       * `feeRouting` is null unless the caller sees full pricing. `checkoutConfig` stays.
       */
      checkoutSettings: router({
        get: scopedProcedure('pay:read', { module: 'pay' })
          .input(payCheckoutSettingsGetInputSchema)
          .output(payCheckoutSettingsSchema)
          .query(({ ctx, input }) =>
            wrap(async () => {
              const audience = await assertRead(
                ctx.principal?.userId,
                input.merchantId,
                'trpc.merchant.checkoutSettings.get',
                'profile.read',
              );
              const settings = await pay.getCheckoutSettings(input.merchantId);
              if (settings.status !== 'configured' || seesFullPricing(audience)) return settings;
              return { ...settings, feeRouting: null };
            }),
          ),
      }),

      /**
       * Hosted checkout pointer. The token is the checkout credential.
       * Same key and same body returns the original link, including that token.
       * Same key and a different body is `pay.idempotency_conflict`.
       */
      createLink: scopedProcedure('pay:write', { module: 'pay' })
        .input(payCreateLinkInputSchema)
        .output(payCreateLinkOutputSchema)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.createLink');
            if (input.idempotencyKey !== undefined) {
              const key = input.idempotencyKey.trim();
              if (!key || key.length > 255) {
                throw new PayError('Idempotency-Key must be 1 to 255 characters. Nothing was written.', 'pay.idempotency_required');
              }
            }
            const link = await pay.createPaymentLink({
              merchantId: input.merchantId,
              label: input.label,
              profileId: input.profileId,
              amount: input.amount === undefined ? undefined : parseAmount(input.amount),
              currency: input.currency,
              // `undefined`, NOT `null`. This line used to pass `null` when the
              // caller omitted an expiry, which the service reads as "never
              // expires" and now refuses outright — a payment link is a
              // capability URL, and an omitted expiry has to mean the default
              // rather than forever.
              expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
              maxUses: input.maxUses,
              idempotencyKey: input.idempotencyKey,
            });
            return { ...link, expiresAt: link.expiresAt.toISOString() };
          }),
        ),

      listLinks: scopedProcedure('pay:read', { module: 'pay' })
        .input(payLinkListInputSchema)
        .output(payLinkListPageSchema)
        .query(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.listLinks');
            return pay.listPaymentLinks(input.merchantId, input);
          }),
        ),

      /**
       * One link, including its checkout path when the credential was stored.
       * Same gate as listLinks: the owner, or a PayFac grant of `payment.link`.
       * The team role table has no link permission, so a stored role is not the owner.
       */
      getLink: scopedProcedure('pay:read', { module: 'pay' })
        .input(payGetLinkInputSchema)
        .output(payLinkListItemSchema)
        .query(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.getLink');
            return pay.getPaymentLink(input.merchantId, input.linkId);
          }),
        ),

      deactivateLink: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid(), linkId: z.string().uuid() }))
        .output(z.object({ deactivated: z.boolean() }))
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.deactivateLink');
            return pay.deactivatePaymentLink(input.merchantId, input.linkId);
          }),
        ),

      /**
       * What we owe this merchant but have not settled, and the settled proceeds
       * they can pay out. Not the owner's trading balance. Both read from the
       * LEDGER, not from svc-pay's tables —
       * the two are independent on purpose, which is what makes reconciliation
       * meaningful (Doctrine §0.6).
       */
      balances: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid(), assetId: assetIdSchema }))
        .output(z.object({ clearing: amountSchema, available: amountSchema }))
        .query(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.balances');
            return {
              clearing: formatAmount(await pay.clearingBalance(input.merchantId, input.assetId)),
              available: formatAmount(await pay.merchantBalance(input.merchantId, input.assetId)),
            };
          }),
        ),

      /**
       * Saved destinations for this merchant. Masked. Screening is not stored,
       * so that field stays `not_recorded`. A default flag is `default` only
       * after the owner marks the row, otherwise `unset`.
       * `change` and `merchant.setPayoutDestination` are the step-up door.
       * Remove applies only to unverified rows. A verified destination
       * changes only through step-up plus the hold. set-default is an owner
       * write and does not change the paid ref.
       * Remove of an unverified row refuses while a payout that names the
       * destination is in flight.
       */
      payoutDestinations: router({
        change: scopedProcedure('pay:write', { module: 'pay' })
          .input(
            z.object({
              merchantId: z.string().uuid(),
              railId: z.string().min(1),
              kind: z.string().min(1),
              ref: z.string().min(1),
              stepUpApprovalId: z.string().max(128).nullish(),
            }),
          )
          .output(
            z.object({
              kind: z.string(),
              ref: z.string(),
              railId: z.string(),
              status: z.enum(['active', 'pending']),
              activatesAt: z.string().nullable(),
            }),
          )
          .mutation(({ ctx, input }) => wrap(async () => setDestination(ctx.principal, input))),
        list: scopedProcedure('pay:read', { module: 'pay' })
          .input(payPayoutDestinationListInputSchema)
          .output(payPageSchema(payPayoutDestinationItemSchema))
          .query(({ ctx, input }) =>
            wrap(async () => {
              await assertRead(ctx.principal?.userId, input.merchantId, 'trpc.merchant.payoutDestinations.list', 'settlements.read');
              return pay.listPayoutDestinations(input);
            }),
          ),
        setDefault: scopedProcedure('pay:write', { module: 'pay' })
          .input(z.object({ merchantId: z.string().uuid(), destinationId: z.string().uuid() }))
          .output(payPayoutDestinationItemSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.payoutDestinations.setDefault');
              return pay.setDefaultPayoutDestination(input);
            }),
          ),
        remove: scopedProcedure('pay:write', { module: 'pay' })
          .input(z.object({ merchantId: z.string().uuid(), destinationId: z.string().uuid() }))
          .output(z.object({ removed: z.literal(true) }))
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.merchant.payoutDestinations.remove');
              return pay.removePayoutDestination(input);
            }),
          ),
      }),

      /**
       * Ledger statement. Needs both the payment read and the settlement read:
       * one page shows captures and payouts. Reserve is `not_booked`.
       */
      statement: router({
        list: scopedProcedure('pay:read', { module: 'pay' })
          .input(payStatementListInputSchema)
          .output(payStatementPageSchema)
          .query(({ ctx, input }) =>
            wrap(async () => {
              await assertRead(ctx.principal?.userId, input.merchantId, 'trpc.payment.list', 'payments.read');
              await assertRead(ctx.principal?.userId, input.merchantId, 'trpc.settlement.list', 'settlements.read');
              return pay.listStatement(input);
            }),
          ),
      }),
    }),

    ...(portal ? { merchantAnalytics: portal.merchantAnalytics } : {}),

    payment: router({
      create: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            requestId: z.string().uuid().optional(),
            merchantId: z.string().uuid(),
            profileId: z.string().uuid().nullish(),
            amount: amountSchema,
            assetId: assetIdSchema,
            method: z.string().min(1),
            railAdapter: z.string().min(1),
            instrument: z.object({ kind: z.string(), token: z.string().optional(), address: z.string().optional() }).optional(),
            customerRef: z.string().optional(),
            metadata: z.record(z.string()).optional(),
          }),
        )
        .output(paymentView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.payment.create');
            return paymentOut(
              await pay.createPayment({
                ...input,
                profileId: input.profileId ?? null,
                amount: parseAmount(input.amount),
                identityAuthority: credentialAuthority(ctx.principal),
                ...sandboxKeyEnv(ctx.principal),
              }),
              'owner',
              true,
            );
          }),
        ),

      authorize: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ paymentId: z.string().uuid() }))
        .output(paymentView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const payment = await pay.getPayment(input.paymentId);
            await assertPaymentAccess(ctx.principal?.userId, input.paymentId, payment.merchantId, 'trpc.payment.authorize');
            return paymentOut(
              await pay.authorize(input.paymentId, { identityAuthority: credentialAuthority(ctx.principal) }),
              'owner',
              true,
            );
          }),
        ),

      capture: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ paymentId: z.string().uuid(), amount: amountSchema.optional() }))
        .output(paymentView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const payment = await pay.getPayment(input.paymentId);
            await assertPaymentAccess(ctx.principal?.userId, input.paymentId, payment.merchantId, 'trpc.payment.capture');
            return paymentOut(
              await pay.capture(input.paymentId, {
                ...(input.amount === undefined ? {} : { amount: parseAmount(input.amount) }),
                identityAuthority: credentialAuthority(ctx.principal),
                ...sandboxKeyEnv(ctx.principal),
              }),
              'owner',
              true,
            );
          }),
        ),

      /** Its own scope. Refunding is not the same authority as taking payment. */
      refund: scopedProcedure('pay:refund', { module: 'pay' })
        // refundId is the caller's idempotency key. Without it the service invented
        // `${paymentId}:${count + 1}`, so a client retry of a PARTIAL refund that had
        // already succeeded booked a second refund. A retry must carry the same id.
        .input(
          z.object({
            paymentId: z.string().uuid(),
            amount: amountSchema,
            refundId: z
              .string()
              .min(1)
              .max(200)
              .refine((id) => id.trim().length > 0, 'refundId must not be blank'),
          }),
        )
        .output(paymentView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const payment = await pay.getPayment(input.paymentId);
            await assertPaymentAccess(ctx.principal?.userId, input.paymentId, payment.merchantId, 'trpc.payment.refund');
            return paymentOut(
              await pay.refund(input.paymentId, parseAmount(input.amount), {
                refundId: input.refundId,
                ...sandboxKeyEnv(ctx.principal),
              }),
              'owner',
              true,
            );
          }),
        ),

      get: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ paymentId: z.string().uuid() }))
        .output(paymentView)
        .query(({ ctx, input }) =>
          wrap(async () => {
            // Fetched, then checked, then returned. The row has to be read to
            // learn which merchant it belongs to — so what the check protects
            // is the RESPONSE, and it must come before the return, not after
            // the caller has the object.
            const payment = await pay.getPayment(input.paymentId);
            const audience = await assertPaymentRead(ctx.principal.userId, input.paymentId, payment.merchantId);
            return paymentOut(payment, audience, false);
          }),
        ),

      /** Durable status list for the merchant — projection of `payments.status`. */
      list: scopedProcedure('pay:read', { module: 'pay' })
        .input(payPaymentListInputSchema)
        .output(payPageSchema(paymentView))
        .query(({ ctx, input }) =>
          wrap(async () => {
            const audience = await assertRead(ctx.principal.userId, input.merchantId, 'trpc.payment.list', 'payments.read');
            const page = await pay.listPayments(input);
            return {
              items: page.items.map((item) => ({
                ...toPaymentOut(item),
                pricingSnapshot: projectPricingSnapshot(item.pricingSnapshot, audience),
                failure: item.failure,
              })),
              nextCursor: page.nextCursor,
            };
          }),
        ),

      /** The append-only state history (§6.1). Read-only, by construction. */
      history: scopedProcedure('pay:read', { module: 'pay' })
        .input(
          z.object({
            paymentId: z.string().uuid(),
            /**
             * Page size. Optional so omit reaches `pay.payment_history_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(
          z.array(
            z.union([
              z.object({
                id: z.string().uuid(),
                event: z.string(),
                payload: z.record(z.unknown()),
                railEventId: z.string().nullable(),
                ts: z.string().datetime({ offset: true }),
              }),
              z
                .object({
                  id: z.string().uuid(),
                  event: z.string(),
                  ts: z.string().datetime({ offset: true }),
                  amount: amountSchema.nullable(),
                  assetId: assetIdSchema.nullable(),
                  failure: payMerchantFailureSchema.nullable(),
                })
                .strict(),
            ]),
          ),
        )
        .query(({ ctx, input }) =>
          wrap(async () => {
            // The payment row is read first only to learn its merchant; the
            // event log is never touched for a caller who does not own it.
            // `payment_events` carries instrument metadata, customer refs and
            // rail references, so this is the more sensitive of the two reads.
            // A team role gets the allowlisted projection. The owner keeps the payload.
            const payment = await pay.getPayment(input.paymentId);
            const audience = await assertPaymentRead(ctx.principal.userId, input.paymentId, payment.merchantId);
            const events = await pay.history(input.paymentId, input.limit);
            if (audience === 'owner') {
              return events.map((e) => ({
                id: e.id,
                event: e.event,
                payload: e.payload,
                railEventId: e.railEventId,
                ts: e.ts.toISOString(),
              }));
            }
            return events.map((e) => projectTeamHistoryEvent(e));
          }),
        ),

      /** Account-wide refund projection. The write stays on `payment.refund`. */
      refunds: router({
        list: scopedProcedure('pay:read', { module: 'pay' })
          .input(payRefundListInputSchema)
          .output(payPageSchema(payRefundItemSchema))
          .query(({ ctx, input }) =>
            wrap(async () => {
              await assertRead(ctx.principal?.userId, input.merchantId, 'trpc.payment.refunds.list', 'payments.read');
              return pay.listRefunds(input);
            }),
          ),

        get: scopedProcedure('pay:read', { module: 'pay' })
          .input(payRefundGetInputSchema)
          .output(payRefundItemSchema)
          .query(({ ctx, input }) =>
            wrap(async () => {
              const located = await pay.locateRefund(input.refundEventId);
              await refuseAsMissing(
                assertRead(ctx.principal.userId, located.merchantId, 'trpc.payment.refunds.get', 'payments.read'),
                () => new PayError(`Refund ${input.refundEventId} not found`, 'pay.refund_not_found'),
              );
              return pay.readRefund(input.refundEventId);
            }),
          ),
      }),
    }),

    settlement: router({
      run: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid(), window: z.string().min(1), assetId: assetIdSchema }))
        .output(settlementView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.settlement.run');
            return toSettlementOut(await pay.settleWindow({ ...input, ...sandboxKeyEnv(ctx.principal) }));
          }),
        ),

      /** Value leaves the book here, so it carries its own scope. */
      payout: scopedProcedure('pay:payout', { module: 'pay' })
        .input(
          z.object({
            settlementId: z.string().uuid(),
            railId: z.string().min(1),
            destination: z.object({ kind: z.string().min(1), ref: z.string().min(1) }).optional(),
          }),
        )
        .output(settlementView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const settlement = await pay.getSettlement(input.settlementId);
            await assertSettlementAccess(ctx.principal?.userId, input.settlementId, settlement.merchantId, 'trpc.settlement.payout');
            if (input.destination !== undefined) {
              throw new PayError('A payout cannot name a destination', 'pay.payout_destination_not_allowed');
            }
            return toSettlementOut(
              await pay.payoutSettlement({
                settlementId: input.settlementId,
                railId: input.railId,
                identityAuthority: credentialAuthority(ctx.principal),
                ...sandboxKeyEnv(ctx.principal),
              }),
            );
          }),
        ),

      get: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ settlementId: z.string().uuid() }))
        .output(settlementDetailView)
        .query(({ ctx, input }) =>
          wrap(async () => {
            // A settlement names gross, fees and net for a window — another
            // merchant's revenue and the rate we charge them.
            const settlement = pay.readSettlement
              ? await pay.readSettlement(input.settlementId)
              : await pay.getSettlement(input.settlementId);
            const audience = await assertSettlementRead(ctx.principal.userId, input.settlementId, settlement.merchantId);
            return settlementDetailOut(settlement, audience);
          }),
        ),

      /**
       * Merchant fleet list (ops truth). Read-only — no freeze, no payout.
       */
      list: scopedProcedure('pay:read', { module: 'pay' })
        .input(paySettlementListInputSchema)
        .output(payPageSchema(settlementDetailView))
        .query(({ ctx, input }) =>
          wrap(async () => {
            const audience = await assertRead(ctx.principal?.userId, input.merchantId, 'trpc.settlement.list', 'settlements.read');
            const page = await pay.listSettlements(input);
            return { items: page.items.map((item) => settlementDetailOut(item, audience)), nextCursor: page.nextCursor };
          }),
        ),

      /** Payments included in one settlement, oldest first. */
      lines: scopedProcedure('pay:read', { module: 'pay' })
        .input(paySettlementLinesInputSchema)
        .output(payPageSchema(paySettlementLineSchema))
        .query(({ ctx, input }) =>
          wrap(async () => {
            const settlement = await pay.getSettlement(input.settlementId);
            await assertSettlementRead(ctx.principal.userId, input.settlementId, settlement.merchantId);
            const page = await pay.listSettlementLines(input);
            return {
              items: page.items.map((line) => ({
                paymentId: line.paymentId,
                amount: line.amount === null ? null : formatAmount(line.amount),
                assetId: line.assetId,
                createdAt: line.createdAt.toISOString(),
                includedAmountKnown: line.includedAmountKnown,
              })),
              nextCursor: page.nextCursor,
            };
          }),
        ),

      /**
       * G3 — unstick a pending freeze so payments can enter a later window.
       * Moves no ledger value. Requires write (ops / merchant owner).
       */
      release: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ settlementId: z.string().uuid(), reason: z.string().min(1) }))
        .output(settlementView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const settlement = await pay.getSettlement(input.settlementId);
            await assertSettlementAccess(ctx.principal?.userId, input.settlementId, settlement.merchantId, 'trpc.settlement.release');
            return toSettlementOut(await pay.releasePendingSettlement(input));
          }),
        ),

      /**
       * Composed payout timeline. `status` is derived from the events.
       * When the status column is ahead of the recorded timestamps, one
       * synthetic event (`timeKnown: false`) floors that status. The read
       * never reports a status lower than the column.
       */
      lifecycle: scopedProcedure('pay:read', { module: 'pay' })
        .input(payPayoutLifecycleInputSchema)
        .output(payPayoutLifecycleSchema)
        .query(({ ctx, input }) =>
          wrap(async () => {
            const settlement = await pay.getSettlement(input.settlementId);
            await assertSettlementRead(ctx.principal.userId, input.settlementId, settlement.merchantId);
            return pay.readPayoutLifecycle(input.settlementId);
          }),
        ),
    }),

    /**
     * pay.routing — smart geo/method/risk selection (SPEC §5 / DIRECTION §8).
     * Blank required dims refuse; no invent approval rates / cost weights.
     * Moves no value — returns a decision record only.
     */
    routing: router({
      policy: publicProcedure.query(() => describeRoutingPolicy()),

      assertInputs: publicProcedure
        .input(
          z.object({
            required: z.array(z.enum(['geo', 'method', 'risk'])),
            geoCountry: z.string().nullable().optional(),
            method: z.string().nullable().optional(),
            riskBand: z.string().nullable().optional(),
          }),
        )
        .output(z.object({ ok: z.literal(true) }))
        .query(({ input }) => {
          try {
            assertRoutingInputsPresent(
              { required: input.required },
              {
                geoCountry: input.geoCountry,
                method: input.method,
                riskBand: input.riskBand,
              },
            );
            return { ok: true as const };
          } catch (e) {
            if (e instanceof RoutingInputError) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `${e.code}: ${e.message}`,
                cause: e,
              });
            }
            throw e;
          }
        }),

      /**
       * Product door: select a rail from geo + method + risk + operator profiles.
       * Preference list is operator-supplied (never a payer-named rail).
       * Omitting `profiles` uses REFERENCE_RAIL_ROUTING_PROFILES for the v1 rails.
       */
      select: publicProcedure
        .input(
          z.object({
            geoCountry: z.string().nullable().optional(),
            method: z.string().nullable().optional(),
            riskBand: z.string().nullable().optional(),
            preference: z.array(z.string().min(1)).min(1),
            policy: z.enum(['live-only', 'allow-sandbox']).default('allow-sandbox'),
            profiles: z
              .array(
                z.object({
                  railId: z.string().min(1),
                  methods: z.array(z.string()).optional(),
                  countries: z.array(z.string()).optional(),
                  riskBands: z.array(z.string()).optional(),
                }),
              )
              .optional(),
          }),
        )
        .output(
          z.object({
            chosenRailId: z.string(),
            inputs: z.object({
              geoCountry: z.string(),
              method: z.string(),
              riskBand: z.string(),
            }),
            considered: z.array(
              z.object({
                railId: z.string(),
                outcome: z.enum(['chosen', 'skipped']),
                reason: z.string().optional(),
              }),
            ),
            decision: z.record(z.unknown()),
          }),
        )
        .query(({ input }) => {
          try {
            const profiles: readonly RailRoutingProfile[] = input.profiles ?? REFERENCE_RAIL_ROUTING_PROFILES;
            const decision = selectSmartCheckoutRail({
              inputs: {
                geoCountry: input.geoCountry,
                method: input.method,
                riskBand: input.riskBand,
              },
              preference: input.preference,
              profiles,
              rails,
              policy: input.policy,
            });
            return {
              chosenRailId: decision.chosenRailId,
              inputs: decision.inputs,
              considered: decision.considered.map((e) =>
                e.outcome === 'chosen'
                  ? { railId: e.railId, outcome: e.outcome as 'chosen' }
                  : { railId: e.railId, outcome: e.outcome as 'skipped', reason: e.reason },
              ),
              decision: toRoutingDecisionRecord(decision),
            };
          } catch (e) {
            if (e instanceof RoutingInputError) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `${e.code}: ${e.message}`,
                cause: e,
              });
            }
            if (e instanceof SmartRoutingNoRailError) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `${e.code}: ${e.message}`,
                cause: e,
              });
            }
            throw e;
          }
        }),
    }),

    /**
     * pay.fraud — scoring + review queue + dispute **case** mechanism (D26-P1-P5).
     * Opening a dispute posts the existing ledger recipe through the
     * ledger client. Shortfall/recovery policy remains outside this path.
     */
    fraud: router({
      policy: publicProcedure.query(() => describeFraudPolicy()),

      evaluate: publicProcedure
        .input(
          z.object({
            merchantId: z.string().min(1),
            amount: amountSchema,
            assetId: assetIdSchema,
            ip: z.string().nullable().optional(),
            deviceId: z.string().nullable().optional(),
            recentPaymentCount: z.number().int().min(0).optional(),
            recentVolume: amountSchema.optional(),
            baselineAmount: amountSchema.nullable().optional(),
            thresholds: z
              .object({
                maxPaymentsInWindow: z.number().int().min(0).optional(),
                maxVolumeInWindow: amountSchema.optional(),
                amountAnomalyMultiplier: z.number().int().min(2).optional(),
                velocityCountAction: z.enum(['review', 'decline']).optional(),
                velocityVolumeAction: z.enum(['review', 'decline']).optional(),
                amountAnomalyAction: z.enum(['review', 'decline']).optional(),
              })
              .optional(),
            blocklists: z
              .object({
                ips: z.array(z.string()).optional(),
                devices: z.array(z.string()).optional(),
              })
              .optional(),
            enabled: z
              .object({
                velocity_count: z.boolean().optional(),
                velocity_volume: z.boolean().optional(),
                amount_anomaly: z.boolean().optional(),
                blocklist_ip: z.boolean().optional(),
                blocklist_device: z.boolean().optional(),
              })
              .optional(),
          }),
        )
        .output(
          z.object({
            outcome: z.enum(['allow', 'review', 'decline']),
            reasons: z.array(z.object({ ruleId: z.string(), detail: z.string() })),
            skippedDisabled: z.array(z.string()),
          }),
        )
        .query(({ input }) => {
          const decision = evaluateFraud({
            merchantId: input.merchantId,
            amount: input.amount,
            assetId: input.assetId,
            ip: input.ip,
            deviceId: input.deviceId,
            recentPaymentCount: input.recentPaymentCount,
            recentVolume: input.recentVolume,
            baselineAmount: input.baselineAmount,
            thresholds: input.thresholds,
            blocklists: input.blocklists
              ? {
                  ips: input.blocklists.ips,
                  devices: input.blocklists.devices,
                }
              : undefined,
            enabled: input.enabled,
          });
          return {
            outcome: decision.outcome,
            reasons: decision.reasons.map((r) => ({ ruleId: r.ruleId, detail: r.detail })),
            skippedDisabled: [...decision.skippedDisabled],
          };
        }),

      enqueueReview: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            id: z.string().min(1),
            merchantId: z.string().min(1),
            amount: amountSchema,
            assetId: assetIdSchema,
            paymentId: z.string().uuid().nullable().optional(),
            // Re-evaluate from the same inputs so the queue never accepts a forged review.
            recentPaymentCount: z.number().int().min(0).optional(),
            recentVolume: amountSchema.optional(),
            baselineAmount: amountSchema.nullable().optional(),
            thresholds: z
              .object({
                maxPaymentsInWindow: z.number().int().min(0).optional(),
                maxVolumeInWindow: amountSchema.optional(),
                amountAnomalyMultiplier: z.number().int().min(2).optional(),
                velocityCountAction: z.enum(['review', 'decline']).optional(),
                velocityVolumeAction: z.enum(['review', 'decline']).optional(),
                amountAnomalyAction: z.enum(['review', 'decline']).optional(),
              })
              .optional(),
            blocklists: z
              .object({
                ips: z.array(z.string()).optional(),
                devices: z.array(z.string()).optional(),
              })
              .optional(),
            enabled: z
              .object({
                velocity_count: z.boolean().optional(),
                velocity_volume: z.boolean().optional(),
                amount_anomaly: z.boolean().optional(),
                blocklist_ip: z.boolean().optional(),
                blocklist_device: z.boolean().optional(),
              })
              .optional(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'trpc.fraud.enqueueReview');
            if (input.paymentId) {
              const payment = await pay.getPayment(input.paymentId);
              if (payment.merchantId !== input.merchantId) {
                throw new PayError(`Payment ${input.paymentId} not found`, 'pay.payment_not_found');
              }
            }
            try {
              const decision = evaluateFraud({
                merchantId: input.merchantId,
                amount: input.amount,
                assetId: input.assetId,
                recentPaymentCount: input.recentPaymentCount,
                recentVolume: input.recentVolume,
                baselineAmount: input.baselineAmount,
                thresholds: input.thresholds,
                blocklists: input.blocklists,
                enabled: input.enabled,
              });
              const c = fraudReviews
                ? await fraudReviews.enqueue({
                    id: input.id,
                    merchantId: input.merchantId,
                    amount: input.amount,
                    assetId: input.assetId,
                    paymentId: input.paymentId ?? null,
                    decision,
                    createdBy: ctx.principal?.userId ?? 'fraud.enqueue',
                  })
                : defaultFraudReviewQueue.enqueue({
                    id: input.id,
                    merchantId: input.merchantId,
                    amount: input.amount,
                    assetId: input.assetId,
                    paymentId: input.paymentId ?? null,
                    decision,
                    createdBy: ctx.principal?.userId ?? 'fraud.enqueue',
                  });
              return {
                id: c.id,
                status: c.status,
                merchantId: c.merchantId,
                paymentId: c.paymentId,
                reasons: reviewReasons(c),
              };
            } catch (e) {
              if (e instanceof FraudReviewError) {
                throw new TRPCError({
                  code: e.code === 'pay.fraud_review_not_found' ? 'NOT_FOUND' : 'BAD_REQUEST',
                  message: `${e.code}: ${e.message}`,
                  cause: e,
                });
              }
              throw e;
            }
          }),
        ),

      listOpenReviews: scopedProcedure('admin:treasury', { module: 'pay' })
        .input(
          z
            .object({
              merchantId: z.string().min(1).optional(),
              /**
               * Page size. Optional so omit reaches `pay.fraud_review_list_limit_unset`.
               * Blank is not 50; pass 50 explicitly. Read stays single-operator.
               */
              limit: z.number().int().min(1).max(200).optional(),
            })
            .optional(),
        )
        .query(async ({ input }) => {
          try {
            const rows = fraudReviews
              ? await fraudReviews.listOpen(input?.merchantId, input?.limit)
              : defaultFraudReviewQueue.listOpen(input?.merchantId, input?.limit);
            return rows.map((c) => ({
              id: c.id,
              merchantId: c.merchantId,
              paymentId: c.paymentId,
              paymentRef: c.paymentRef,
              amount: c.amount,
              assetId: c.assetId,
              status: c.status,
              reason: c.reason,
              createdAt: c.createdAt,
              reasons: reviewReasons(c),
            }));
          } catch (e) {
            if (e instanceof FraudReviewError) {
              throw new TRPCError({
                code: e.code === 'pay.fraud_review_list_limit_unset' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
                message: `${e.code}: ${e.message}`,
                cause: e,
              });
            }
            throw e;
          }
        }),

      claimReview: scopedProcedure('admin:treasury', { module: 'pay' })
        .input(z.object({ id: z.string().min(1) }))
        .mutation(async ({ ctx, input }) => {
          try {
            const c = fraudReviews
              ? await fraudReviews.claim({ id: input.id, actorId: ctx.principal.userId })
              : defaultFraudReviewQueue.claim({ id: input.id, actorId: ctx.principal.userId });
            return { id: c.id, status: c.status, claimedBy: c.claimedBy, claimedAt: c.claimedAt };
          } catch (e) {
            if (e instanceof FraudReviewError) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: `${e.code}: ${e.message}`, cause: e });
            }
            throw e;
          }
        }),

      resolveReview: scopedProcedure('admin:treasury', { module: 'pay' })
        .input(
          z.object({
            id: z.string().min(1),
            outcome: z.enum(['allow', 'decline']),
            note: z.string().max(500).nullable().optional(),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const wanted = input.outcome === 'allow' ? 'allowed' : 'declined';
            const existing = fraudReviews ? await fraudReviews.get(input.id) : defaultFraudReviewQueue.get(input.id);
            if (existing && (existing.status === 'allowed' || existing.status === 'declined')) {
              if (existing.status !== wanted) {
                throw new FraudReviewError(`Fraud review ${input.id} is already ${existing.status}`, 'pay.fraud_review_closed');
              }
              return {
                id: existing.id,
                status: existing.status,
                resolvedBy: existing.resolvedBy,
                resolvedAt: existing.resolvedAt,
                confirmOperatorId: existing.resolvedBy,
              };
            }
            const confirmOperatorId = await consumePayApproval(approvals, input, 'pay.fraud_resolve_review', {
              id: input.id,
              outcome: input.outcome,
            });
            const c = fraudReviews
              ? await fraudReviews.resolve({
                  id: input.id,
                  outcome: input.outcome,
                  actorId: ctx.principal.userId,
                  note: input.note,
                })
              : defaultFraudReviewQueue.resolve({
                  id: input.id,
                  outcome: input.outcome,
                  actorId: ctx.principal.userId,
                  note: input.note,
                });
            return {
              id: c.id,
              status: c.status,
              resolvedBy: c.resolvedBy,
              resolvedAt: c.resolvedAt,
              confirmOperatorId,
            };
          } catch (e) {
            if (e instanceof DualControlError || e instanceof ActionApprovalConsumeError) {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
            }
            if (e instanceof FraudReviewError) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: `${e.code}: ${e.message}`, cause: e });
            }
            throw e;
          }
        }),

      /** Dispute case surface — opening posts the existing ledger recipe. Identity consume is the second person. */
      openDispute: scopedProcedure('admin:treasury', { module: 'pay' })
        .input(
          z.object({
            disputeId: z.string().min(1),
            paymentId: z.string().uuid(),
            merchantId: z.string().uuid(),
            amount: amountSchema,
            assetId: assetIdSchema,
            reasonCode: z.string().max(64).nullable().optional(),
            markPaymentDisputed: z.boolean().optional(),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const confirmOperatorId = await consumePayApproval(approvals, input, 'pay.fraud_open_dispute', {
              disputeId: input.disputeId,
              paymentId: input.paymentId,
              merchantId: input.merchantId,
              amount: input.amount,
              assetId: input.assetId,
            });
            let marked = false;
            if (input.markPaymentDisputed) {
              await pay.markDisputed(input.paymentId, {
                disputeId: input.disputeId,
                reasonCode: input.reasonCode ?? null,
              });
              marked = true;
            }
            // Lightweight router fixtures may omit the money port; production
            // PayService posts via ledger-client. No port → named refuse, never
            // a hardcoded `posted`.
            let ledgerRefuse: ChargebackLedgerRefuse | undefined;
            let posted: { txId: string } | undefined;
            if (typeof pay.openChargeback === 'function') {
              try {
                posted = await pay.openChargeback({
                  disputeId: input.disputeId,
                  paymentId: input.paymentId,
                  merchantId: input.merchantId,
                  amount: input.amount,
                  assetId: input.assetId,
                  ...sandboxKeyEnv(ctx.principal),
                });
              } catch (e) {
                // The ledger refused for funds (money moved since the plan). A named error, NOT a recorded case: the case
                // store keeps its first answer, so a recorded refusal would be returned for a later retry that does post.
                if (e instanceof LedgerError && e.code === 'ledger.insufficient_funds') {
                  throw new TRPCError({
                    code: 'PRECONDITION_FAILED',
                    message: 'pay.chargeback_uncovered: clearing and available cannot cover the chargeback right now; nothing was booked',
                    cause: e,
                  });
                }
                throw e;
              }
            }
            const ledgerPost = posted?.txId?.trim() ? { txId: posted.txId.trim() } : undefined;
            const c = await disputeCases.open({
              disputeId: input.disputeId,
              paymentId: input.paymentId,
              merchantId: input.merchantId,
              amount: input.amount,
              assetId: input.assetId,
              reasonCode: input.reasonCode,
              paymentMarkedDisputed: marked,
              ledgerPost,
              ledgerRefuse,
            });
            return {
              disputeId: c.disputeId,
              status: c.status,
              ledgerWire: c.ledgerWire,
              ledgerTxId: c.ledgerTxId,
              ledgerRefuseCode: c.ledgerRefuse?.code ?? null,
              ledgerSocket: c.ledgerRefuse?.socket ?? null,
              paymentMarkedDisputed: c.paymentMarkedDisputed,
              confirmOperatorId,
            };
          } catch (e) {
            if (e instanceof DualControlError || e instanceof ActionApprovalConsumeError) {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
            }
            // A redelivered open for another amount is a state conflict (retrying cannot fix it), not a malformed request.
            if (
              e instanceof PayError &&
              (e.code === 'pay.chargeback_plan_conflict' ||
                e.code === 'pay.chargeback_shortfall_unfunded' ||
                e.code === 'pay.chargeback_ledger_failed')
            ) {
              throw toTrpcError(e);
            }
            if (e instanceof DisputeCaseError || e instanceof PayError) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `${'code' in e ? e.code : 'pay.error'}: ${e.message}`,
                cause: e,
              });
            }
            throw e;
          }
        }),

      contestDispute: scopedProcedure('admin:treasury', { module: 'pay' })
        .input(
          z.object({
            disputeId: z.string().min(1),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const confirmOperatorId = await consumePayApproval(approvals, input, 'pay.fraud_contest_dispute', {
              disputeId: input.disputeId,
            });
            const c = await disputeCases.contest(input.disputeId);
            return {
              disputeId: c.disputeId,
              status: c.status,
              ledgerWire: c.ledgerWire,
              ledgerTxId: c.ledgerTxId,
              ledgerRefuseCode: c.ledgerRefuse?.code ?? null,
              ledgerSocket: c.ledgerRefuse?.socket ?? null,
              confirmOperatorId,
            };
          } catch (e) {
            if (e instanceof DualControlError || e instanceof ActionApprovalConsumeError) {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
            }
            if (e instanceof DisputeCaseError) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: `${e.code}: ${e.message}`, cause: e });
            }
            throw e;
          }
        }),

      getDispute: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ disputeId: z.string().min(1) }))
        .query(({ ctx, input }) =>
          wrap(async () => {
            const missing = () => new PayError('Dispute not found', 'pay.dispute_not_found');
            const c = await disputeCases.get(input.disputeId);
            if (!c) throw missing();
            await refuseAsMissing(assertRead(ctx.principal?.userId, c.merchantId, 'trpc.fraud.getDispute', 'payments.read'), missing);
            return {
              disputeId: c.disputeId,
              paymentId: c.paymentId,
              merchantId: c.merchantId,
              amount: c.amount,
              assetId: c.assetId,
              reasonCode: c.reasonCode,
              status: c.status,
              ledgerWire: c.ledgerWire,
              ledgerTxId: c.ledgerTxId,
              ledgerRefuseCode: c.ledgerRefuse?.code ?? null,
              ledgerSocket: c.ledgerRefuse?.socket ?? null,
              openedAt: c.openedAt,
              closedAt: c.closedAt,
            };
          }),
        ),
    }),

    /**
     * pay.plugins — reference path surface (TS client, not PHP CMS trees).
     * Exposes the public base path so integrators and contract tests share one symbol.
     */
    plugins: router({
      policy: publicProcedure.query(() => describePluginsPolicy()),

      publicBase: publicProcedure.output(z.object({ base: z.string() })).query(() => ({
        base: PAY_PUBLIC_API_BASE,
      })),

      cmsStatus: publicProcedure
        .output(
          z.object({
            socket: z.string(),
            shipped: z.boolean(),
            shippedFamily: z.literal('woocommerce'),
            unwiredFamilies: z.array(z.enum(['magento', 'opencart'])),
            families: z.array(
              z.union([
                z.object({
                  family: z.literal('woocommerce'),
                  shipped: z.literal(true),
                  refuse: z.null(),
                }),
                z.object({
                  family: z.enum(['magento', 'opencart']),
                  shipped: z.literal(false),
                  refuse: z.object({
                    status: z.literal('refuse'),
                    code: z.literal('pay.plugin_cms_unwired'),
                    socket: z.string(),
                    family: z.enum(['magento', 'opencart']),
                    shipped: z.literal(false),
                    phpTree: z.literal(false),
                    message: z.string(),
                  }),
                }),
              ]),
            ),
          }),
        )
        .query(() => describeCmsPluginStatus()),
    }),

    /**
     * A USER'S OWN BALANCE ENTERING THE BOOK (§4.2 `deposit`).
     *
     * OPERATOR-CREDENTIALED, and that is the single most important thing about
     * this router. Everything else here is a merchant surface; this one credits
     * a user's spendable balance, and a user who can call it does not need to
     * deposit at all.
     */
    deposit: router({
      /**
       * `admin:treasury`. WHY THAT SCOPE AND NOT ANOTHER.
       *
       * The test in `INTERACTIVE_ONLY_SCOPES` is "does this move value across
       * the platform boundary", and crediting a user from a rail boundary is
       * exactly that — inbound instead of outbound, but the same seam and the
       * same account. `admin:treasury` is already on that list, so this endpoint
       * inherits both halves of the protection for free: a long-lived API key
       * may never hold it (`assertKeyScopesAllowed`), and a session without a
       * second factor may not exercise it (`requireScope`).
       *
       * Identity consume is the third half: the MFA treasury session plus an
       * action-bound approval. A typed-in `confirmOperatorId` is not that.
       * Missing approval ids refuse. `creditedBy` stays the signed principal.
       *
       * The alternatives were all worse. `pay:write` is a MERCHANT scope that
       * ordinary integrations hold — it would let any merchant credit any user.
       * `admin:write` is broad, and not interactive-only, so a leaked operator
       * key could mint balances unattended. A new `ledger:credit` scope would be
       * a shared-package change (§15.2) to say something `admin:treasury`
       * already says.
       *
       * NO `{ module: 'pay' }` GUARD, deliberately. The jurisdiction matrix
       * judges THE USER BEING SERVED, and the principal here is an operator who
       * is not the beneficiary — running `checkAccess` against the operator's own
       * tier and region would be a check that measures the wrong person and
       * passes or fails for reasons that have nothing to do with the deposit.
       *
       * AND THE BENEFICIARY IS NOT TIER-GATED EITHER. Money that has already
       * arrived at a rail must always be bookable. Refusing to credit an
       * unverified user does not undo their payment; it strands it at the
       * boundary, which is the worst outcome in custody. The gate belongs on
       * what a balance can DO — `orders.create` needs `basic`, and the
       * withdrawal below is gated — not on being allowed to receive one.
       */
      credit: scopedProcedure('admin:treasury')
        .input(
          z.object({
            userId: z.string().uuid(),
            assetId: assetIdSchema,
            amount: amountSchema,
            railId: z.string().min(1),
            /** The rail's own reference. Half the business key, so it is required. */
            railRef: z.string().min(1).max(200),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(depositView.extend({ confirmOperatorId: z.string() }))
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const confirmOperatorId = await consumePayApproval(approvals, input, 'pay.deposit_credit', {
              userId: input.userId,
              assetId: input.assetId,
              amount: input.amount,
              railId: input.railId,
              railRef: input.railRef,
            });
            return {
              ...toDepositOut(
                await userMoney.credit({
                  userId: input.userId,
                  assetId: input.assetId,
                  amount: parseAmount(input.amount),
                  rail: input.railId,
                  railRef: input.railRef,
                  // Taken from the token, never from the body. An operator cannot
                  // credit a balance and name somebody else as having done it.
                  creditedBy: ctx.principal.userId,
                  ...sandboxKeyEnv(ctx.principal),
                }),
              ),
              confirmOperatorId,
            };
          }),
        ),
    }),

    /**
     * A USER'S OWN BALANCE LEAVING THE BOOK (§4.2 `withdraw`).
     *
     * WHY THIS IS NOT IN svc-trade. `services/svc-trade/src/router.ts` says
     * `trade:withdraw` "appears nowhere here, deliberately: it is an
     * INTERACTIVE_ONLY scope that no API key may hold, which is what protects a
     * leaked bot key from moving value off the platform". That reasoning is
     * about the SURFACE, not the scope's home: svc-trade is the exchange API
     * that bots hit with long-lived keys, and putting an interactive-only action
     * on it invites exactly the confusion the comment guards against. It is
     * respected here rather than worked around — the withdrawal lives where the
     * rails live, and svc-trade stays a pure exchange API.
     */
    withdrawal: router({
      /**
       * `trade:withdraw`, which is in `INTERACTIVE_ONLY_SCOPES`. Two
       * consequences, both load-bearing and both tested: no API key may hold it,
       * and `requireScope` refuses a session that has not passed 2FA. A normal
       * session does not carry it at all — `auth.stepUp` in svc-identity is what
       * mints a five-minute token that does.
       *
       * `{ module: 'ledger' }`, not `{ module: 'pay' }`. The matrix rule that
       * governs a user moving their own custodial balance is the rule for the
       * module that HOLDS that balance, and the ledger holds it (`ledger` is
       * `custodial: true`, `OPEN_BASIC`). `pay`'s `full` tier governs merchant
       * acquiring — taking card money from third parties — which is a different
       * risk and a different subject. Gating a withdrawal above the tier that
       * admitted the value would build a one-way door: a user verified enough to
       * deposit and trade would not be verified enough to leave.
       */
      create: scopedProcedure('trade:withdraw', { module: 'ledger' })
        .input(
          z.object({
            assetId: assetIdSchema,
            amount: amountSchema,
            railId: z.string().min(1),
            destination: z.object({ kind: z.string().min(1), ref: z.string().min(1) }),
            /**
             * REQUIRED, not optional. A timed-out request that is retried
             * without one opens a second withdrawal, and a second withdrawal is
             * a second debit. `clientOrderId` is merely recommended on an order
             * because the worst case there is a duplicate order the user can
             * cancel; there is no cancelling a payout.
             */
            clientRef: z.string().min(1).max(64),
          }),
        )
        .output(withdrawalView)
        .mutation(({ ctx, input }) =>
          wrap(async () =>
            toWithdrawalOut(
              await userMoney.withdraw({
                // From the token. There is no `userId` input, so there is no way
                // to withdraw from an account that is not the caller's — an
                // input the caller cannot supply cannot be forged.
                userId: ctx.principal.userId,
                assetId: input.assetId,
                amount: parseAmount(input.amount),
                rail: input.railId,
                destination: input.destination,
                clientRef: input.clientRef,
                ...sandboxKeyEnv(ctx.principal),
              }),
            ),
          ),
        ),

      /**
       * `trade:read`, not `trade:withdraw`: checking whether a withdrawal landed
       * is something a user should be able to do from an ordinary session, long
       * after their five-minute elevation has expired.
       */
      get: scopedProcedure('trade:read')
        .input(z.object({ withdrawalId: z.string().uuid() }))
        .output(withdrawalView)
        .query(({ ctx, input }) =>
          wrap(async () => {
            // Fetched, then checked, then returned. The row has to be read to
            // learn whose it is, so what the check protects is the RESPONSE —
            // and a withdrawal names an amount and a destination account.
            const withdrawal = await userMoney.getWithdrawal(input.withdrawalId);
            if (withdrawal.userId !== ctx.principal.userId) {
              throw new TRPCError({ code: 'FORBIDDEN', message: 'This withdrawal belongs to another account' });
            }
            return toWithdrawalOut(withdrawal);
          }),
        ),

      mine: scopedProcedure('trade:read')
        .input(
          z
            .object({
              /**
               * Page size. Optional so omit reaches `pay.withdrawal_list_limit_unset`
               * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
               */
              limit: z.number().int().min(1).max(200).optional(),
            })
            .optional(),
        )
        .output(z.array(withdrawalView))
        .query(({ ctx, input }) =>
          wrap(async () => (await userMoney.listWithdrawals(ctx.principal.userId, input?.limit)).map(toWithdrawalOut)),
        ),

      /**
       * What the caller can actually withdraw, read from the LEDGER.
       *
       * `ledger:read` because that is whose number it is. Not summed from
       * svc-pay's tables: the ledger is the balance (Doctrine §0.6), and a
       * second answer computed here would be the one users saw and the wrong one.
       */
      balance: scopedProcedure('ledger:read')
        .input(z.object({ assetId: assetIdSchema }))
        .output(z.object({ available: amountSchema }))
        .query(({ ctx, input }) =>
          wrap(async () => ({ available: formatAmount(await userMoney.availableBalance(ctx.principal.userId, input.assetId)) })),
        ),
    }),
  });
}

export type PayRouter = ReturnType<typeof createPayRouter>;

function toPaymentOut(view: Awaited<ReturnType<PayService['getPayment']>>): Omit<PaymentViewOut, 'failure' | 'pricingSnapshot'> {
  return {
    id: view.id,
    merchantId: view.merchantId,
    profileId: view.profileId,
    amount: formatAmount(view.amount),
    assetId: view.assetId,
    method: view.method,
    railAdapter: view.railAdapter,
    railRef: view.railRef,
    status: view.status,
    capturedAmount: formatAmount(view.capturedAmount),
    refundedAmount: formatAmount(view.refundedAmount),
    createdAt: view.createdAt.toISOString(),
  };
}

function toDepositOut(row: Awaited<ReturnType<UserMoneyService['credit']>>) {
  return {
    id: row.id,
    userId: row.userId,
    assetId: row.assetId,
    amount: formatAmount(row.amount),
    rail: row.rail,
    railRef: row.railRef,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `creditedBy` is absent from the wire shape on purpose: which operator credited
 * a balance is an internal audit fact, and naming them to the beneficiary serves
 * nobody. Same reasoning as `reviewedBy` on a KYC record.
 */
function toWithdrawalOut(row: WithdrawalRecord): WithdrawalViewOut {
  return {
    id: row.id,
    userId: row.userId,
    assetId: row.assetId,
    amount: formatAmount(row.amount),
    rail: row.rail,
    destination: row.destination,
    clientRef: row.clientRef,
    railRef: row.railRef,
    attempts: row.attempts,
    failureCode: row.failureCode,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSettlementDetail(
  row: Awaited<ReturnType<PayService['getSettlement']>> & {
    createdAt?: Date;
    sentAt?: Date | null;
    settledAt?: Date | null;
    failedAt?: Date | null;
    failure?: SettlementDetailOut['failure'];
    pricingSnapshot?: SettlementDetailOut['pricingSnapshot'];
  },
): SettlementDetailOut {
  const at = (value: Date | string | null | undefined): string | null => {
    if (value == null) return null;
    return value instanceof Date ? value.toISOString() : value;
  };
  return {
    ...toSettlementOut(row),
    createdAt: at(row.createdAt),
    sentAt: at(row.sentAt),
    settledAt: at(row.settledAt),
    failedAt: at(row.failedAt),
    failure: row.failure ?? null,
    pricingSnapshot: row.pricingSnapshot ?? null,
  };
}

function toSettlementOut(row: Awaited<ReturnType<PayService['getSettlement']>>): SettlementViewOut {
  return {
    id: row.id,
    merchantId: row.merchantId,
    window: row.window,
    assetId: row.assetId,
    gross: formatAmount(row.gross),
    fees: formatAmount(row.fees),
    net: formatAmount(row.net),
    payoutMethod: row.payoutMethod,
    payoutRef: row.payoutRef,
    status: row.status,
  };
}

/**
 * Map our codes onto tRPC's, so a client can branch on the code rather than
 * parse prose.
 *
 * The distinction that matters: a rail declining is a BAD_REQUEST the merchant
 * can act on, while an over-capture is a CONFLICT their integration has to fix.
 * Collapsing both into INTERNAL_SERVER_ERROR is how a merchant's engineer spends
 * a day guessing.
 */
function toTrpcError(err: unknown): unknown {
  /**
   * A guard seam refused (seams/guards.ts). Typed, so it never falls into the
   * PayError default below (BAD_REQUEST reads as "fix your request"). The
   * message is the code only: composeGuards already stripped any internals.
   */
  if (err instanceof PayGuardRefusal) {
    return new TRPCError({ code: err.kind === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN', message: err.code, cause: err });
  }
  // Payout of a merchant who already has a rolling reserve. NOT_IMPLEMENTED, message is the code.
  if (err instanceof ControlError) return controlToTrpcError(err);
  if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof AuthError) {
    return new TRPCError({
      code: err.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      message: err.message,
      cause: err,
    });
  }
  /**
   * A SANDBOX REFUSAL IS NOT A SERVER ERROR.
   *
   * It escapes `PayError`, so without this it reaches the client as
   * INTERNAL_SERVER_ERROR — which reads as "try again", and this is the one
   * condition retrying can never fix. SERVICE_UNAVAILABLE is the honest code:
   * the request was well-formed and the platform cannot serve it, because it has
   * no rail that would actually move the money. The message says so, because a
   * user staring at a failed withdrawal deserves better than "unknown error".
   */
  if (err instanceof SandboxRailRefusal) {
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: `${err.code}: ${err.message}`, cause: err });
  }
  /**
   * SERVICE_UNAVAILABLE, for exactly the reason above. A hosted checkout that
   * cannot reach a real rail is not a bad request and not a server fault: the
   * request was well-formed and the platform cannot serve it, because it has no
   * rail that would actually take the payer's money. BAD_REQUEST would send a
   * merchant's engineer looking for a mistake in their integration that is not
   * there, and INTERNAL_SERVER_ERROR reads as "retry", which is the one thing
   * that can never fix this.
   */
  if (err instanceof PublicCheckoutUnavailable) {
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: `${err.code}: ${err.message}`, cause: err });
  }
  if (err instanceof DestinationKindError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.code}: ${err.message}`, cause: err });
  }
  if (err instanceof PayoutDestinationMissingError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.code}: ${err.message}`, cause: err });
  }
  if (!(err instanceof PayError)) return err;

  const code = (() => {
    switch (err.code) {
      case 'pay.merchant_not_found':
      case 'pay.payout_destination_not_found':
      case 'pay.payment_not_found':
      case 'pay.profile_not_found':
      case 'pay.dispute_not_found':
      case 'pay.link_not_found':
      case 'pay.settlement_not_found':
      case 'pay.refund_not_found':
      case 'pay.checkout_session_not_found':
        return 'NOT_FOUND' as const;
      case 'pay.link_expired':
      case 'pay.checkout_session_expired':
        return 'BAD_REQUEST' as const;
      /**
       * CONFLICT, not NOT_FOUND. The link is real and the URL is correct — it
       * has simply been paid as many times as the merchant allowed, and a
       * session that is already closed is not a missing one. A 404 sends the
       * caller looking for a typo that is not there; a conflict says the state
       * is wrong, which is the only thing that is actually true.
       */
      case 'pay.link_exhausted':
      case 'pay.checkout_session_closed':
      case 'pay.merchant_parent_present':
        return 'CONFLICT' as const;
      /** The caller is anonymous and opening rows in our database. */
      case 'pay.checkout_busy':
      /** One statement scan per merchant, and at most two on this process. A further call is refused. */
      case 'pay.statement_busy':
        return 'TOO_MANY_REQUESTS' as const;
      case 'pay.routing_input_missing':
        return 'BAD_REQUEST' as const;
      case 'pay.routing_no_rail':
      case 'pay.rail_outcome_unknown':
      case 'pay.ledger_outcome_unknown':
      case 'pay.settlement_book_unrecognised':
      case 'pay.identity_admission_unavailable':
      case 'pay.payout_destination_missing':
      case 'pay.destination_hold_unset':
      case 'pay.payout_admission_missing':
      case 'pay.fee_bps_unset':
      case 'pay.starter_fee_unpublished':
      case 'pay.link_ttl_unset':
      case 'pay.link_max_ttl_unset':
      case 'pay.checkout_session_ttl_unset':
      case 'pay.checkout_max_open_sessions_unset':
      case 'pay.payment_list_limit_unset':
      case 'pay.payment_history_limit_unset':
      case 'pay.payment_link_list_limit_unset':
      case 'pay.settlement_list_limit_unset':
      case 'pay.destination_list_limit_unset':
      case 'pay.refund_list_limit_unset':
      case 'pay.statement_list_limit_unset':
      case 'pay.statement_range_required':
      case 'pay.statement_range_too_wide':
      case 'pay.statement_too_large':
      case 'pay.withdrawal_list_limit_unset':
      case 'pay.webhook_delivery_list_limit_unset':
      case 'pay.webhook_endpoint_list_limit_unset':
      case 'pay.subscription_mandate_list_limit_unset':
      case 'pay.subscription_list_limit_unset':
      case 'pay.subscription_execution_list_limit_unset':
      case 'pay.subscription_cycle_list_limit_unset':
      case 'pay.due_subscriptions_batch_limit_unset':
      case 'pay.due_webhook_deliveries_batch_limit_unset':
      case 'pay.capture_reconcile_disabled':
      case 'pay.capture_reconcile_batch_limit_unset':
      case 'pay.kyb_profile_unbound':
      case 'pay.chargeback_shortfall_unfunded':
      case 'pay.chargeback_ledger_failed':
      case 'pay.chargeback_outcome_busy':
        return 'PRECONDITION_FAILED' as const;
      case 'pay.invalid_transition':
      case 'pay.payout_recovery_conflict':
      case 'pay.identity_admission_conflict':
      case 'pay.nothing_captured':
      case 'pay.capture_exceeds_authorized':
      case 'pay.refund_exceeds_captured':
      case 'pay.refund_in_flight':
      case 'pay.refund_id_spent':
      case 'pay.refund_id_conflict':
      case 'pay.chargeback_plan_conflict':
      case 'pay.settlement_in_flight':
      case 'pay.payout_destination_in_flight':
      case 'pay.payout_destination_verified_locked':
      case 'pay.settlement_desynced':
      case 'pay.settlement_ledger_conflict':
      case 'pay.settlement_not_pending':
        return 'CONFLICT' as const;
      case 'pay.withdrawal_not_found':
        return 'NOT_FOUND' as const;
      case 'pay.deposit_conflict':
      case 'pay.withdrawal_conflict':
      case 'pay.idempotency_conflict':
        // CONFLICT, never BAD_REQUEST. The caller reused a business key for
        // different numbers; retrying repeats it. Nothing they can resend fixes
        // this, and telling them to try again is how a deposit gets credited
        // under one reference and reported as another.
        return 'CONFLICT' as const;
      case 'pay.webhook_invalid':
        return 'UNAUTHORIZED' as const;
      case 'pay.merchant_inactive':
      case 'pay.identity_admission_denied':
      case 'pay.merchant_forbidden':
      case 'pay.destination_step_up_required':
      case 'pay.destination_api_key_refused':
      case 'pay.destination_session_required':
      case 'pay.destination_role_forbidden':
      case 'pay.submerchant_permission_denied':
      case 'pay.rail_not_creditable':
      case 'pay.kyb_operator_required':
      case 'pay.kyb_required':
        return 'FORBIDDEN' as const;
      case 'pay.kyb_invalid':
      case 'pay.kyb_identity_changed':
        return 'CONFLICT' as const;
      default:
        return 'BAD_REQUEST' as const;
    }
  })();

  return new TRPCError({ code, message: `${err.code}: ${err.message}`, cause: err });
}

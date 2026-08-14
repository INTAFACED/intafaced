import { z } from 'zod';
import { router, scopedProcedure, publicProcedure, TRPCError } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { PayError, type PayService } from './payment-service.js';
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
import { assertMerchantAreaAccess, type MerchantAreaFence } from './merchant-ownership.js';
import type { PermissionArea } from './submerchants.js';
import { assertRoutingInputsPresent, RoutingInputError } from './routing-inputs.js';
import {
  REFERENCE_RAIL_ROUTING_PROFILES,
  selectSmartCheckoutRail,
  SmartRoutingNoRailError,
  toRoutingDecisionRecord,
  type RailRoutingProfile,
} from './routing/decide.js';
import { evaluateFraud } from './fraud/evaluate.js';
import { defaultFraudReviewQueue, FraudReviewError } from './fraud/review-queue.js';
import { defaultDisputeCaseStore, DisputeCaseError } from './fraud/dispute-case.js';
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
type WithdrawalViewOut = z.infer<typeof withdrawalView>;

/**
 * A merchant may only touch payments/settlements it owns — or, when a PayFac
 * fence is wired, ones it holds the matching permission area over.
 *
 * HOW MERCHANTS RELATE TO USERS. `pay.merchants` carries `user_id` and inserts
 * `ON CONFLICT (user_id) DO NOTHING` (`payment-service.ts`), so there is still
 * exactly one merchant per user. Self-action is ownership. Parent action is
 * area (`payment`, `payment.refund`, `settlement`, `settlement.payout`, …).
 *
 * WHY FORBIDDEN AND NOT NOT_FOUND — same call, same reasoning, as svc-bank's
 * `assertSelf`. NOT_FOUND leaks less because it never confirms the id exists,
 * but every id here is a v4 uuid the caller already holds.
 */
export function createPayRouter(
  pay: PayService,
  rails: RailRegistry,
  userMoney: UserMoneyService,
  trees: MerchantAreaFence | null = null,
  destinations: MerchantPayoutDestinations = assertOnlyPayoutDestinations(),
) {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toTrpcError(err);
    }
  };

  const assertAccess = (principalUserId: string | undefined, merchantId: string, area: PermissionArea) =>
    assertMerchantAreaAccess(pay, principalUserId, merchantId, area, trees);

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
      /**
       * Ownership: userId is always the authenticated principal. Body userId
       * was dropped so a caller with pay:write cannot create a merchant under
       * another account (full audit L2-1).
       */
      create: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            mode: z.enum(['gateway', 'psp', 'payfac']).default('gateway'),
            pricing: z.object({ feeBps: z.number().int().min(0).max(10_000) }),
            settlementPrefs: z.record(z.unknown()).optional(),
          }),
        )
        .output(z.object({ id: z.string().uuid(), userId: z.string().uuid(), mode: z.string(), feeBps: z.number() }))
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const userId = ctx.principal?.userId;
            if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
            const merchant = await pay.createMerchant({ ...input, userId });
            return { id: merchant.id, userId: merchant.userId, mode: merchant.mode, feeBps: merchant.pricing.feeBps ?? 0 };
          }),
        ),

      /**
       * Persist a payout destination through assertPayoutDestinationKind
       * (IBAN / IFSC / EVM) so a later payout has a real ref before withdrawHold.
       */
      setPayoutDestination: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            railId: z.string().min(1),
            kind: z.string().min(1),
            ref: z.string().min(1),
          }),
        )
        .output(z.object({ kind: z.string(), ref: z.string(), railId: z.string() }))
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'settlement.payout');
            const dest = await destinations.persist(input);
            return { ...dest, railId: input.railId };
          }),
        ),

      /** Current merchant for the principal — null when not yet onboarded. */
      me: scopedProcedure('pay:read', { module: 'pay' })
        .output(
          z
            .object({
              id: z.string().uuid(),
              userId: z.string().uuid(),
              mode: z.enum(['gateway', 'psp', 'payfac']),
              status: z.enum(['pending', 'active', 'suspended', 'closed']),
              kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
              kybRef: z.string().nullable(),
              feeBps: z.number(),
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
              feeBps: merchant.pricing.feeBps ?? 0,
            };
          }),
        ),

      /**
       * KYB stub submit — dossier reference only. Does not invent a partner decision.
       * Digital KYB vendors are `pay.psp`.
       */
      submitKyb: scopedProcedure('pay:write', { module: 'pay' })
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
            await assertAccess(ctx.principal?.userId, input.merchantId, 'kyb');
            const merchant = await pay.submitKyb(input);
            return { id: merchant.id, kybStatus: merchant.kybStatus, kybRef: merchant.kybRef };
          }),
        ),

      /**
       * KYB stub decide — allowed only when valueMovement is allow-sandbox.
       * Under live-only → `pay.kyb_operator_required` (honest refuse).
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
            await assertAccess(ctx.principal?.userId, input.merchantId, 'kyb');
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
            await assertAccess(ctx.principal?.userId, input.merchantId, 'checkout.profile');
            return pay.createProfile(input);
          }),
        ),

      /** Hosted checkout pointer — token returned once. */
      createLink: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            label: z.string().min(1).max(120),
            profileId: z.string().uuid().nullish(),
            amount: amountSchema.optional(),
            currency: assetIdSchema.optional(),
            /** Omit for the service default. A link with no expiry cannot be created. */
            expiresAt: z.string().datetime({ offset: true }).optional(),
            /** Completed payments this link may take. Omit for unbounded. */
            maxUses: z.number().int().min(1).max(1_000_000).optional(),
          }),
        )
        .output(
          z.object({
            id: z.string().uuid(),
            token: z.string(),
            prefix: z.string(),
            label: z.string(),
            /** Always a date. The service defaults and caps it; it is never null. */
            expiresAt: z.string().datetime({ offset: true }),
            maxUses: z.number().int().nullable(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'payment.link');
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
            });
            return { ...link, expiresAt: link.expiresAt.toISOString() };
          }),
        ),

      listLinks: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid() }))
        .output(
          z.array(
            z.object({
              id: z.string().uuid(),
              prefix: z.string(),
              label: z.string(),
              amount: amountSchema.nullable(),
              currency: z.string().nullable(),
              active: z.boolean(),
              expiresAt: z.string().nullable(),
              maxUses: z.number().int().nullable(),
              uses: z.number().int(),
              createdAt: z.string(),
            }),
          ),
        )
        .query(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'payment.link');
            return pay.listPaymentLinks(input.merchantId);
          }),
        ),

      deactivateLink: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid(), linkId: z.string().uuid() }))
        .output(z.object({ deactivated: z.boolean() }))
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'payment.link');
            return pay.deactivatePaymentLink(input.merchantId, input.linkId);
          }),
        ),

      /**
       * What we owe this merchant but have not settled, and what they can
       * already spend. Both read from the LEDGER, not from svc-pay's tables —
       * the two are independent on purpose, which is what makes reconciliation
       * meaningful (Doctrine §0.6).
       */
      balances: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid(), assetId: assetIdSchema }))
        .output(z.object({ clearing: amountSchema, available: amountSchema }))
        .query(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'merchant.profile');
            return {
              clearing: formatAmount(await pay.clearingBalance(input.merchantId, input.assetId)),
              available: formatAmount(await pay.merchantBalance(input.merchantId, input.assetId)),
            };
          }),
        ),
    }),

    payment: router({
      create: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
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
            await assertAccess(ctx.principal?.userId, input.merchantId, 'payment');
            return toPaymentOut(
              await pay.createPayment({
                ...input,
                profileId: input.profileId ?? null,
                amount: parseAmount(input.amount),
              }),
            );
          }),
        ),

      authorize: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ paymentId: z.string().uuid() }))
        .output(paymentView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const payment = await pay.getPayment(input.paymentId);
            await assertAccess(ctx.principal?.userId, payment.merchantId, 'payment');
            return toPaymentOut(await pay.authorize(input.paymentId));
          }),
        ),

      capture: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ paymentId: z.string().uuid(), amount: amountSchema.optional() }))
        .output(paymentView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const payment = await pay.getPayment(input.paymentId);
            await assertAccess(ctx.principal?.userId, payment.merchantId, 'payment');
            return toPaymentOut(
              await pay.capture(input.paymentId, input.amount === undefined ? {} : { amount: parseAmount(input.amount) }),
            );
          }),
        ),

      /** Its own scope. Refunding is not the same authority as taking payment. */
      refund: scopedProcedure('pay:refund', { module: 'pay' })
        .input(z.object({ paymentId: z.string().uuid(), amount: amountSchema, refundId: z.string().optional() }))
        .output(paymentView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const payment = await pay.getPayment(input.paymentId);
            await assertAccess(ctx.principal?.userId, payment.merchantId, 'payment.refund');
            return toPaymentOut(
              await pay.refund(input.paymentId, parseAmount(input.amount), input.refundId ? { refundId: input.refundId } : {}),
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
            await assertAccess(ctx.principal.userId, payment.merchantId, 'payment');
            return toPaymentOut(payment);
          }),
        ),

      /** Durable status list for the merchant — projection of `payments.status`. */
      list: scopedProcedure('pay:read', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            status: z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']).optional(),
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(paymentView))
        .query(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal.userId, input.merchantId, 'payment');
            return (await pay.listPayments(input)).map(toPaymentOut);
          }),
        ),

      /** The append-only state history (§6.1). Read-only, by construction. */
      history: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ paymentId: z.string().uuid() }))
        .output(
          z.array(
            z.object({
              id: z.string().uuid(),
              event: z.string(),
              payload: z.record(z.unknown()),
              railEventId: z.string().nullable(),
              ts: z.string().datetime({ offset: true }),
            }),
          ),
        )
        .query(({ ctx, input }) =>
          wrap(async () => {
            // The payment row is read first only to learn its merchant; the
            // event log is never touched for a caller who does not own it.
            // `payment_events` carries instrument metadata, customer refs and
            // rail references, so this is the more sensitive of the two reads.
            const payment = await pay.getPayment(input.paymentId);
            await assertAccess(ctx.principal.userId, payment.merchantId, 'payment');
            return (await pay.history(input.paymentId)).map((e) => ({
              id: e.id,
              event: e.event,
              payload: e.payload,
              railEventId: e.railEventId,
              ts: e.ts.toISOString(),
            }));
          }),
        ),
    }),

    settlement: router({
      run: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid(), window: z.string().min(1), assetId: assetIdSchema }))
        .output(settlementView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'settlement');
            return toSettlementOut(await pay.settleWindow(input));
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
            await assertAccess(ctx.principal?.userId, settlement.merchantId, 'settlement.payout');
            const destination = input.destination
              ? await destinations.persist({
                  merchantId: settlement.merchantId,
                  railId: input.railId,
                  kind: input.destination.kind,
                  ref: input.destination.ref,
                })
              : await destinations.require({ merchantId: settlement.merchantId, railId: input.railId });
            return toSettlementOut(await pay.payoutSettlement({ ...input, destination }));
          }),
        ),

      get: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ settlementId: z.string().uuid() }))
        .output(settlementView)
        .query(({ ctx, input }) =>
          wrap(async () => {
            // A settlement names gross, fees and net for a window — another
            // merchant's revenue and the rate we charge them.
            const settlement = await pay.getSettlement(input.settlementId);
            await assertAccess(ctx.principal.userId, settlement.merchantId, 'settlement');
            return toSettlementOut(settlement);
          }),
        ),

      /**
       * Merchant fleet list (ops truth). Read-only — no freeze, no payout.
       */
      list: scopedProcedure('pay:read', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            status: z.enum(['pending', 'posted', 'paid_out', 'failed']).optional(),
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(settlementView))
        .query(({ ctx, input }) =>
          wrap(async () => {
            await assertAccess(ctx.principal?.userId, input.merchantId, 'settlement');
            return (await pay.listSettlements(input)).map(toSettlementOut);
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
            await assertAccess(ctx.principal?.userId, settlement.merchantId, 'settlement');
            return toSettlementOut(await pay.releasePendingSettlement(input));
          }),
        ),
    }),

    /**
     * pay.routing — smart geo/method/risk selection (SPEC §5 / DIRECTION §8).
     * Blank required dims refuse; no invent approval rates / cost weights.
     * Moves no value — returns a decision record only.
     */
    routing: router({
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
     * Moves no ledger value. Chargeback recipes refuse-closed via
     * `socket.pay-chargeback-ledger-wire` (named §13). List content Class X.
     */
    fraud: router({
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
                amountAnomalyMultiplier: z.number().positive().optional(),
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
                amountAnomalyMultiplier: z.number().positive().optional(),
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
        .mutation(({ input }) => {
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
            const c = defaultFraudReviewQueue.enqueue({
              id: input.id,
              merchantId: input.merchantId,
              amount: input.amount,
              assetId: input.assetId,
              paymentId: input.paymentId ?? null,
              decision,
            });
            return {
              id: c.id,
              status: c.status,
              merchantId: c.merchantId,
              paymentId: c.paymentId,
              reasons: c.decision.reasons.map((r) => ({ ruleId: r.ruleId, detail: r.detail })),
            };
          } catch (e) {
            if (e instanceof FraudReviewError) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: `${e.code}: ${e.message}`, cause: e });
            }
            throw e;
          }
        }),

      listOpenReviews: scopedProcedure('admin:treasury', { module: 'pay' })
        .input(z.object({ merchantId: z.string().min(1).optional() }).optional())
        .query(({ input }) =>
          defaultFraudReviewQueue.listOpen(input?.merchantId).map((c) => ({
            id: c.id,
            merchantId: c.merchantId,
            paymentId: c.paymentId,
            amount: c.amount,
            assetId: c.assetId,
            status: c.status,
            createdAt: c.createdAt,
            reasons: c.decision.reasons.map((r) => ({ ruleId: r.ruleId, detail: r.detail })),
          })),
        ),

      resolveReview: scopedProcedure('admin:treasury', { module: 'pay' })
        .input(
          z.object({
            id: z.string().min(1),
            outcome: z.enum(['allow', 'decline']),
            note: z.string().max(500).nullable().optional(),
          }),
        )
        .mutation(({ ctx, input }) => {
          try {
            const c = defaultFraudReviewQueue.resolve({
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
            };
          } catch (e) {
            if (e instanceof FraudReviewError) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: `${e.code}: ${e.message}`, cause: e });
            }
            throw e;
          }
        }),

      /**
       * Dispute case surface — status machine only. Does not call chargeback recipes.
       */
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
          }),
        )
        .mutation(async ({ input }) => {
          try {
            let marked = false;
            if (input.markPaymentDisputed) {
              await pay.markDisputed(input.paymentId, {
                disputeId: input.disputeId,
                reasonCode: input.reasonCode ?? null,
              });
              marked = true;
            }
            const c = defaultDisputeCaseStore.open({
              disputeId: input.disputeId,
              paymentId: input.paymentId,
              merchantId: input.merchantId,
              amount: input.amount,
              assetId: input.assetId,
              reasonCode: input.reasonCode,
              paymentMarkedDisputed: marked,
            });
            return {
              disputeId: c.disputeId,
              status: c.status,
              ledgerWire: c.ledgerWire,
              ledgerRefuseCode: c.ledgerRefuse.code,
              ledgerSocket: c.ledgerRefuse.socket,
              paymentMarkedDisputed: c.paymentMarkedDisputed,
            };
          } catch (e) {
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
        .input(z.object({ disputeId: z.string().min(1) }))
        .mutation(({ input }) => {
          try {
            const c = defaultDisputeCaseStore.contest(input.disputeId);
            return {
              disputeId: c.disputeId,
              status: c.status,
              ledgerWire: c.ledgerWire,
              ledgerRefuseCode: c.ledgerRefuse.code,
              ledgerSocket: c.ledgerRefuse.socket,
            };
          } catch (e) {
            if (e instanceof DisputeCaseError) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: `${e.code}: ${e.message}`, cause: e });
            }
            throw e;
          }
        }),

      getDispute: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ disputeId: z.string().min(1) }))
        .query(({ input }) => {
          const c = defaultDisputeCaseStore.get(input.disputeId);
          if (!c) {
            throw new TRPCError({ code: 'NOT_FOUND', message: `pay.dispute_not_found: ${input.disputeId}` });
          }
          return {
            disputeId: c.disputeId,
            paymentId: c.paymentId,
            merchantId: c.merchantId,
            amount: c.amount,
            assetId: c.assetId,
            reasonCode: c.reasonCode,
            status: c.status,
            ledgerWire: c.ledgerWire,
            ledgerRefuseCode: c.ledgerRefuse.code,
            ledgerSocket: c.ledgerRefuse.socket,
            openedAt: c.openedAt,
            closedAt: c.closedAt,
          };
        }),
    }),

    /**
     * pay.plugins — reference path surface (TS client, not PHP CMS trees).
     * Exposes the public base path so integrators and contract tests share one symbol.
     */
    plugins: router({
      publicBase: publicProcedure.output(z.object({ base: z.string() })).query(() => ({
        base: PAY_PUBLIC_API_BASE,
      })),
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
          }),
        )
        .output(depositView)
        .mutation(({ ctx, input }) =>
          wrap(async () =>
            toDepositOut(
              await userMoney.credit({
                userId: input.userId,
                assetId: input.assetId,
                amount: parseAmount(input.amount),
                rail: input.railId,
                railRef: input.railRef,
                // Taken from the token, never from the body. An operator cannot
                // credit a balance and name somebody else as having done it.
                creditedBy: ctx.principal.userId,
              }),
            ),
          ),
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
        .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional())
        .output(z.array(withdrawalView))
        .query(({ ctx, input }) =>
          wrap(async () => (await userMoney.listWithdrawals(ctx.principal.userId, input?.limit ?? 50)).map(toWithdrawalOut)),
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

function toPaymentOut(view: Awaited<ReturnType<PayService['getPayment']>>): PaymentViewOut {
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
      case 'pay.payment_not_found':
      case 'pay.profile_not_found':
      case 'pay.link_not_found':
      case 'pay.settlement_not_found':
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
        return 'CONFLICT' as const;
      /** The caller is anonymous and opening rows in our database. */
      case 'pay.checkout_busy':
        return 'TOO_MANY_REQUESTS' as const;
      case 'pay.routing_input_missing':
        return 'BAD_REQUEST' as const;
      case 'pay.routing_no_rail':
      case 'pay.payout_destination_missing':
        return 'PRECONDITION_FAILED' as const;
      case 'pay.invalid_transition':
      case 'pay.capture_exceeds_authorized':
      case 'pay.refund_exceeds_captured':
      case 'pay.refund_in_flight':
      case 'pay.refund_id_spent':
      case 'pay.refund_id_conflict':
      case 'pay.settlement_in_flight':
      case 'pay.settlement_desynced':
      case 'pay.settlement_not_pending':
        return 'CONFLICT' as const;
      case 'pay.withdrawal_not_found':
        return 'NOT_FOUND' as const;
      case 'pay.deposit_conflict':
      case 'pay.withdrawal_conflict':
        // CONFLICT, never BAD_REQUEST. The caller reused a business key for
        // different numbers; retrying repeats it. Nothing they can resend fixes
        // this, and telling them to try again is how a deposit gets credited
        // under one reference and reported as another.
        return 'CONFLICT' as const;
      case 'pay.webhook_invalid':
        return 'UNAUTHORIZED' as const;
      case 'pay.merchant_inactive':
      case 'pay.merchant_forbidden':
      case 'pay.submerchant_permission_denied':
      case 'pay.rail_not_creditable':
      case 'pay.kyb_operator_required':
      case 'pay.kyb_required':
        return 'FORBIDDEN' as const;
      case 'pay.kyb_invalid':
        return 'CONFLICT' as const;
      default:
        return 'BAD_REQUEST' as const;
    }
  })();

  return new TRPCError({ code, message: `${err.code}: ${err.message}`, cause: err });
}

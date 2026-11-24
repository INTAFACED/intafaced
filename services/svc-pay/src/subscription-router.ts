import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { assertMerchantAreaAccess, refuseAsMissing, type MerchantAreaFence } from './merchant-ownership.js';
import { PayError, type PayService } from './payment-service.js';
import type { SubscriptionService } from './subscriptions/subscription-service.js';
import type { Cadence } from './subscriptions/schedule.js';
import { COLLECTION_METHODS, collectionMethodOf } from './subscriptions/merchant-disp-bill-rep-collection-method.js';
import {
  MANDATE_PATH_MATRIX,
  mandateDunningBound,
  preChargeNotifyGap,
  subscriptionsProductPosture,
} from './subscriptions/mandate-product.js';
import {
  subscriptionView,
  amountSchema,
  PAY_SUBSCRIPTION_LIST,
  PAY_SUBSCRIPTION_PRODUCT_READY,
  PAY_SUBSCRIPTION_GET,
  PAY_SUBSCRIPTION_LIST_EXECUTIONS,
  PAY_SUBSCRIPTION_PAUSE,
  PAY_SUBSCRIPTION_RESUME,
  PAY_SUBSCRIPTION_CANCEL,
  PAY_SUBSCRIPTION_CREATE,
  PAY_SUBSCRIPTION_CYCLES,
} from '@intafaced/contracts/pay-subscription-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from './record-refusal.js';
import { mandateView, PAY_MANDATE_LIST, PAY_MANDATE_CANCEL, PAY_MANDATE_GET } from '@intafaced/contracts/pay-mandate-procedures';

function toMandateOut(m: Awaited<ReturnType<SubscriptionService['getMandate']>>) {
  return {
    id: m.id,
    merchantId: m.merchantId,
    customerId: m.customerId,
    assetId: m.assetId,
    amount: formatAmount(m.amount),
    ceiling: m.ceiling === null ? null : formatAmount(m.ceiling),
    cadence: m.cadence,
    startsAt: m.startsAt.toISOString(),
    endsAt: m.endsAt === null ? null : m.endsAt.toISOString(),
    railAdapter: m.railAdapter,
    railMandateRef: m.railMandateRef,
    status: m.status,
    cancelledAt: m.cancelledAt === null ? null : m.cancelledAt.toISOString(),
    createdAt: m.createdAt.toISOString(),
  };
}

function toSubOut(s: Awaited<ReturnType<SubscriptionService['getSubscription']>>) {
  return {
    id: s.id,
    mandateId: s.mandateId,
    merchantId: s.merchantId,
    customerId: s.customerId,
    nextRunAt: s.nextRunAt.toISOString(),
    status: s.status,
    cancelledAt: s.cancelledAt === null ? null : s.cancelledAt.toISOString(),
    path: s.path,
    createdAt: s.createdAt.toISOString(),
    anchorAt: s.anchorAt === null ? null : s.anchorAt.toISOString(),
    anchorOccurrence: s.anchorOccurrence,
    pausedAt: s.pausedAt === null ? null : s.pausedAt.toISOString(),
    resumedAt: s.resumedAt === null ? null : s.resumedAt.toISOString(),
    stalledAt: s.stalledAt === null ? null : s.stalledAt.toISOString(),
    stallReason: s.stallReason,
    // A record built without one (an older fake, a row read before the column) has no price.
    priceId: s.priceId ?? null,
  };
}

function toCycleOut(c: Awaited<ReturnType<SubscriptionService['listCycles']>>[number]) {
  return {
    occurrence: c.occurrence,
    // `formatAmount`, not `String()`: an `Amount` is a scaled bigint and
    // `String()` renders 10 USDT as "10000000000000000000".
    amount: formatAmount(c.amount),
    status: c.status,
    idempotencyKey: c.idempotencyKey,
    attemptCount: c.attemptCount,
    rejectionCode: c.rejectionCode,
    paymentId: c.paymentId,
    exhausted: c.exhaustedAt !== null,
    settledAt: c.settledAt === null ? null : c.settledAt.toISOString(),
    notifyStatus: c.notifyStatus,
    notifyCode: c.notifyCode,
  };
}

function toExecutionOut(e: Awaited<ReturnType<SubscriptionService['listExecutions']>>[number]) {
  return {
    id: e.id,
    subscriptionId: e.subscriptionId,
    occurrence: e.occurrence,
    amount: formatAmount(e.amount),
    status: e.status,
    paymentId: e.paymentId,
    rejectionCode: e.rejectionCode,
    attemptedAt: e.attemptedAt.toISOString(),
    settledAt: e.settledAt === null ? null : e.settledAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
    notifyStatus: e.notifyStatus,
    notifyCode: e.notifyCode,
  };
}

function toTrpcError(err: unknown): unknown {
  if (!(err instanceof PayError)) return err;
  const code = (() => {
    switch (err.code) {
      case 'pay.merchant_not_found':
      case 'pay.mandate_not_found':
      case 'pay.subscription_not_found':
      case 'pay.price_not_found':
        return 'NOT_FOUND' as const;
      case 'pay.merchant_forbidden':
      case 'pay.submerchant_permission_denied':
      case 'pay.merchant_inactive':
      case 'pay.kyb_required':
        return 'FORBIDDEN' as const;
      case 'pay.mandate_inactive':
      case 'pay.subscription_inactive':
      case 'pay.subscription_reconsent_required':
      /*
       * CONFLICT, not BAD_REQUEST. The request is well-formed and the caller may
       * legitimately have wanted it; what refuses is the state of the mandate.
       * A resume that will not fit inside the authorised window and a charge
       * above the ceiling are both "your mandate does not allow this", which a
       * merchant resolves by re-consenting, not by fixing their payload.
       */
      case 'pay.subscription_resume_exceeds_mandate':
      case 'pay.subscription_exceeds_mandate':
      case 'pay.subscription_mandate_open':
      case 'pay.idempotency_conflict':
        return 'CONFLICT' as const;
      /*
       * The merchant cannot fix an unpublished platform fee rate, so this is not
       * their bad request. It is refuse-closed until an owner publishes a rate.
       */
      case 'pay.subscription_fee_unpublished':
      case 'pay.precharge_notify_unpublished':
      case 'pay.subscription_notify_unwired':
        return 'FORBIDDEN' as const;
      case 'pay.subscription_mandate_list_limit_unset':
      case 'pay.subscription_list_limit_unset':
      case 'pay.subscription_execution_list_limit_unset':
      case 'pay.subscription_cycle_list_limit_unset':
      // The catalogue price or its product is archived: nothing new starts on it (M-adv-payments-core-20).
      case 'pay.price_archived':
      case 'pay.product_archived':
        return 'PRECONDITION_FAILED' as const;
      default:
        return 'BAD_REQUEST' as const;
    }
  })();
  return new TRPCError({ code, message: `${err.code}: ${err.message}`, cause: err });
}

export function createSubscriptionRouter(subscriptions: SubscriptionService, pay: PayService, trees: MerchantAreaFence | null = null) {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toTrpcError(err);
    }
  };

  const assertPaymentArea = (userId: string | undefined, merchantId: string) =>
    assertMerchantAreaAccess(pay, userId, merchantId, 'payment', trees);
  /** Somebody else's mandate / subscription id reads exactly like one that does not exist. */
  const assertMandateArea = (userId: string | undefined, mandateId: string, merchantId: string) =>
    refuseAsMissing(assertPaymentArea(userId, merchantId), () => new PayError(`Mandate ${mandateId} not found`, 'pay.mandate_not_found'));
  const assertSubscriptionArea = (userId: string | undefined, subscriptionId: string, merchantId: string) =>
    refuseAsMissing(
      assertPaymentArea(userId, merchantId),
      () => new PayError(`Subscription ${subscriptionId} not found`, 'pay.subscription_not_found'),
    );

  return router({
    mandate: router({
      /**
       * Store a recurring mandate. Does not charge. Card mandate rail still
       * refuses at fire time (`pay.mandate_rail_absent`); crypto is invoice-and-watch.
       */
      create: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().guid(),
            customerId: z.string().min(1).max(128),
            assetId: z.string().min(1).max(16),
            amount: amountSchema,
            ceiling: amountSchema.optional(),
            cadence: z.enum(['daily', 'weekly', 'monthly']),
            startsAt: z.string().datetime({ offset: true }),
            endsAt: z.string().datetime({ offset: true }).optional(),
            railAdapter: z.string().min(1).max(64).optional(),
            railMandateRef: z.string().min(1).max(256).optional(),
          }),
        )
        .output(mandateView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertPaymentArea(ctx.principal?.userId, input.merchantId);
            const mandate = await subscriptions.createMandate({
              merchantId: input.merchantId,
              customerId: input.customerId,
              assetId: input.assetId,
              amount: parseAmount(input.amount),
              ceiling: input.ceiling === undefined ? null : parseAmount(input.ceiling),
              cadence: input.cadence as Cadence,
              startsAt: new Date(input.startsAt),
              endsAt: input.endsAt === undefined ? null : new Date(input.endsAt),
              railAdapter: input.railAdapter ?? null,
              railMandateRef: input.railMandateRef ?? null,
            });
            return toMandateOut(mandate);
          }),
        ),

      get: mountRecord(
        PAY_MANDATE_GET,
        ({ ctx, input }) =>
          wrap(async () => {
            const mandate = await subscriptions.getMandate(input.mandateId);
            await assertMandateArea(ctx.principal?.userId, input.mandateId, mandate.merchantId);
            return toMandateOut(mandate);
          }),
        payRefusal,
      ),

      /**
       * Merchant fleet list (ops truth). Read-only — no charge, no cascade.
       */
      list: mountRecord(
        PAY_MANDATE_LIST,
        ({ ctx, input }) =>
          wrap(async () => {
            await assertPaymentArea(ctx.principal?.userId, input.merchantId);
            const page = await subscriptions.listMandates(input.merchantId, {
              status: input.status,
              cursor: input.cursor,
              search: input.search,
              from: input.from,
              to: input.to,
              limit: input.limit,
            });
            return { items: page.items.map(toMandateOut), nextCursor: page.nextCursor };
          }),
        payRefusal,
      ),

      /**
       * Immediate mandate cancel (SPEC §4). Cascades to active subscriptions.
       * Does not reverse settled executions.
       */
      cancel: mountRecord(
        PAY_MANDATE_CANCEL,
        ({ ctx, input }) =>
          wrap(async () => {
            const existing = await subscriptions.getMandate(input.mandateId);
            await assertMandateArea(ctx.principal?.userId, input.mandateId, existing.merchantId);
            const mandate = await subscriptions.cancelMandate(input.mandateId);
            return toMandateOut(mandate);
          }),
        payRefusal,
      ),

      /**
       * Price/ceiling change without re-consent — refused in code (SPEC §4).
       * Callers must create a new mandate; this door exists so the refuse is
       * reachable over the mounted merchant surface, not unit-only.
       */
      proposeTerms: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            mandateId: z.string().guid(),
            amount: amountSchema,
            ceiling: amountSchema.nullable().optional(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const existing = await subscriptions.getMandate(input.mandateId);
            await assertMandateArea(ctx.principal?.userId, input.mandateId, existing.merchantId);
            subscriptions.proposeMandateAmountChange(existing, {
              amount: parseAmount(input.amount),
              ceiling: input.ceiling === undefined ? existing.ceiling : input.ceiling === null ? null : parseAmount(input.ceiling),
            });
          }),
        ),
    }),

    subscription: router({
      /**
       * Product Ready / honesty surface (D26-P1-P6 Done bar).
       * Crypto invoice-and-watch is product-complete; card refuse + pre-charge
       * notify gap are named. `preChargeNotify.notified` is always false.
       */
      productReady: mountRecord(
        PAY_SUBSCRIPTION_PRODUCT_READY,
        () => {
          const posture = subscriptionsProductPosture();
          // Pin imports so Ready cannot drift from the fire-path matrix/gap.
          if (posture.paths.length !== MANDATE_PATH_MATRIX.length) {
            throw new Error('mandate path matrix drift');
          }
          if (preChargeNotifyGap().notified !== false) {
            throw new Error('pre-charge notify invent');
          }
          if (preChargeNotifyGap().code !== 'pay.subscription_notify_unwired') {
            throw new Error('pre-charge notify unnamed');
          }
          if (preChargeNotifyGap().notifyStatus !== 'skipped_unwired') {
            throw new Error('pre-charge notify silent skip');
          }
          if (mandateDunningBound().maxAttemptsPerCycle < 1) {
            throw new Error('dunning bound missing');
          }
          // Mutable copy — zod output schema is not `readonly`.
          return { ...posture, paths: [...posture.paths] };
        },
        payRefusal,
      ),

      /**
       * Idempotency-Key is `idempotencyKey` on the input. The tRPC context has
       * no header slot, so this is the same place refunds put `refundId`.
       * Same key and same body returns the original subscription. Same key and
       * a different body refuses `pay.idempotency_conflict`. A second open
       * subscription on the mandate refuses `pay.subscription_mandate_open`
       * even with a new key. A blank or oversized key is
       * `pay.idempotency_required` before a subscription is created. The
       * customer mutate sends `${lockId}:${attemptId}` on this field. The lock
       * id stays `${userId}:subscription-create:${mandateId}`. A retry of the
       * same uncertain attempt reuses the stored attempt id. It is not an HTTP
       * header — see `createBusinessPayApi`.
       */
      create: mountRecord(
        PAY_SUBSCRIPTION_CREATE,
        ({ ctx, input }) =>
          wrap(async () => {
            if (input.idempotencyKey !== undefined) {
              const key = input.idempotencyKey.trim();
              if (!key || key.length > 255) {
                throw new PayError('Idempotency-Key must be 1 to 255 characters. Nothing was written.', 'pay.idempotency_required');
              }
            }
            const mandate = await subscriptions.getMandate(input.mandateId);
            await assertMandateArea(ctx.principal?.userId, input.mandateId, mandate.merchantId);
            const sub = await subscriptions.createSubscription({
              mandateId: input.mandateId,
              path: input.path,
              idempotencyKey: input.idempotencyKey,
              ...(input.priceId ? { priceId: input.priceId } : {}),
            });
            return toSubOut(sub);
          }),
        payRefusal,
      ),

      get: mountRecord(
        PAY_SUBSCRIPTION_GET,
        ({ ctx, input }) =>
          wrap(async () => {
            const sub = await subscriptions.getSubscription(input.subscriptionId);
            await assertSubscriptionArea(ctx.principal?.userId, input.subscriptionId, sub.merchantId);
            return toSubOut(sub);
          }),
        payRefusal,
      ),

      /**
       * Merchant fleet list (ops truth). Read-only — no fire, no dunning.
       */
      list: mountRecord(
        PAY_SUBSCRIPTION_LIST,
        ({ ctx, input }) =>
          wrap(async () => {
            await assertPaymentArea(ctx.principal?.userId, input.merchantId);
            const page = await subscriptions.listSubscriptions(input.merchantId, {
              status: input.status,
              limit: input.limit,
              cursor: input.cursor,
              search: input.search,
              from: input.from,
              to: input.to,
            });
            return { items: page.items.map(toSubOut), nextCursor: page.nextCursor };
          }),
        payRefusal,
      ),

      /**
       * Firing history for one subscription (invoice / settled / rejected).
       * Read-only — no dunning invent, no retry.
       */
      listExecutions: mountRecord(
        PAY_SUBSCRIPTION_LIST_EXECUTIONS,
        ({ ctx, input }) =>
          wrap(async () => {
            const sub = await subscriptions.getSubscription(input.subscriptionId);
            await assertSubscriptionArea(ctx.principal?.userId, input.subscriptionId, sub.merchantId);
            const rows = await subscriptions.listExecutions(input.subscriptionId, { limit: input.limit });
            return rows.map(toExecutionOut);
          }),
        payRefusal,
      ),

      /** Immediate cancel (SPEC §4). Does not reverse settled executions. */
      cancel: mountRecord(
        PAY_SUBSCRIPTION_CANCEL,
        ({ ctx, input }) =>
          wrap(async () => {
            const existing = await subscriptions.getSubscription(input.subscriptionId);
            await assertSubscriptionArea(ctx.principal?.userId, input.subscriptionId, existing.merchantId);
            const sub = await subscriptions.cancelSubscription(input.subscriptionId);
            return toSubOut(sub);
          }),
        payRefusal,
      ),

      /**
       * M-bill-01: collection method. `send_invoice` is the live crypto-invoice
       * path; `charge_automatically` refuses `pay.mandate_rail_absent` and the
       * method stays as it was.
       */
      setCollectionMethod: scopedProcedure('pay:write', { module: 'pay' })
        .input(z.object({ subscriptionId: z.string().guid(), method: z.enum(COLLECTION_METHODS) }))
        .output(z.object({ subscription: subscriptionView, collectionMethod: z.enum(COLLECTION_METHODS) }))
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const existing = await subscriptions.getSubscription(input.subscriptionId);
            await assertSubscriptionArea(ctx.principal?.userId, input.subscriptionId, existing.merchantId);
            const sub = await subscriptions.setCollectionMethod(input.subscriptionId, input.method);
            return { subscription: toSubOut(sub), collectionMethod: collectionMethodOf(sub.path) };
          }),
        ),

      /**
       * Pause — stop charging, and record that a person did it.
       *
       * The recorded reason is what keeps this distinguishable from a runner
       * outage later, which the TWAP ADR requires: identical mechanics,
       * completely different explanations.
       */
      pause: mountRecord(
        PAY_SUBSCRIPTION_PAUSE,
        ({ ctx, input }) =>
          wrap(async () => {
            const existing = await subscriptions.getSubscription(input.subscriptionId);
            await assertSubscriptionArea(ctx.principal?.userId, input.subscriptionId, existing.merchantId);
            return toSubOut(await subscriptions.pauseSubscription(input.subscriptionId));
          }),
        payRefusal,
      ),

      /**
       * Resume — and the schedule does not compress.
       *
       * `projectedEnd` is returned rather than left to be assumed, because
       * re-spacing genuinely changes when the subscription ends and
       * `adr/2026-08-08-twap-overdue-slice-disposition.md` requires a resume to
       * report its NEW projected end: *"A trader who paused for lunch needs to
       * know their order now runs into the close."* The merchant equivalent is
       * knowing that a month's pause moved the final period a month later.
       *
       * `null` means the mandate is open-ended, so there is no end to project.
       * A resume that would run past a bounded mandate's window is REFUSED
       * (`pay.subscription_resume_exceeds_mandate`), not quietly trimmed.
       */
      resume: mountRecord(
        PAY_SUBSCRIPTION_RESUME,
        ({ ctx, input }) =>
          wrap(async () => {
            const existing = await subscriptions.getSubscription(input.subscriptionId);
            await assertSubscriptionArea(ctx.principal?.userId, input.subscriptionId, existing.merchantId);
            const { subscription, projectedEnd } = await subscriptions.resumeSubscription(input.subscriptionId);
            return { subscription: toSubOut(subscription), projectedEnd: projectedEnd === null ? null : projectedEnd.toISOString() };
          }),
        payRefusal,
      ),

      /**
       * The period journal. Read-only, and the honest answer to "did you charge
       * me twice" — two periods carry two keys, one period retried carries one.
       */
      cycles: mountRecord(
        PAY_SUBSCRIPTION_CYCLES,
        ({ ctx, input }) =>
          wrap(async () => {
            const existing = await subscriptions.getSubscription(input.subscriptionId);
            await assertSubscriptionArea(ctx.principal?.userId, input.subscriptionId, existing.merchantId);
            const cycles = await subscriptions.listCycles(input.subscriptionId, { limit: input.limit });
            return { subscriptionId: input.subscriptionId, cycles: cycles.map(toCycleOut) };
          }),
        payRefusal,
      ),
    }),
  });
}

export type SubscriptionRouter = ReturnType<typeof createSubscriptionRouter>;

import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `subscription.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const subscriptionView = z.object({
  id: z.string().guid(),
  mandateId: z.string().guid(),
  merchantId: z.string().guid(),
  customerId: z.string(),
  nextRunAt: z.string().datetime({ offset: true }),
  status: z.enum(['active', 'paused', 'cancelled', 'completed']),
  cancelledAt: z.string().datetime({ offset: true }).nullable(),
  path: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  /**
   * The schedule frame. On the wire because a merchant looking at a resumed
   * subscription needs to see that its due times moved — a `nextRunAt` alone
   * cannot tell them whether the schedule re-spaced or is about to burst.
   */
  anchorAt: z.string().datetime({ offset: true }).nullable(),
  anchorOccurrence: z.number().int().nonnegative(),
  pausedAt: z.string().datetime({ offset: true }).nullable(),
  resumedAt: z.string().datetime({ offset: true }).nullable(),
  stalledAt: z.string().datetime({ offset: true }).nullable(),
  /**
   * WHY it stopped advancing, and the whole point of it being a separate field:
   * an operator pause and a runner outage have identical mechanics and
   * completely different explanations
   * (`adr/2026-08-08-twap-overdue-slice-disposition.md`), and arrears is a third
   * thing again. A single `paused` word owes the merchant an answer it does not
   * have.
   */
  stallReason: z.enum(['operator_pause', 'runner_outage', 'arrears', 'fee_unpublished', 'window_exhausted', 'due_pass_fault']).nullable(),
  /** The catalogue price it was started on, kept for its whole life; null when it was started from a mandate alone. */
  priceId: z.string().guid().nullable(),
});

/**
 * Card auto-pull rides the acquiring commercial socket. The rail port can store
 * a mandate reference once an acquirer exists; charge-against-mandate is still
 * not on the port, and inventing it here would invent a second money path.
 */
export const CARD_MANDATE_CHARGE_SOCKET = 'socket.psp-partners' as const;

/** §13 — customer inbox via svc-notify is still a socket. Attempt recording is not. */
export const PRECHARGE_NOTIFY_SOCKET = 'socket.pay-precharge-notify' as const;

/**
 * Merchant subscription surface — mandate + subscription create/get/list/cancel.
 *
 * Invoice runner and capture-watch stay internal (jobs / payment events).
 * This router does not pull on-chain and does not invent dunning.
 * Money paths that open invoices still go through PayService + rails.
 * `subscription.productReady` seals notify/card residuals so merchants cannot
 * read "notified" or "card pull live" from silence.
 */
export const amountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string')
  .refine((s) => !s.includes('e') && !s.includes('E'), 'scientific notation refused');

export const executionView = z.object({
  id: z.string().guid(),
  subscriptionId: z.string().guid(),
  occurrence: z.number().int().nonnegative(),
  amount: amountSchema,
  status: z.enum(['pending', 'invoiced', 'settled', 'rejected', 'skipped']),
  paymentId: z.string().guid().nullable(),
  rejectionCode: z.string().nullable(),
  attemptedAt: z.string().datetime({ offset: true }),
  settledAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  notifyStatus: z.enum(['attempted', 'skipped_unwired', 'failed']).nullable(),
  notifyCode: z.string().nullable(),
});

/**
 * Merchant fleet list (ops truth). Read-only — no fire, no dunning.
 */
export const PAY_SUBSCRIPTION_LIST = defineProcedure({
  ...base,
  name: 'pay.subscription.list',
  kind: 'query',
  path: 'subscription.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    merchantId: z.string().guid(),
    status: z.enum(['active', 'paused', 'cancelled', 'completed']).optional(),
    /**
     * Page size. Optional so omit reaches `pay.subscription_list_limit_unset`.
     * Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(300).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  }),
  output: z.object({ items: z.array(subscriptionView), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Product Ready / honesty surface (D26-P1-P6 Done bar).
 * Crypto invoice-and-watch is product-complete; card refuse + pre-charge
 * notify gap are named. `preChargeNotify.notified` is always false.
 */
export const PAY_SUBSCRIPTION_PRODUCT_READY = defineProcedure({
  ...base,
  name: 'pay.subscription.productReady',
  kind: 'query',
  path: 'subscription.productReady',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    mountain: z.literal('pay.subscriptions'),
    boardDoneBar: z.literal('Mandates product-complete; notify gaps honest'),
    paths: z.array(
      z.object({
        path: z.enum(['crypto_invoice', 'card']),
        charge: z.enum(['open_crypto_invoice', 'refuse']),
        opensMoney: z.boolean(),
        posture: z.string(),
      }),
    ),
    crypto: z.object({
      status: z.literal('product_complete'),
      charge: z.literal('open_crypto_invoice'),
      model: z.literal('invoice-and-watch'),
    }),
    card: z.object({
      status: z.literal('refuse_closed'),
      code: z.literal('pay.mandate_rail_absent'),
      socket: z.literal(CARD_MANDATE_CHARGE_SOCKET),
    }),
    dunning: z.object({
      maxAttemptsPerCycle: z.number().int().positive(),
      afterLimit: z.literal('stall_named'),
      stallReason: z.literal('arrears'),
    }),
    preChargeNotify: z.object({
      status: z.literal('unwired'),
      notifyStatus: z.literal('skipped_unwired'),
      code: z.literal('pay.subscription_notify_unwired'),
      socket: z.literal(PRECHARGE_NOTIFY_SOCKET),
      inventForbidden: z.literal(true),
      notified: z.literal(false),
      merchantReadable: z.string(),
    }),
    cancel: z.object({
      immediacy: z.literal('immediate'),
      retentionDelayForbidden: z.literal(true),
    }),
    reconsent: z.object({
      priceOrCeilingChange: z.literal('refuse'),
      code: z.literal('pay.subscription_reconsent_required'),
    }),
  }),
  samples: [{ verdict: 'accept' }],
});

export const PAY_SUBSCRIPTION_GET = defineProcedure({
  ...base,
  name: 'pay.subscription.get',
  kind: 'query',
  path: 'subscription.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ subscriptionId: z.string().guid() }),
  output: subscriptionView,
  samples: [
    { verdict: 'accept', input: { subscriptionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Firing history for one subscription (invoice / settled / rejected).
 * Read-only — no dunning invent, no retry.
 */
export const PAY_SUBSCRIPTION_LIST_EXECUTIONS = defineProcedure({
  ...base,
  name: 'pay.subscription.listExecutions',
  kind: 'query',
  path: 'subscription.listExecutions',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    subscriptionId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `pay.subscription_execution_list_limit_unset`.
     * Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(executionView),
  outputChecks: { amount_holds: { at: 'output[].amount', says: 'scientific notation refused' } },
  samples: [
    { verdict: 'accept', input: { subscriptionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Pause — stop charging, and record that a person did it.
 *
 * The recorded reason is what keeps this distinguishable from a runner
 * outage later, which the TWAP ADR requires: identical mechanics,
 * completely different explanations.
 */
export const PAY_SUBSCRIPTION_PAUSE = defineProcedure({
  ...base,
  name: 'pay.subscription.pause',
  kind: 'mutation',
  path: 'subscription.pause',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ subscriptionId: z.string().guid() }),
  output: subscriptionView,
  samples: [
    { verdict: 'accept', input: { subscriptionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

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
export const PAY_SUBSCRIPTION_RESUME = defineProcedure({
  ...base,
  name: 'pay.subscription.resume',
  kind: 'mutation',
  path: 'subscription.resume',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ subscriptionId: z.string().guid() }),
  output: z.object({ subscription: subscriptionView, projectedEnd: z.string().datetime({ offset: true }).nullable() }),
  samples: [
    { verdict: 'accept', input: { subscriptionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Immediate cancel (SPEC §4). Does not reverse settled executions. */
export const PAY_SUBSCRIPTION_CANCEL = defineProcedure({
  ...base,
  name: 'pay.subscription.cancel',
  kind: 'mutation',
  path: 'subscription.cancel',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ subscriptionId: z.string().guid() }),
  output: subscriptionView,
  samples: [
    { verdict: 'accept', input: { subscriptionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

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
export const PAY_SUBSCRIPTION_CREATE = defineProcedure({
  ...base,
  name: 'pay.subscription.create',
  kind: 'mutation',
  path: 'subscription.create',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({
    mandateId: z.string().guid(),
    /** Default crypto_invoice — never invents a pull path. */
    path: z.enum(['crypto_invoice', 'card', 'card_mandate']).optional(),
    /**
     * Caller's Idempotency-Key. Omit it and the mandate unique index is
     * still enforced. Blank or over 255 characters is
     * `pay.idempotency_required`. 255 is the existing public REST cap,
     * not a new product limit. The check lives in the handler so the
     * refusal is that pay code, not a generic parser error.
     */
    idempotencyKey: z.string().optional(),
    /**
     * A catalogue price to start it on (M-adv-payments-core-20): a monthly fixed price of this business whose
     * asset and amount are the monthly mandate's. The subscription keeps it for its whole life, through Replace
     * price and archiving.
     */
    priceId: z.string().guid().optional(),
  }),
  output: subscriptionView,
  samples: [
    { verdict: 'accept', input: { mandateId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

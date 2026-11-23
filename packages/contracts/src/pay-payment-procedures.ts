import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  payMerchantFailureSchema,
  payPaymentAttemptSchema,
  payPaymentConfirmationsSchema,
  payPaymentListInputSchema,
  payPageSchema,
  payPaymentListSummarySchema,
} from './pay-merchant-reads.js';
import { amountSchema, assetIdSchema, paymentView } from './pay-call-schemas.js';
import { jsonValueSchema } from './procedure-strict-schema.js';
import { paymentListPrivacySchema, paymentViewListSchema } from './pay-payment-views.js';
import { payRefundGetInputSchema, payRefundItemSchema } from './pay-portal-reads.js';
import { limitInput, cursorInput } from './pay-founder-admin-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `payment.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_PAYMENT_GET = defineProcedure({
  ...base,
  name: 'pay.payment.get',
  kind: 'query',
  path: 'payment.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid() }),
  output: paymentView.extend({
    attempts: z.array(payPaymentAttemptSchema),
    /** While the payment is open and its rail waits for confirmations: how deep, how deep it must be, as of when. */
    confirmations: payPaymentConfirmationsSchema.nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { paymentId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The append-only state history (§6.1). Read-only, by construction. */
export const PAY_PAYMENT_HISTORY = defineProcedure({
  ...base,
  name: 'pay.payment.history',
  kind: 'query',
  path: 'payment.history',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    paymentId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `pay.payment_history_limit_unset`
     * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(
    z.union([
      z.object({
        id: z.string().guid(),
        event: z.string(),
        payload: z.record(z.string(), jsonValueSchema),
        railEventId: z.string().nullable(),
        ts: z.string().datetime({ offset: true }),
      }),
      z
        .object({
          id: z.string().guid(),
          event: z.string(),
          ts: z.string().datetime({ offset: true }),
          amount: amountSchema.nullable(),
          assetId: assetIdSchema.nullable(),
          failure: payMerchantFailureSchema.nullable(),
        })
        .strict(),
    ]),
  ),
  samples: [
    { verdict: 'accept', input: { paymentId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Durable status list for the merchant — projection of `payments.status`. */
export const PAY_PAYMENT_LIST = defineProcedure({
  ...base,
  name: 'pay.payment.list',
  kind: 'query',
  path: 'payment.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: payPaymentListInputSchema,
  output: payPageSchema(paymentView.extend(paymentListPrivacySchema.shape)).extend({ summary: payPaymentListSummarySchema }),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_PAYMENT_AUTHORIZE = defineProcedure({
  ...base,
  name: 'pay.payment.authorize',
  kind: 'mutation',
  path: 'payment.authorize',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid() }),
  output: paymentView,
  samples: [
    { verdict: 'accept', input: { paymentId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_PAYMENT_CAPTURE = defineProcedure({
  ...base,
  name: 'pay.payment.capture',
  kind: 'mutation',
  path: 'payment.capture',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid(), amount: amountSchema.optional() }),
  output: paymentView,
  samples: [
    { verdict: 'accept', input: { paymentId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_PAYMENT_CREATE = defineProcedure({
  ...base,
  name: 'pay.payment.create',
  kind: 'mutation',
  path: 'payment.create',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({
    requestId: z.string().guid().optional(),
    merchantId: z.string().guid(),
    profileId: z.string().guid().nullish(),
    amount: amountSchema,
    assetId: assetIdSchema,
    method: z.string().min(1),
    railAdapter: z.string().min(1),
    instrument: z.object({ kind: z.string(), token: z.string().optional(), address: z.string().optional() }).optional(),
    customerRef: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  output: paymentView,
  samples: [
    {
      verdict: 'accept',
      input: { merchantId: '11111111-1111-4111-8111-111111111111', amount: '1', assetId: 'USDC', method: 'USDC', railAdapter: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_PAYMENT_REFUNDS_GET = defineProcedure({
  ...base,
  name: 'pay.payment.refunds.get',
  kind: 'query',
  path: 'payment.refunds.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: payRefundGetInputSchema,
  output: payRefundItemSchema,
  samples: [
    { verdict: 'accept', input: { refundEventId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_PAYMENT_VIEWS_LIST = defineProcedure({
  ...base,
  name: 'pay.payment.views.list',
  kind: 'query',
  path: 'payment.views.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ limit: limitInput, cursor: cursorInput }).strict(),
  output: paymentViewListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Its own scope. Refunding is not the same authority as taking payment. */
export const PAY_PAYMENT_REFUND = defineProcedure({
  ...base,
  name: 'pay.payment.refund',
  kind: 'mutation',
  path: 'payment.refund',
  access: { caller: 'scope', scope: 'pay:refund', module: 'pay' },
  refusals: {},
  input: z.object({
    paymentId: z.string().guid(),
    amount: amountSchema,
    // refundId is the caller's idempotency key. Without it the service invented
    // `${paymentId}:${count + 1}`, so a client retry of a PARTIAL refund that had
    // already succeeded booked a second refund. A retry must carry the same id.
    refundId: z
      .string()
      .min(1)
      .max(200)
      .refine((id) => id.trim().length > 0, 'refundId must not be blank'),
  }),
  checks: { refund_id_holds: { at: 'input.refundId', says: 'refundId must not be blank' } },
  output: paymentView,
  samples: [
    { verdict: 'accept', input: { paymentId: '11111111-1111-4111-8111-111111111111', amount: '1', refundId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'refund_id_holds', input: { paymentId: '11111111-1111-4111-8111-111111111111', amount: '1', refundId: ' ' } },
  ],
});

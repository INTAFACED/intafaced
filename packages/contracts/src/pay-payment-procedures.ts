import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { payMerchantFailureSchema, payPaymentAttemptSchema, payPaymentConfirmationsSchema } from './pay-merchant-reads.js';
import { amountSchema, assetIdSchema, paymentView } from './pay-call-schemas.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

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

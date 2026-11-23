import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { merchantCustomerSeriesInputSchema, merchantCustomerSeriesSchema } from './merchant-portal.js';
import { merchantActivationSchema } from './merchant-activation.js';
import { disputeFundsSchema } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantOps.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_OPS_CUSTOMERS_SERIES = defineProcedure({
  ...base,
  name: 'pay.merchantOps.customers.series',
  kind: 'query',
  path: 'merchantOps.customers.series',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantCustomerSeriesInputSchema,
  output: merchantCustomerSeriesSchema,
  samples: [
    { verdict: 'accept', input: { customerRef: 'USDC', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z', bucket: 'day' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_ACTIVATION_GET = defineProcedure({
  ...base,
  name: 'pay.merchantOps.activation.get',
  kind: 'query',
  path: 'merchantOps.activation.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: merchantActivationSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** M-disp-01: where the money is. Reads the chargeback posts by their dispute keys; posts nothing. */
export const PAY_MERCHANT_OPS_DISPUTES_FUNDS = defineProcedure({
  ...base,
  name: 'pay.merchantOps.disputes.funds',
  kind: 'query',
  path: 'merchantOps.disputes.funds',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ disputeId: z.string().trim().min(1).max(200) }),
  output: disputeFundsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

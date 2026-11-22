import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { merchantCustomerSeriesInputSchema, merchantCustomerSeriesSchema } from './merchant-portal.js';
import { merchantActivationSchema } from './merchant-activation.js';

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

import { defineProcedure } from './procedure.js';
import { merchantAnalyticsFeesSchema, merchantAnalyticsInputSchema, merchantAnalyticsVolumeSchema } from './merchant-portal.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantAnalytics.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_ANALYTICS_FEES = defineProcedure({
  ...base,
  name: 'pay.merchantAnalytics.fees',
  kind: 'query',
  path: 'merchantAnalytics.fees',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantAnalyticsInputSchema,
  output: merchantAnalyticsFeesSchema,
  outputChecks: {
    merchant_effective_rate_holds: {
      at: 'output.rates[]',
      says: 'a published rate needs a quotient; only a published quotient carries a rate; a rate has at most 6 decimal places; no_volume requires a zero gross and a non-negative fee; refused requires a negative input; a published rate needs a positive gross and a non-negative fee; a published rate needs a readable quotient; the rate is not the rounded-down quotient; exact requires a quotient that fits 6 decimal places; rounded requires a quotient that does not fit 6 decimal places',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        merchantId: '11111111-1111-4111-8111-111111111111',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
        bucket: 'day',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_ANALYTICS_VOLUME = defineProcedure({
  ...base,
  name: 'pay.merchantAnalytics.volume',
  kind: 'query',
  path: 'merchantAnalytics.volume',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantAnalyticsInputSchema,
  output: merchantAnalyticsVolumeSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        merchantId: '11111111-1111-4111-8111-111111111111',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
        bucket: 'day',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

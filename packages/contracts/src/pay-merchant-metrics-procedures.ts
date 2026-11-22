import { defineProcedure } from './procedure.js';
import {
  merchantMetricsInputSchema,
  merchantMetricsSeriesInputSchema,
  merchantMetricsSeriesSchema,
  merchantMetricsSnapshotSchema,
  merchantPartnerTermsInputSchema,
  merchantPartnerTermsSchema,
  merchantSettlementAssetsInputSchema,
  merchantSettlementAssetsSchema,
} from './merchant-metrics.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantMetrics.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_METRICS_SNAPSHOT = defineProcedure({
  ...base,
  name: 'pay.merchantMetrics.snapshot',
  kind: 'query',
  path: 'merchantMetrics.snapshot',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantMetricsInputSchema,
  output: merchantMetricsSnapshotSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', window: { kind: 'preset', preset: 'today' } } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_METRICS_SERIES = defineProcedure({
  ...base,
  name: 'pay.merchantMetrics.series',
  kind: 'query',
  path: 'merchantMetrics.series',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantMetricsSeriesInputSchema,
  output: merchantMetricsSeriesSchema,
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

/**
 * The acquiring partner's terms for this business: reserve rule, who covers a chargeback shortfall, the currencies
 * it offers and its instant payout. A term the partner has not given is `{ known: false }`, never a zero.
 */
export const PAY_MERCHANT_METRICS_PARTNER_TERMS = defineProcedure({
  ...base,
  name: 'pay.merchantMetrics.partnerTerms',
  kind: 'query',
  path: 'merchantMetrics.partnerTerms',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantPartnerTermsInputSchema,
  output: merchantPartnerTermsSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Each asset the business can settle in, with its ledger figures; refuses `pay.settlement_assets_unset` when no list is set. */
export const PAY_MERCHANT_METRICS_SETTLEMENT_ASSETS = defineProcedure({
  ...base,
  name: 'pay.merchantMetrics.settlementAssets',
  kind: 'query',
  path: 'merchantMetrics.settlementAssets',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantSettlementAssetsInputSchema,
  output: merchantSettlementAssetsSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

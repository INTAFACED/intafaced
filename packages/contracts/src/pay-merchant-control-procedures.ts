import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  merchantControlGetInputSchema,
  merchantControlProfileSchema,
  merchantLimitOpenInputSchema,
  merchantLimitOpenSchema,
  merchantLimitWithdrawInputSchema,
  merchantLimitWithdrawResultSchema,
  merchantPricingHistoryInputSchema,
  merchantPricingHistorySchema,
  merchantReserveViewSchema,
  payControlUsageSchema,
  payoutApprovalSchema,
  payPricingQuoteSchema,
  merchantControlApprovalListInputSchema,
  merchantControlApprovalPageSchema,
  merchantTierListInputSchema,
  merchantTierListSchema,
} from './merchant-control.js';
import { approvalCancelInputSchema, approvalRequestInputSchema, pricingPreviewInputSchema, usageInputSchema } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantControl.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_CONTROL_GET = defineProcedure({
  ...base,
  name: 'pay.merchantControl.get',
  kind: 'query',
  path: 'merchantControl.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantControlGetInputSchema,
  output: merchantControlProfileSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** M-money-out-01: reserve rule and recorded amounts, labelled recorded and not withheld. */
export const PAY_MERCHANT_CONTROL_RESERVE = defineProcedure({
  ...base,
  name: 'pay.merchantControl.reserve',
  kind: 'query',
  path: 'merchantControl.reserve',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantControlGetInputSchema,
  output: merchantReserveViewSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_TOP_UP_OPTIONS = defineProcedure({
  ...base,
  name: 'pay.merchantControl.topUp.options',
  kind: 'query',
  path: 'merchantControl.topUp.options',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantControlGetInputSchema,
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_USAGE = defineProcedure({
  ...base,
  name: 'pay.merchantControl.usage',
  kind: 'query',
  path: 'merchantControl.usage',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: usageInputSchema,
  output: payControlUsageSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_PRICING_PREVIEW = defineProcedure({
  ...base,
  name: 'pay.merchantControl.pricing.preview',
  kind: 'query',
  path: 'merchantControl.pricing.preview',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: pricingPreviewInputSchema,
  output: payPricingQuoteSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', assetCode: 'USDC', amount: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_APPROVALS_CANCEL = defineProcedure({
  ...base,
  name: 'pay.merchantControl.approvals.cancel',
  kind: 'mutation',
  path: 'merchantControl.approvals.cancel',
  access: { caller: 'scope', scope: 'pay:payout', module: 'pay' },
  refusals: {},
  input: approvalCancelInputSchema,
  output: payoutApprovalSchema,
  samples: [
    { verdict: 'accept', input: { approvalId: '11111111-1111-4111-8111-111111111111', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_APPROVALS_REQUEST = defineProcedure({
  ...base,
  name: 'pay.merchantControl.approvals.request',
  kind: 'mutation',
  path: 'merchantControl.approvals.request',
  access: { caller: 'scope', scope: 'pay:payout', module: 'pay' },
  refusals: {},
  input: approvalRequestInputSchema,
  output: payoutApprovalSchema,
  samples: [
    {
      verdict: 'accept',
      input: { merchantId: '11111111-1111-4111-8111-111111111111', settlementId: '11111111-1111-4111-8111-111111111111', railId: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_LIMITS_OPEN = defineProcedure({
  ...base,
  name: 'pay.merchantControl.limits.open',
  kind: 'query',
  path: 'merchantControl.limits.open',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantLimitOpenInputSchema,
  output: merchantLimitOpenSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_LIMITS_WITHDRAW = defineProcedure({
  ...base,
  name: 'pay.merchantControl.limits.withdraw',
  kind: 'mutation',
  path: 'merchantControl.limits.withdraw',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: merchantLimitWithdrawInputSchema,
  output: merchantLimitWithdrawResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: { merchantId: '11111111-1111-4111-8111-111111111111', requestId: '11111111-1111-4111-8111-111111111111', reason: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_PRICING_HISTORY = defineProcedure({
  ...base,
  name: 'pay.merchantControl.pricing.history',
  kind: 'query',
  path: 'merchantControl.pricing.history',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantPricingHistoryInputSchema,
  output: merchantPricingHistorySchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_APPROVALS_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantControl.approvals.list',
  kind: 'query',
  path: 'merchantControl.approvals.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantControlApprovalListInputSchema,
  output: merchantControlApprovalPageSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CONTROL_TIERS_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantControl.tiers.list',
  kind: 'query',
  path: 'merchantControl.tiers.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantTierListInputSchema,
  output: merchantTierListSchema,
  outputChecks: {
    merchant_tier_list_holds: { at: 'output', says: 'tier ids must be unique; current tier must be one of the listed tiers' },
  },
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

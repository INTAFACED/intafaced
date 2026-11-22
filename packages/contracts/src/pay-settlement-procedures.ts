import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  payPageSchema,
  paySettlementDetailViewSchema,
  paySettlementListInputSchema,
  paySettlementViewSchema,
} from './pay-merchant-reads.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `settlement.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/**
 * Merchant fleet list (ops truth). Read-only — no freeze, no payout.
 */
export const PAY_SETTLEMENT_LIST = defineProcedure({
  ...base,
  name: 'pay.settlement.list',
  kind: 'query',
  path: 'settlement.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: paySettlementListInputSchema,
  output: payPageSchema(paySettlementDetailViewSchema),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_SETTLEMENT_GET = defineProcedure({
  ...base,
  name: 'pay.settlement.get',
  kind: 'query',
  path: 'settlement.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ settlementId: z.string().guid() }),
  output: paySettlementDetailViewSchema,
  samples: [
    { verdict: 'accept', input: { settlementId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * G3 — unstick a pending freeze so payments can enter a later window.
 * Moves no ledger value. Requires write (ops / merchant owner).
 */
export const PAY_SETTLEMENT_RELEASE = defineProcedure({
  ...base,
  name: 'pay.settlement.release',
  kind: 'mutation',
  path: 'settlement.release',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: z.object({ settlementId: z.string().guid(), reason: z.string().min(1) }),
  output: paySettlementViewSchema,
  samples: [
    { verdict: 'accept', input: { settlementId: '11111111-1111-4111-8111-111111111111', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

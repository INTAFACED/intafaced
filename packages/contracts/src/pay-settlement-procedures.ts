import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  payPageSchema,
  paySettlementDetailViewSchema,
  paySettlementListInputSchema,
  paySettlementViewSchema,
  paySettlementLinesInputSchema,
  paySettlementLineSchema,
  paySettlementClearingSchema,
} from './pay-merchant-reads.js';
import { assetIdSchema } from './pay-call-schemas.js';
import { payPayoutLifecycleInputSchema, payPayoutLifecycleSchema } from './pay-portal-reads.js';

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

/** Payments included in one settlement, oldest first. */
export const PAY_SETTLEMENT_LINES = defineProcedure({
  ...base,
  name: 'pay.settlement.lines',
  kind: 'query',
  path: 'settlement.lines',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: paySettlementLinesInputSchema,
  output: payPageSchema(paySettlementLineSchema),
  samples: [
    { verdict: 'accept', input: { settlementId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * RC-merchant-10: captured payments whose funds the rail still holds, so clearing can show what it waits on and
 * the day the rail named. Read-only.
 */
export const PAY_SETTLEMENT_CLEARING = defineProcedure({
  ...base,
  name: 'pay.settlement.clearing',
  kind: 'query',
  path: 'settlement.clearing',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ merchantId: z.string().guid(), assetId: assetIdSchema.optional() }),
  output: paySettlementClearingSchema,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Composed payout timeline. `status` is derived from the events.
 * When the status column is ahead of the recorded timestamps, one
 * synthetic event (`timeKnown: false`) floors that status. The read
 * never reports a status lower than the column.
 */
export const PAY_SETTLEMENT_LIFECYCLE = defineProcedure({
  ...base,
  name: 'pay.settlement.lifecycle',
  kind: 'query',
  path: 'settlement.lifecycle',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: payPayoutLifecycleInputSchema,
  output: payPayoutLifecycleSchema,
  outputChecks: {
    pay_lifecycle_event_holds: { at: 'output.events[]', says: 'A lifecycle event names a timestamp only when the time is known' },
  },
  samples: [
    { verdict: 'accept', input: { settlementId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Value leaves the book here, so it carries its own scope. */
export const PAY_SETTLEMENT_PAYOUT = defineProcedure({
  ...base,
  name: 'pay.settlement.payout',
  kind: 'mutation',
  path: 'settlement.payout',
  access: { caller: 'scope', scope: 'pay:payout', module: 'pay' },
  refusals: {},
  input: z.object({
    settlementId: z.string().guid(),
    railId: z.string().min(1),
    destination: z.object({ kind: z.string().min(1), ref: z.string().min(1) }).optional(),
  }),
  output: paySettlementViewSchema,
  samples: [
    { verdict: 'accept', input: { settlementId: '11111111-1111-4111-8111-111111111111', railId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

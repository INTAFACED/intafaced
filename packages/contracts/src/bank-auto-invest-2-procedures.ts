import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString, autoInvestRuleOutput } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `autoInvest.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * Card round-up. Same-asset spare change → an earn pool, or one of the caller's own named spaces (BK-pots-02), on
 * capture. Exactly one of `targetPoolId` and `targetSpaceId`, else `bank.auto_invest_target_invalid`.
 * `buyAssetId` that differs from `assetId` refuses `bank.auto_invest_rate_unset`
 * — the surface exists so the dishonest half is named, not silent.
 */
export const BANK_AUTO_INVEST_CREATE_ROUND_UP = defineProcedure({
  ...base,
  name: 'bank.autoInvest.createRoundUp',
  kind: 'mutation',
  path: 'autoInvest.createRoundUp',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    assetId: assetIdSchema.min(1).max(16),
    granularity: amountString,
    targetPoolId: z.string().guid().optional(),
    targetSpaceId: z.string().guid().optional(),
    buyAssetId: z.string().min(1).max(16).optional(),
  }),
  output: autoInvestRuleOutput,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', granularity: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Same-asset threshold sweep: keep `threshold` in primary available; move
 * excess into an earn pool of the same asset. No rate is consulted.
 */
export const BANK_AUTO_INVEST_CREATE_THRESHOLD_SWEEP = defineProcedure({
  ...base,
  name: 'bank.autoInvest.createThresholdSweep',
  kind: 'mutation',
  path: 'autoInvest.createThresholdSweep',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    assetId: assetIdSchema.min(1).max(16),
    threshold: amountString,
    targetPoolId: z.string().guid(),
  }),
  output: autoInvestRuleOutput,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', threshold: '1', targetPoolId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * DCA schedule. Refuses `bank.auto_invest_rate_unset` when this deployment
 * has no convert counterparty — §8 rates are never invented here.
 */
export const BANK_AUTO_INVEST_CREATE_DCA = defineProcedure({
  ...base,
  name: 'bank.autoInvest.createDca',
  kind: 'mutation',
  path: 'autoInvest.createDca',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    spendAssetId: z.string().min(1).max(16),
    buyAssetId: z.string().min(1).max(16),
    amount: amountString,
    cadence: z.enum(['daily', 'weekly', 'monthly']),
    startsAt: z.string().datetime({ offset: true }),
  }),
  output: autoInvestRuleOutput,
  samples: [
    {
      verdict: 'accept',
      input: { spendAssetId: 'USDC', buyAssetId: 'USDC', amount: '1', cadence: 'daily', startsAt: '2026-01-01T00:00:00.000Z' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

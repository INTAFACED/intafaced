import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `autoInvest.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const autoInvestRuleOutput = z.object({
  id: z.string(),
  kind: z.enum(['threshold_sweep', 'dca', 'card_roundup']),
  assetId: assetIdSchema,
  threshold: amountString.nullable(),
  targetPoolId: z.string().nullable(),
  targetSpaceId: z.string().nullable(),
  buyAssetId: z.string().nullable(),
  amount: amountString.nullable(),
  cadence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
  nextRunAt: z.string().nullable(),
  status: z.enum(['active', 'paused', 'cancelled']),
  createdAt: z.string(),
});

/**
 * List this user's auto-invest rules. Rules hold no balance — they are
 * instructions; the ledger answers "how much".
 */
export const BANK_AUTO_INVEST_LIST = defineProcedure({
  ...base,
  name: 'bank.autoInvest.list',
  kind: 'query',
  path: 'autoInvest.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional so omit reaches `bank.auto_invest_list_limit_unset`
       * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
       */
      limit: z.number().int().min(1).max(200).optional(),
      /** Only the round-ups into this one of the caller's own spaces (BK-pots-02). */
      targetSpaceId: z.string().guid().optional(),
    })
    .optional(),
  output: z.array(autoInvestRuleOutput),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
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

/**
 * Hold a rule without cancelling. Runner only considers `active` rules.
 */
export const BANK_AUTO_INVEST_PAUSE = defineProcedure({
  ...base,
  name: 'bank.autoInvest.pause',
  kind: 'mutation',
  path: 'autoInvest.pause',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ ruleId: z.string().guid() }),
  output: autoInvestRuleOutput,
  samples: [
    { verdict: 'accept', input: { ruleId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Resume a paused rule. Next runDue pass applies normal due rules — no
 * multi-fire invent of missed windows.
 */
export const BANK_AUTO_INVEST_RESUME = defineProcedure({
  ...base,
  name: 'bank.autoInvest.resume',
  kind: 'mutation',
  path: 'autoInvest.resume',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ ruleId: z.string().guid() }),
  output: autoInvestRuleOutput,
  samples: [
    { verdict: 'accept', input: { ruleId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_AUTO_INVEST_CANCEL = defineProcedure({
  ...base,
  name: 'bank.autoInvest.cancel',
  kind: 'mutation',
  path: 'autoInvest.cancel',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ ruleId: z.string().guid() }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { ruleId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_AUTO_INVEST_POLICY = defineProcedure({
  ...base,
  name: 'bank.autoInvest.policy',
  kind: 'query',
  path: 'autoInvest.policy',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    enabled: z.boolean(),
    convertWired: z.boolean(),
    dcaRequiresConvert: z.literal(true),
    inventsRates: z.literal(false),
  }),
  samples: [{ verdict: 'accept' }],
});

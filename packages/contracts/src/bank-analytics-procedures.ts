import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `analytics.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const assetInput = z.object({ assetId: assetIdSchema.min(1).max(16) });

/**
 * SPEND ANALYTICS (§8.1) — computed from the ledger, every time.
 *
 * There is no `monthly_spend` table in this service and there will not be one.
 * Every figure below is a fold over ledger entries in a window; ask twice and
 * you get the same answer because the input has not changed, not because a
 * counter was maintained correctly.
 *
 * That property is worth more than the query cost: a running total is wrong
 * silently, and a user disputing their own spending figure has no way to check
 * a number that exists only in our database. This one they can check, movement
 * by movement, against the book.
 */
export const SPEND_CATEGORIES = ['transfers', 'trading', 'p2p', 'fees', 'withdrawals', 'earn', 'deposits', 'rewards', 'other'] as const;

export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/** Deposits are money in, never spending, so no budget can be set on them. */
export const BUDGET_CATEGORIES = SPEND_CATEGORIES.filter((c): c is Exclude<SpendCategory, 'deposits'> => c !== 'deposits');

export const budgetOutput = z.object({
  assetId: assetIdSchema,
  category: z.enum(BUDGET_CATEGORIES),
  period: z.string(),
  target: z.string(),
  spent: z.string(),
  progressBps: z.number().int(),
  alertBps: z.number().int(),
  alert: z.enum(['new', 'seen']).nullable(),
  alertShownAt: z.string().nullable(),
});

/** BK-acct-08: the person's budgets in one asset, each with this month's spend as the bank folds it. */
export const BANK_ANALYTICS_BUDGETS = defineProcedure({
  ...base,
  name: 'bank.analytics.budgets',
  kind: 'query',
  path: 'analytics.budgets',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: assetInput,
  output: z.array(budgetOutput),
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** This month's budget targets less this month's spend. Refuses `bank.budget_unset` with no budget. */
export const BANK_ANALYTICS_LEFT_TO_SPEND = defineProcedure({
  ...base,
  name: 'bank.analytics.leftToSpend',
  kind: 'query',
  path: 'analytics.leftToSpend',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: assetInput,
  output: z.object({ assetId: assetIdSchema, period: z.string(), target: z.string(), spent: z.string(), left: z.string() }),
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_ANALYTICS_SPEND = defineProcedure({
  ...base,
  name: 'bank.analytics.spend',
  kind: 'query',
  path: 'analytics.spend',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    assetId: assetIdSchema.min(1).max(16),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  }),
  output: z.object({
    assetId: assetIdSchema,
    from: z.string(),
    to: z.string(),
    outflowByCategory: z.record(z.string(), z.string()),
    totalOutflow: z.string(),
    totalInflow: z.string(),
    net: z.string(),
    movements: z.number().int(),
  }),
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Records that this month's alert for one budget was shown, so it shows once per month. */
export const BANK_ANALYTICS_BUDGET_ALERT_SHOWN = defineProcedure({
  ...base,
  name: 'bank.analytics.budgetAlertShown',
  kind: 'mutation',
  path: 'analytics.budgetAlertShown',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: assetInput.extend({ category: z.enum(BUDGET_CATEGORIES) }),
  output: budgetOutput,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', category: 'transfers' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Sets or changes one category's monthly target and the alert share the person chose (basis points). */
export const BANK_ANALYTICS_SET_BUDGET = defineProcedure({
  ...base,
  name: 'bank.analytics.setBudget',
  kind: 'mutation',
  path: 'analytics.setBudget',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: assetInput.extend({
    category: z.enum(BUDGET_CATEGORIES),
    target: amountString,
    alertBps: z.number().int().min(1).max(10_000),
  }),
  output: budgetOutput,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', category: 'transfers', target: '1', alertBps: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

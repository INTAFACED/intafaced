import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { bankHoldingsChangeSchema, bankValueOverTimeInputSchema, bankValueOverTimeSchema } from './bank-value-history.js';
import { allocationOutput, balanceBreakdownOutput, balanceEntriesOutput, portfolioSummaryOutput } from './bank-call-schemas.js';
import { BALANCE_ENTRIES_DEFAULT_LIMIT, BALANCE_ENTRIES_MAX_LIMIT } from './bank-ops-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `portfolio.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** The priced holdings by asset class and by available / locked (PF-balances-02). Same prices and refusals as `summary`. */
export const BANK_PORTFOLIO_ALLOCATION = defineProcedure({
  ...base,
  name: 'bank.portfolio.allocation',
  kind: 'query',
  path: 'portfolio.allocation',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: allocationOutput,
  samples: [{ verdict: 'accept' }],
});

/**
 * Every ledger entry behind one asset's spendable balance, with the sum check on top (PF-balances-01). Read-only,
 * self-only. A sum that differs from the live balance refuses `portfolio.entries_do_not_sum` with the gap.
 */
export const BANK_PORTFOLIO_BALANCE_ENTRIES = defineProcedure({
  ...base,
  name: 'bank.portfolio.balanceEntries',
  kind: 'query',
  path: 'portfolio.balanceEntries',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      assetId: assetIdSchema.min(1).max(16),
      /** `main` or the id of one named Space; absent = main and every Space. */
      accountId: z.union([z.literal('main'), z.string().guid()]).optional(),
      cursor: z.string().min(1).max(16).optional(),
      limit: z.number().int().min(1).max(BALANCE_ENTRIES_MAX_LIMIT).default(BALANCE_ENTRIES_DEFAULT_LIMIT),
    })
    .strict(),
  output: balanceEntriesOutput,
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** What rose and fell in amount over a range, per coin, priced at both ends (J-portfolio-06 #3). Same reads and refusals. */
export const BANK_PORTFOLIO_HOLDINGS_CHANGE = defineProcedure({
  ...base,
  name: 'bank.portfolio.holdingsChange',
  kind: 'query',
  path: 'portfolio.holdingsChange',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: bankValueOverTimeInputSchema,
  output: bankHoldingsChangeSchema,
  samples: [
    { verdict: 'accept', input: { from: '2026-01-01T00:00:00.000Z' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * What the caller's holdings were worth over a range, and the change-in-value bridge between its ends (J-portfolio-05
 * #6-#7). Read-only, self-only: the main account and the caller's own named Spaces, replayed from the ledger's holdings
 * history. A moment with a coin held and no price is missing, never zero.
 */
export const BANK_PORTFOLIO_VALUE_OVER_TIME = defineProcedure({
  ...base,
  name: 'bank.portfolio.valueOverTime',
  kind: 'query',
  path: 'portfolio.valueOverTime',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: bankValueOverTimeInputSchema,
  output: bankValueOverTimeSchema,
  samples: [
    { verdict: 'accept', input: { from: '2026-01-01T00:00:00.000Z' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_PORTFOLIO_SUMMARY = defineProcedure({
  ...base,
  name: 'bank.portfolio.summary',
  kind: 'query',
  path: 'portfolio.summary',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    // Not strict: a smuggled owner id is stripped here, as it always was (portfolio.router.test.ts).
    .object({
      assetId: assetIdSchema.min(1).max(16).optional(),
      valueIn: z.enum(['usd', 'btc']).optional(),
      /** The customer's display currency (PF-overview-03). USD and BTC only; any other code refuses `bank.fx_rate_unset`. */
      displayCurrency: z.string().min(2).max(8).optional(),
      /** `combined` (default), `main`, or the id of one of the caller's named spaces. */
      scope: z.string().min(1).max(64).optional(),
    })
    .optional(),
  output: portfolioSummaryOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Each asset split into spendable and every lock kind with the claim behind it (PF-balances-01). Read-only, self-only,
 * ledger reads only; the parts add up to the total exactly.
 */
export const BANK_PORTFOLIO_BALANCE_BREAKDOWN = defineProcedure({
  ...base,
  name: 'bank.portfolio.balanceBreakdown',
  kind: 'query',
  path: 'portfolio.balanceBreakdown',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      scope: z.enum(['all', 'main']).optional(),
      /** `main` or the id of one named Space. Wins over `scope`. */
      accountId: z.union([z.literal('main'), z.string().guid()]).optional(),
      assetId: assetIdSchema.min(1).max(16).optional(),
    })
    .strict()
    .optional(),
  output: balanceBreakdownOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

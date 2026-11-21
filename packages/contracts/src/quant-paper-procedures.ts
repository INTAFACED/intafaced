import { z } from 'zod';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';
import { QUANT_PAPER_LIST_MAX, quantPaperListSchema, quantPaperRunSchema } from './quant-algo.js';

/**
 * svc-quant's paper runs, one record per call (AL-live-01): start one, stop one, list a strategy's, read one. A paper run
 * trades the exchange's own prices on paper: nothing posts to a ledger and every figure is paper. svc-quant mounts each
 * from here (`routes/paper.ts`) and the customer app calls each by its record.
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;

/** The status each refusal leaves with: svc-quant's `toTrpc` (`routes/core.ts`). */
const STATUS = {
  'quant.studio_not_found': 'NOT_FOUND',
  'quant.run_not_found': 'NOT_FOUND',
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
  'quant.quota_unset': 'PRECONDITION_FAILED',
  'quant.quota_exceeded': 'PRECONDITION_FAILED',
  'quant.quota_profile_unset': 'PRECONDITION_FAILED',
  'quant.backtest_lake_missing': 'PRECONDITION_FAILED',
  'quant.params_invalid': 'BAD_REQUEST',
  'quant.backtest_rules_required': 'BAD_REQUEST',
  'quant.paper_cash_unset': 'BAD_REQUEST',
  'quant.paper_list_limit_unset': 'BAD_REQUEST',
  'quant.cost_unset': 'BAD_REQUEST',
  'quant.param_unset': 'BAD_REQUEST',
  'quant.param_out_of_range': 'BAD_REQUEST',
  'quant.sizing_rule_unset': 'BAD_REQUEST',
} as const satisfies Refusals;
type QuantRefusalCode = keyof typeof STATUS;
/** Every call reads the account's runs first: no database wired. */
const refuse = (...more: QuantRefusalCode[]): Refusals =>
  Object.freeze(
    Object.fromEntries(
      (['quant.database_url_unset', 'quant.database_pool_max_unset', ...more] as const).map((code): [string, RefusalStatus] => [
        code,
        STATUS[code],
      ]),
    ),
  );
/**
 * A run is read back from its own strategy version: a version gone reads as the run missing; its rules are compiled
 * (a blank or out-of-range rule refuses by name), and once a bar has closed its bars and published fee are read.
 */
const PRESENTED = [
  'quant.run_not_found',
  'quant.param_unset',
  'quant.param_out_of_range',
  'quant.params_invalid',
  'quant.sizing_rule_unset',
  'quant.backtest_lake_missing',
  'quant.cost_unset',
] as const;

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

const runId = z.string().min(1).max(128);
/** An operator or teammate may name the account; otherwise it is the caller's own (`resolveStudioAccount`). */
const accountField = { accountId: z.string().guid().optional() };
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

const START = {
  strategyId: 's-1',
  strategyVersion: 1,
  cash: '1000',
  holdings: [],
  feed: 'own_venue',
  costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
  ordinal: 0,
};

/**
 * Starts a paper run of one saved signal-rules version. The run key is `algo:paper:<strategyId>:v<version>:<ordinal>`,
 * where the ordinal is the count of that version's paper runs the screen read when the start dialog opened: a retry
 * after a lost reply reads the same run. An outside market feed refuses `feed.market` and stores nothing. The start
 * counts against the plan (AL-limits-01).
 */
export const QUANT_PAPER_START = defineProcedure({
  ...base,
  name: 'quant.paper.start',
  kind: 'mutation',
  path: 'paper.start',
  refusals: refuse(
    'quant.studio_not_found',
    'quant.backtest_rules_required',
    'quant.paper_cash_unset',
    'quant.quota_unset',
    'quant.quota_exceeded',
    'quant.quota_profile_unset',
    ...PRESENTED,
  ),
  input: z.object({
    strategyId: z.string().min(1).max(128),
    strategyVersion: z.number().int().positive(),
    cash: z.string().max(40),
    holdings: z.array(z.object({ symbol: z.string().max(32), qty: z.string().max(40) })).max(20),
    feed: z.string().max(40),
    costs: z.object({ feeRole: z.string().max(10), slippageBps: z.string().max(20), delayBars: z.string().max(5) }),
    ordinal: z.number().int().nonnegative(),
    ...accountField,
  }),
  output: quantPaperRunSchema,
  samples: [
    { verdict: 'accept', input: START },
    { verdict: 'accept', input: { ...START, cash: '', feed: 'outside_market', accountId: ACCOUNT } },
    { verdict: 'refuse', input: { ...START, ordinal: -1 } },
    { verdict: 'refuse', input: { ...START, costs: { feeRole: 'taker', slippageBps: '5' } } },
  ],
});

/** Stops one of the caller's paper runs: no new order after this, and the record stays. Stopping again changes nothing. */
export const QUANT_PAPER_STOP = defineProcedure({
  ...base,
  name: 'quant.paper.stop',
  kind: 'mutation',
  path: 'paper.stop',
  refusals: refuse(...PRESENTED),
  input: z.object({ runId, ...accountField }),
  output: quantPaperRunSchema,
  samples: [
    { verdict: 'accept', input: { runId: 'run_1' } },
    { verdict: 'refuse', input: { runId: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The caller's paper runs of one strategy, newest first, with each version's run count. A blank page size refuses. */
export const QUANT_PAPER_LIST = defineProcedure({
  ...base,
  name: 'quant.paper.list',
  kind: 'query',
  path: 'paper.list',
  refusals: refuse('quant.paper_list_limit_unset'),
  input: z.object({
    strategyId: z.string().min(1).max(128),
    limit: z.number().int().min(1).max(QUANT_PAPER_LIST_MAX).optional(),
    ...accountField,
  }),
  output: quantPaperListSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', limit: QUANT_PAPER_LIST_MAX } },
    { verdict: 'accept', input: { strategyId: 's-1', limit: 1, accountId: ACCOUNT } },
    { verdict: 'refuse', input: { strategyId: 's-1', limit: 0 } },
    { verdict: 'refuse', input: { strategyId: 's-1', limit: QUANT_PAPER_LIST_MAX + 1 } },
  ],
});

/** One of the caller's paper runs, with its fills, position and equity derived on this read. */
export const QUANT_PAPER_GET = defineProcedure({
  ...base,
  name: 'quant.paper.get',
  kind: 'query',
  path: 'paper.get',
  refusals: refuse(...PRESENTED),
  input: z.object({ runId, ...accountField }),
  output: quantPaperRunSchema,
  samples: [
    { verdict: 'accept', input: { runId: 'run_1' } },
    { verdict: 'accept', input: { runId: 'run_1', accountId: ACCOUNT } },
    { verdict: 'refuse', input: { runId: 'x'.repeat(129) } },
  ],
});

export const QUANT_PAPER_PROCEDURES = [QUANT_PAPER_START, QUANT_PAPER_STOP, QUANT_PAPER_LIST, QUANT_PAPER_GET] as const;

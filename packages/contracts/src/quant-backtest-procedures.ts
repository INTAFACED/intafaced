import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals } from './procedure.js';
import {
  quantAccountRulesSchema,
  quantBacktestFeeSchema,
  quantBacktestHistorySchema,
  quantBacktestInputSchema,
  quantBacktestResultSchema,
} from './quant-algo.js';
import { quantMonteCarloSchema } from './quant-research.js';
import {
  quantAccountField,
  quantCostEvidenceSchema,
  quantEnvironmentInputSchema,
  quantWalkForwardRunOutputSchema,
  quantWriteKeyField,
} from './quant-wire.js';

/**
 * svc-quant's backtests, one record per call: the walk-forward run over recorded fills (`backtest.run`), the bar backtest
 * on the exchange's own closed bars (`backtest.start`, AL-backtest-01/02), the two reads it shows first, the published
 * margin rules and fee rate, and the stored runs: one result, its Monte Carlo resampling, the history and a run's label
 * (AL-backtest-03). Simulated: none moves value. svc-quant mounts each from here (`routes/backtest.ts`).
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;
const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

/** What every write that reads the strategy and records a run can refuse, with the status svc-quant's `toTrpc` gives it. */
const RUN_REFUSALS = {
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
  'quant.studio_not_found': 'NOT_FOUND',
  'quant.params_invalid': 'BAD_REQUEST',
  'quant.quota_unset': 'PRECONDITION_FAILED',
  'quant.quota_exceeded': 'PRECONDITION_FAILED',
  'quant.quota_profile_unset': 'PRECONDITION_FAILED',
  'quant.run_result_cap_unset': 'PRECONDITION_FAILED',
  'quant.run_result_too_large': 'PRECONDITION_FAILED',
  'quant.run_immutable': 'BAD_REQUEST',
} as const satisfies Refusals;

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T04:00:00.000Z';
const T2 = '2026-01-01T08:00:00.000Z';

/** A walk-forward run of a saved strategy over the lake's recorded fills, recorded under the caller's key. */
export const QUANT_BACKTEST_RUN = defineProcedure({
  ...base,
  name: 'quant.backtest.run',
  kind: 'mutation',
  path: 'backtest.run',
  refusals: {
    ...RUN_REFUSALS,
    'quant.idempotency_key_unset': 'BAD_REQUEST',
    'quant.idempotency_conflict': 'BAD_REQUEST',
    'quant.environment_required': 'BAD_REQUEST',
    'quant.environment_unknown': 'BAD_REQUEST',
    'quant.simulated_as_live': 'BAD_REQUEST',
    'quant.strategy_version_unset': 'BAD_REQUEST',
    'quant.backtest_walk_forward_required': 'BAD_REQUEST',
    'quant.backtest_surface_refused': 'BAD_REQUEST',
    'quant.backtest_lake_missing': 'PRECONDITION_FAILED',
    'quant.backtest_fills_missing': 'PRECONDITION_FAILED',
  },
  input: z
    .object({
      strategyId: z.string(),
      strategyVersion: z.number().int().positive().optional().nullable(),
      symbol: z.string(),
      walkForward: z
        .object({
          inSampleFrom: z.string().optional(),
          inSampleTo: z.string().optional(),
          outOfSampleFrom: z.string().optional(),
          outOfSampleTo: z.string().optional(),
        })
        .optional()
        .nullable(),
      outOfSampleStatus: z.enum(['passed', 'failed', 'inconclusive']).optional().nullable(),
      costModel: z
        .object({
          fees: quantCostEvidenceSchema.optional().nullable(),
          slippage: quantCostEvidenceSchema.optional().nullable(),
          latency: quantCostEvidenceSchema.optional().nullable(),
        })
        .optional()
        .nullable(),
      strategyVariantCount: z.number().int().optional(),
      ...quantAccountField,
      ...quantWriteKeyField,
    })
    .merge(quantEnvironmentInputSchema),
  output: quantWalkForwardRunOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        strategyId: 's-1',
        symbol: 'BTC/USDT',
        walkForward: { inSampleFrom: T0, inSampleTo: T1, outOfSampleFrom: T1, outOfSampleTo: T2 },
        environment: 'backtest',
        idempotencyKey: 'bt-1',
      },
    },
    { verdict: 'accept', input: { strategyId: 's-1', symbol: 'BTC/USDT', walkForward: null, environment: 'backtest' } },
    { verdict: 'refuse', input: { symbol: 'BTC/USDT', environment: 'backtest' } },
    { verdict: 'refuse', input: { strategyId: 's-1', symbol: 'BTC/USDT', outOfSampleStatus: 'great' } },
    { verdict: 'refuse', input: { strategyId: 's-1', symbol: 'BTC/USDT', strategyVersion: 0 } },
  ],
});

/** The published rate a bar backtest of this symbol charges, with the schedule version. Read only. */
export const QUANT_BACKTEST_FEE = defineProcedure({
  ...base,
  name: 'quant.backtest.fee',
  kind: 'query',
  path: 'backtest.fee',
  // The schedule read is not wired, did not answer, or has no rate for the symbol: no rate is invented.
  refusals: { 'quant.cost_unset': 'BAD_REQUEST' },
  input: z.object({ symbol: z.string().min(1).max(32) }),
  output: quantBacktestFeeSchema,
  samples: [
    { verdict: 'accept', input: { symbol: 'BTC/USDT' } },
    { verdict: 'refuse', input: { symbol: '' } },
    { verdict: 'refuse', input: { symbol: 'X'.repeat(33) } },
  ],
});

/** The simulated account's published margin rules (ENGINE RK-5), read only; a blank one reads null. */
export const QUANT_BACKTEST_ACCOUNT_RULES = defineProcedure({
  ...base,
  name: 'quant.backtest.accountRules',
  kind: 'query',
  path: 'backtest.accountRules',
  refusals: {},
  input: NO_INPUT,
  output: quantAccountRulesSchema,
  samples: [{ verdict: 'accept', input: undefined }],
});

/**
 * Runs a saved signal-rules version on the exchange's own closed bars (AL-backtest-01, AL-backtest-02). The run key is
 * derived from everything that decides the result, so the same inputs read back the same stored run. A key's call sends
 * an `Idempotency-Key` (J-algo-dev-14 #4); a refusal before the engine stores no row.
 */
export const QUANT_BACKTEST_START = defineProcedure({
  ...base,
  name: 'quant.backtest.start',
  kind: 'mutation',
  path: 'backtest.start',
  refusals: {
    ...RUN_REFUSALS,
    // A key's call and its Idempotency-Key.
    'quant.idempotency_key_required': 'BAD_REQUEST',
    'quant.idempotency_key_invalid': 'BAD_REQUEST',
    'quant.idempotency_key_reused': 'CONFLICT',
    // The signal rules, the window, the costs and the account (`engine/run.ts`).
    'quant.backtest_rules_required': 'BAD_REQUEST',
    'quant.param_unset': 'BAD_REQUEST',
    'quant.param_out_of_range': 'BAD_REQUEST',
    'quant.sizing_rule_unset': 'BAD_REQUEST',
    'quant.cash_unset': 'BAD_REQUEST',
    'quant.backtest_window_invalid': 'BAD_REQUEST',
    'quant.backtest_window_open': 'BAD_REQUEST',
    'quant.fill_timing_unset': 'BAD_REQUEST',
    'quant.cost_unset': 'BAD_REQUEST',
    'quant.holdout_date_unset': 'BAD_REQUEST',
    'quant.holdout_overlap': 'BAD_REQUEST',
    'quant.account_rule_unset': 'BAD_REQUEST',
    // The closed bars.
    'quant.backtest_history_range': 'BAD_REQUEST',
    'quant.backtest_lake_missing': 'PRECONDITION_FAILED',
    'quant.backtest_fills_missing': 'PRECONDITION_FAILED',
  },
  input: quantBacktestInputSchema.extend(quantAccountField),
  output: quantBacktestResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        strategyId: 's-1',
        strategyVersion: 1,
        cash: '10000',
        from: T0,
        to: T2,
        fillTiming: 'next_open',
        costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
      },
    },
    {
      verdict: 'accept',
      input: {
        strategyId: 's-1',
        strategyVersion: 1,
        cash: '',
        from: '',
        to: '',
        fillTiming: '',
        costs: { feeRole: '', slippageBps: '', delayBars: '' },
        split: { preset: '1/2' },
        enforceHoldout: true,
        simulatedAccount: { leverage: '2' },
        accountId: ACCOUNT,
      },
    },
    { verdict: 'refuse', input: { strategyId: '', strategyVersion: 1, cash: '1', from: T0, to: T2, fillTiming: '', costs: {} } },
    {
      verdict: 'refuse',
      input: {
        strategyId: 's-1',
        strategyVersion: 0,
        cash: '1',
        from: T0,
        to: T2,
        fillTiming: '',
        costs: { feeRole: '', slippageBps: '', delayBars: '' },
      },
    },
  ],
});

/** The most runs one history page lists. */
export const QUANT_BACKTEST_HISTORY_PAGE_MAX = 50;

/** A stored run is the caller's own: another account's run, or one that is not a bar backtest, reads as not found. */
const STORED_RUN = { 'quant.run_not_found': 'NOT_FOUND', 'quant.params_invalid': 'BAD_REQUEST' } as const satisfies Refusals;

/** One stored bar backtest of the caller's own. */
export const QUANT_BACKTEST_RESULT = defineProcedure({
  ...base,
  name: 'quant.backtest.result',
  kind: 'query',
  path: 'backtest.result',
  refusals: STORED_RUN,
  input: z.object({ runId: z.string().min(1), ...quantAccountField }),
  output: quantBacktestResultSchema,
  samples: [
    { verdict: 'accept', input: { runId: 'r-1' } },
    { verdict: 'refuse', input: { runId: '' } },
  ],
});

/**
 * Monte Carlo resampling of one finished bar backtest of the caller's (RC-algo-dev-04; J-algo-dev-16 #3): the owner's
 * path count and fewest round trips, the caller's seed. Deterministic; nothing is stored and nothing moves.
 */
export const QUANT_BACKTEST_MONTE_CARLO = defineProcedure({
  ...base,
  name: 'quant.backtest.monteCarlo',
  kind: 'query',
  path: 'backtest.monteCarlo',
  refusals: {
    ...STORED_RUN,
    'quant.montecarlo_runs_unset': 'PRECONDITION_FAILED',
    'quant.montecarlo_min_trades_unset': 'PRECONDITION_FAILED',
    'quant.montecarlo_trades_insufficient': 'PRECONDITION_FAILED',
  },
  input: z.object({
    runId: z.string().min(1).max(128),
    /** The seed the resampling draws from: the same run, count and seed always give the same distribution. */
    seed: z.number().int().min(0).max(2_147_483_647),
    ...quantAccountField,
  }),
  output: quantMonteCarloSchema,
  samples: [
    { verdict: 'accept', input: { runId: 'r-1', seed: 7 } },
    { verdict: 'refuse', input: { runId: 'r-1', seed: -1 } },
    { verdict: 'refuse', input: { runId: '', seed: 7 } },
  ],
});

/** The caller's own bar backtests, newest first, with label, version and outcome (AL-backtest-03). */
export const QUANT_BACKTEST_HISTORY = defineProcedure({
  ...base,
  name: 'quant.backtest.history',
  kind: 'query',
  path: 'backtest.history',
  refusals: { 'quant.list_cursor_invalid': 'BAD_REQUEST', 'quant.params_invalid': 'BAD_REQUEST' },
  input: z.object({
    limit: z.number().int().min(1).max(QUANT_BACKTEST_HISTORY_PAGE_MAX),
    cursor: z.string().optional().nullable(),
    /** Only one strategy's runs (its own page). Another account's strategy id simply matches none. */
    strategyId: z.string().min(1).max(128).optional(),
    ...quantAccountField,
  }),
  output: quantBacktestHistorySchema,
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'accept', input: { limit: 20, cursor: null, strategyId: 's-1' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { limit: QUANT_BACKTEST_HISTORY_PAGE_MAX + 1 } },
  ],
});

/** Names one of the caller's own runs. The same label again changes nothing; the stored result is never touched. */
export const QUANT_BACKTEST_RENAME = defineProcedure({
  ...base,
  name: 'quant.backtest.rename',
  kind: 'mutation',
  path: 'backtest.rename',
  refusals: STORED_RUN,
  input: z.object({ runId: z.string().min(1), label: z.string(), ...quantAccountField }),
  output: z.object({ runId: z.string(), label: z.string() }),
  samples: [
    { verdict: 'accept', input: { runId: 'r-1', label: 'TEST run' } },
    { verdict: 'accept', input: { runId: 'r-1', label: '' } },
    { verdict: 'refuse', input: { runId: 'r-1' } },
  ],
});

export const QUANT_BACKTEST_PROCEDURES = [
  QUANT_BACKTEST_RUN,
  QUANT_BACKTEST_START,
  QUANT_BACKTEST_ACCOUNT_RULES,
  QUANT_BACKTEST_FEE,
  QUANT_BACKTEST_RESULT,
  QUANT_BACKTEST_MONTE_CARLO,
  QUANT_BACKTEST_HISTORY,
  QUANT_BACKTEST_RENAME,
] as const;

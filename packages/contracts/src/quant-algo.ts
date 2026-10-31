/**
 * Algo dev contract (J-algo-dev-01): the shapes the customer Algo dev rooms read from svc-quant.
 *
 * Browser safe: nothing here imports Node. Every figure a strategy or run carries is simulated; nothing here is a
 * balance or a ledger amount.
 */
import { z } from 'zod';

/** The quick start on the Algo dev home. Each step is true only when the account's own stored rows show it. */
export const quantQuickStartOutputSchema = z.object({
  strategy: z.boolean(),
  backtest: z.boolean(),
  paperRun: z.boolean(),
});
export type QuantQuickStart = z.infer<typeof quantQuickStartOutputSchema>;

/** One saved strategy as a list shows it: the head of its versions. The service sends more fields; these are read. */
export const quantStrategySummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
});
export type QuantStrategySummary = z.infer<typeof quantStrategySummarySchema>;

/** `studio.list`: the caller's undeleted strategies, one page. */
export const quantStrategyListOutputSchema = z.object({
  strategies: z.array(quantStrategySummarySchema),
  nextCursor: z.string().nullable(),
});

const decimalText = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

/** Bar sizes a signal rule reads. The same names as the exchange's candle timeframes. */
export const QUANT_BAR_SIZES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
/** How a signal rule sizes its entry: a fixed quantity, a cash amount, or a percent of simulated equity. */
export const QUANT_SIZING_KINDS = ['quantity', 'cash', 'percent_equity'] as const;

/**
 * The no-code builder's signal rules (AL-editor-02). Every numeric input travels as text and may be blank on the way
 * in: the service refuses a blank required input by name (`quant.param_unset`, `quant.sizing_rule_unset`) and a value
 * outside its range (`quant.param_out_of_range`). The exit inputs are optional; blank means no such exit.
 */
export const quantSignalRulesSchema = z.object({
  symbol: z.string().max(32),
  barSize: z.enum(QUANT_BAR_SIZES),
  signal: z.object({
    kind: z.literal('ma_cross'),
    average: z.enum(['sma', 'ema']),
    fast: z.string().max(12),
    slow: z.string().max(12),
  }),
  sizing: z.object({ kind: z.enum(QUANT_SIZING_KINDS), value: z.string().max(40) }),
  exit: z.object({ stopLossPercent: z.string().max(40), takeProfitPercent: z.string().max(40) }),
});
export type QuantSignalRules = z.infer<typeof quantSignalRulesSchema>;

/** One typed input of the signal rules, as the service declares it. Bounds are text so decimals stay exact. */
export const quantRuleInputSchema = z.object({
  name: z.string(),
  type: z.enum(['symbol', 'integer', 'decimal']),
  required: z.boolean(),
  value: z.string(),
  min: z.string().nullable(),
  max: z.string().nullable(),
});

/** `studio.compile`: the source the signal rules generate, and the inputs it declares. Nothing runs. */
export const quantCompileOutputSchema = z.object({
  source: z.string(),
  inputs: z.array(quantRuleInputSchema),
});
export type QuantCompileOutput = z.infer<typeof quantCompileOutputSchema>;

/**
 * A strategy's rules as Studio edits them: order blocks or signal rules (one of the two), the risk block and the
 * simulated starting cash.
 */
export const quantStrategyRulesSchema = z.object({
  cash: decimalText,
  blocks: z.array(z.object({ side: z.enum(['buy', 'sell']), symbol: z.string(), qty: decimalText })),
  modules: quantSignalRulesSchema.nullable(),
  risk: z.object({ maxDrawdown: z.string(), maxNotional: z.string(), kill: z.string() }),
});

/** The head of one saved strategy with its rules: what `studio.save`, `studio.update` and `studio.get` answer. */
export const quantStrategyHeadSchema = quantStrategySummarySchema.merge(quantStrategyRulesSchema).extend({
  clientStrategyId: z.string(),
});
export type QuantStrategyHead = z.infer<typeof quantStrategyHeadSchema>;

/**
 * One saved strategy as the strategy list shows it (AL-editor-01): its head with the folder (one level, blank is the
 * root), description, and the counts the screen keys its next organise (`studio.organise:<id>:<organised>`) and delete
 * (`studio.delete:<id>:<restores>`) with. `deletedAt` is set only in the recycle bin.
 */
export const QUANT_FOLDER_MAX = 40;
export const QUANT_DESCRIPTION_MAX = 500;
export const quantStrategyCardSchema = quantStrategySummarySchema.extend({
  folder: z.string(),
  description: z.string(),
  organised: z.number().int().nonnegative(),
  restores: z.number().int().nonnegative(),
  deletedAt: z.string().nullable(),
});
export type QuantStrategyCard = z.infer<typeof quantStrategyCardSchema>;
export const quantStrategyCardPageSchema = z.object({
  strategies: z.array(quantStrategyCardSchema),
  nextCursor: z.string().nullable(),
});

/** One stored version of a strategy as its page shows it (AL-editor-01): what it held and the note written with it. */
export const quantStrategyVersionSchema = z.object({
  version: z.number().int().positive(),
  name: z.string(),
  createdAt: z.string(),
  source: z.string(),
  blocks: z.array(z.object({ side: z.enum(['buy', 'sell']), symbol: z.string(), qty: z.string() })),
  releaseNote: z.string().default(''),
});
export type QuantStrategyVersion = z.infer<typeof quantStrategyVersionSchema>;

/** `studio.get`: the head and every version, oldest first. */
export const quantStrategyDetailSchema = quantStrategyCardSchema.extend({ versions: z.array(quantStrategyVersionSchema) });
export type QuantStrategyDetail = z.infer<typeof quantStrategyDetailSchema>;

/** `studio.diff`: two versions compared line by line (source, order blocks and signal rules). Derived; nothing stored. */
export const QUANT_DIFF_OPS = ['same', 'removed', 'added'] as const;
const quantDiffLineSchema = z.object({ op: z.enum(QUANT_DIFF_OPS), text: z.string() });
export const quantVersionDiffSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  source: z.array(quantDiffLineSchema),
  blocks: z.array(quantDiffLineSchema),
  rules: z.array(quantDiffLineSchema),
  changed: z.boolean(),
});
export type QuantVersionDiff = z.infer<typeof quantVersionDiffSchema>;

/** A template id: lower-case words joined by dashes, so it reads in a URL and never collides with a strategy id. */
export const quantTemplateIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/);

/**
 * One published version of a first-party starter template (AL-editor-03). Its signal rules leave every number blank:
 * the person fills them in. A release note says what changed in this version.
 */
export const quantTemplateVersionSchema = z.object({
  id: quantTemplateIdSchema,
  version: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  rules: quantSignalRulesSchema,
  releaseNote: z.string(),
  publishedAt: z.string(),
});
export type QuantTemplateVersion = z.infer<typeof quantTemplateVersionSchema>;

/** `template.list`: the newest version of each published template, one page in id order. */
export const quantTemplateListOutputSchema = z.object({
  templates: z.array(quantTemplateVersionSchema),
  nextCursor: z.string().nullable(),
});

/** `template.get`: every version of one template, newest first. Read only. */
export const quantTemplateDetailSchema = z.object({
  id: quantTemplateIdSchema,
  versions: z.array(quantTemplateVersionSchema).min(1),
});

/** `ops.template.publish`: an operator publishes the next version, with a reason for the audit row. */
export const quantTemplatePublishInputSchema = z.object({
  id: quantTemplateIdSchema,
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(1000),
  rules: quantSignalRulesSchema,
  releaseNote: z.string().trim().min(1).max(1000),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(128),
});
export type QuantTemplatePublishInput = z.infer<typeof quantTemplatePublishInputSchema>;

/**
 * How a backtest fills a signal. The engine reads a signal on a bar's close and fills it at the open of the next bar
 * that trades (ENGINE BT-2, BT-4), so a fill never uses the price the signal was read from. No default: the person
 * chooses it, so the form says what it means.
 */
export const QUANT_FILL_TIMINGS = ['next_open'] as const;
export const QUANT_FEE_ROLES = ['taker', 'maker'] as const;
/** Why an order a strategy placed did not fill. Every one is listed in the result; none is dropped silently. */
export const QUANT_BACKTEST_REJECT_REASONS = ['insufficient_cash', 'no_size', 'unfilled_at_window_end'] as const;
/**
 * The modelling choices a run made, listed on its result so the reader sees them (ENGINE BT-5 "the run says so").
 * `long_only` and `averages_over_traded_bars` hold for every run; the rest are listed only when they applied.
 */
export const QUANT_BACKTEST_ASSUMPTIONS = [
  'long_only',
  'averages_over_traded_bars',
  'stop_loss_first',
  'take_profit_without_slippage',
  'open_position_marked_at_last_close',
  'risk_limits_not_simulated',
  'stop_out_before_exits',
  'margin_level_at_bar_low',
  'loss_beyond_margin',
] as const;

/**
 * The simulated account's rules (ENGINE RK-5): one netting position, the leverage the developer picks up to the
 * owner's maximum, and the owner's margin-call and stop-out levels as a percent of the margin used. Blank is not set.
 */
export const quantAccountRulesSchema = z.object({
  mode: z.literal('netting'),
  maxLeverage: z.string().nullable(),
  marginCallPercent: z.string().nullable(),
  stopOutPercent: z.string().nullable(),
});
export type QuantAccountRules = z.infer<typeof quantAccountRulesSchema>;
export const QUANT_MARGIN_EVENTS = ['margin_call', 'stop_out'] as const;
/**
 * A margin call or stop-out on a backtest, at the bar price that reached its level (the bar's open when it gapped past),
 * with the margin level there. A stop-out's sell fills at that bar price less slippage, as its trade row shows.
 */
export const quantMarginEventSchema = z.object({
  ts: z.string(),
  kind: z.enum(QUANT_MARGIN_EVENTS),
  price: z.string(),
  marginLevelPercent: z.string(),
});
export type QuantMarginEvent = z.infer<typeof quantMarginEventSchema>;

/**
 * A bar backtest of a saved signal-rules strategy (AL-backtest-01, AL-backtest-02). Every cost is a string so a blank
 * one reaches the service and refuses by name: the fee role picks a rate from the published schedule, slippage is in
 * basis points against the order, and delay is a whole number of bars. The run key is derived by the service.
 */
export const quantBacktestInputSchema = z.object({
  strategyId: z.string().min(1),
  strategyVersion: z.number().int().positive(),
  cash: z.string(),
  from: z.string(),
  to: z.string(),
  fillTiming: z.string(),
  costs: z.object({ feeRole: z.string(), slippageBps: z.string(), delayBars: z.string() }),
  /** The out-of-sample split of the window (AL-backtest-04). Absent, the run has no out-of-sample section to judge. */
  split: z.object({ preset: z.string(), outOfSampleFrom: z.string().optional() }).optional(),
  /** Whether the run keeps clear of the owner's holdout. Absent or false, the result says the holdout is not enforced. */
  enforceHoldout: z.boolean().optional(),
  /**
   * Trade on margin (AL-backtest-02): the leverage, a string so a blank one refuses by name. Absent, the run is a cash
   * account that cannot spend more than it holds. The margin rules are the owner's, never the caller's.
   */
  simulatedAccount: z.object({ leverage: z.string() }).optional(),
  /**
   * A verdict and a variant count are computed by the service, never taken from the caller (ENGINE MT-6, MT-7). A request
   * that still sends them is accepted, the values are ignored, and the result lists them under `ignoredInputs`.
   */
  outOfSampleStatus: z.unknown().optional(),
  strategyVariantCount: z.unknown().optional(),
});
export type QuantBacktestInput = z.infer<typeof quantBacktestInputSchema>;

/** How the window splits into an in-sample part and the latest, out-of-sample part (ENGINE BT-9). */
export const QUANT_SPLIT_PRESETS = ['1/2', '1/3', '1/4', 'custom'] as const;
export type QuantSplitPreset = (typeof QUANT_SPLIT_PRESETS)[number];

/**
 * Where the out-of-sample part starts: the latest half, third or quarter of the window, or a chosen instant, moved up to
 * the next bar open so both parts hold whole bars. Null when the split leaves either part without a whole bar.
 */
export function quantOutOfSampleFrom(
  window: { readonly fromMs: number; readonly toMs: number },
  preset: QuantSplitPreset,
  spanMs: number,
  customMs?: number,
): number | null {
  const share = preset === '1/2' ? 2 : preset === '1/3' ? 3 : preset === '1/4' ? 4 : null;
  const raw = share === null ? customMs : window.toMs - Math.floor((window.toMs - window.fromMs) / share);
  if (raw === undefined || !Number.isFinite(raw)) return null;
  const at = Math.ceil(raw / spanMs) * spanMs;
  return at - window.fromMs >= spanMs && window.toMs - at >= spanMs ? at : null;
}

/** The owner's out-of-sample criteria a verdict is judged against (ENGINE MT-7). Each null one is not set. */
export const QUANT_VERDICT_CRITERIA = ['minTrades', 'minReturnPercent', 'maxDrawdownPercent', 'maxShortfallPercent'] as const;
export const quantVerdictCriteriaSchema = z.object({
  minTrades: z.string().nullable(),
  minReturnPercent: z.string().nullable(),
  maxDrawdownPercent: z.string().nullable(),
  maxShortfallPercent: z.string().nullable(),
});
export type QuantVerdictCriteria = z.infer<typeof quantVerdictCriteriaSchema>;
export const QUANT_VERDICT_STATUSES = ['passed', 'failed', 'inconclusive'] as const;

/**
 * The checks a result carries (ENGINE BT-9): what was measured, against the owner's threshold where one applies. A
 * blank threshold reads `not_set` and raises no warning; a check the run cannot make reads `not_applicable` with why.
 * Look-ahead and repainting cannot happen by how the engine is built, and say so.
 */
export const QUANT_CHECKS = ['sample_gap', 'variant_count', 'bar_offset', 'bar_type', 'look_ahead', 'repainting'] as const;
export const QUANT_CHECK_STATUSES = ['warning', 'clear', 'not_set', 'not_applicable', 'by_construction'] as const;
export const quantCheckThresholdsSchema = z.object({
  maxSampleGapPercent: z.string().nullable(),
  maxVariants: z.string().nullable(),
  maxOffsetShiftPercent: z.string().nullable(),
});
export type QuantCheckThresholds = z.infer<typeof quantCheckThresholdsSchema>;
export const quantCheckSchema = z.object({
  name: z.enum(QUANT_CHECKS),
  status: z.enum(QUANT_CHECK_STATUSES),
  /** The owner's threshold as it stood when the run finished; null when the check has none or it is blank. */
  threshold: z.string().nullable(),
  /** What the check measured, by name. A null figure is not defined for this run. */
  evidence: z.record(z.string(), z.string().nullable()),
});
export type QuantCheck = z.infer<typeof quantCheckSchema>;

/** One fill of a backtest. `barPrice` is the bar's own price; `price` is after slippage. */
export const quantBacktestTradeSchema = z.object({
  ts: z.string(),
  side: z.enum(['buy', 'sell']),
  reason: z.enum(['signal', 'stop_loss', 'take_profit', 'stop_out']),
  qty: decimalText,
  barPrice: decimalText,
  price: decimalText,
  fee: decimalText,
  slippage: decimalText,
});
export type QuantBacktestTrade = z.infer<typeof quantBacktestTradeSchema>;

/** Which bars the window holds. A gap is a run of bar intervals with no trades on the market; nothing fills inside it. */
export const quantCoverageSchema = z.object({
  barSize: z.enum(QUANT_BAR_SIZES),
  bars: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  first: z.string().nullable(),
  last: z.string().nullable(),
  gaps: z.array(z.object({ from: z.string(), to: z.string() })),
  fraction: decimalText,
});
export type QuantCoverage = z.infer<typeof quantCoverageSchema>;

/** The published rate a backtest charges, with the schedule version it was read from. */
export const quantBacktestFeeSchema = z.object({
  symbol: z.string(),
  version: z.string(),
  makerBps: z.number().int(),
  takerBps: z.number().int(),
});
export type QuantBacktestFee = z.infer<typeof quantBacktestFeeSchema>;

/**
 * A statistic of a run (ENGINE MT-4): a decimal string, or null with the reason it is not defined. Never a zero in place
 * of a missing value.
 */
export const quantMetricSchema = z.object({ value: decimalText.nullable(), reason: z.string().nullable() });
export type QuantMetric = z.infer<typeof quantMetricSchema>;

/** One entry and the exit that closed it, first in first out (ENGINE MT-5). Profit is after fees and slippage. */
export const quantRoundTripSchema = z.object({
  side: z.literal('long'),
  entryTs: z.string(),
  exitTs: z.string(),
  qty: decimalText,
  entryPrice: decimalText,
  exitPrice: decimalText,
  fees: decimalText,
  profit: decimalText,
  holdingMs: z.number().int().nonnegative(),
});
export type QuantRoundTrip = z.infer<typeof quantRoundTripSchema>;

/**
 * The report of a run (AL-report-01), computed by the engine from the run's own sided trades and equity points, never
 * typed in. Percentages are percent with four places, cut toward zero. Sharpe and Sortino need the owner's risk-free
 * rate; while it is blank they are null with `quant.risk_free_unset` and the rest still show.
 */
export const quantBacktestMetricsSchema = z.object({
  returns: z.object({
    net: quantMetricSchema,
    netPercent: quantMetricSchema,
    grossProfit: quantMetricSchema,
    grossLoss: quantMetricSchema,
    profitFactor: quantMetricSchema,
    expectedPayoff: quantMetricSchema,
    sharpe: quantMetricSchema,
    sortino: quantMetricSchema,
  }),
  risk: z.object({
    maxDrawdown: quantMetricSchema,
    maxDrawdownPercent: quantMetricSchema,
    longestDrawdownBars: quantMetricSchema,
    maxRunUp: quantMetricSchema,
    maxRunUpPercent: quantMetricSchema,
  }),
  trades: z.object({
    roundTrips: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    winRate: quantMetricSchema,
    averageWin: quantMetricSchema,
    averageLoss: quantMetricSchema,
    largestWin: quantMetricSchema,
    largestLoss: quantMetricSchema,
    longestWinStreak: z.number().int().nonnegative(),
    longestLossStreak: z.number().int().nonnegative(),
    averageHoldingMs: quantMetricSchema,
  }),
  roundTrips: z.array(quantRoundTripSchema),
});
export type QuantBacktestMetrics = z.infer<typeof quantBacktestMetricsSchema>;

/**
 * One line of a run's log, derived from the stored run on every read (AL-backtest-03). `warn` marks what a reader must
 * weigh: a gap in the bars, an order that did not fill, a modelling choice that shaped the result. Text is the screen's;
 * the line carries a code and its values.
 */
export const QUANT_BACKTEST_LOG_LEVELS = ['info', 'warn'] as const;
export const quantBacktestLogLineSchema = z.object({
  level: z.enum(QUANT_BACKTEST_LOG_LEVELS),
  code: z.string(),
  ts: z.string().nullable(),
  values: z.record(z.string(), z.string()),
});
export type QuantBacktestLogLine = z.infer<typeof quantBacktestLogLineSchema>;

/** One part of a split run: its window, its own return and drawdown, and the round trips entered inside it. */
export const quantSampleSectionSchema = z.object({
  from: z.string(),
  to: z.string(),
  startEquity: decimalText,
  endEquity: decimalText,
  returnPercent: quantMetricSchema,
  maxDrawdownPercent: quantMetricSchema,
  roundTrips: z.number().int().nonnegative(),
});
export type QuantSampleSection = z.infer<typeof quantSampleSectionSchema>;

export const quantBacktestResultSchema = z.object({
  runId: z.string(),
  runKey: z.string(),
  strategyId: z.string(),
  strategyVersion: z.number().int().positive(),
  symbol: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  fillTiming: z.enum(QUANT_FILL_TIMINGS),
  costs: z.object({
    feeScheduleVersion: z.string(),
    feeRole: z.enum(QUANT_FEE_ROLES),
    feeBps: z.number().int(),
    slippageBps: decimalText,
    delayBars: z.number().int().nonnegative(),
  }),
  coverage: quantCoverageSchema,
  trades: z.array(quantBacktestTradeSchema),
  rejected: z.array(z.object({ ts: z.string(), side: z.enum(['buy', 'sell']), reason: z.enum(QUANT_BACKTEST_REJECT_REASONS) })),
  assumptions: z.array(z.enum(QUANT_BACKTEST_ASSUMPTIONS)),
  /** One point per bar. `marginLevelPercent`: equity over the margin used, on a margin run while a position is held. */
  equity: z.array(z.object({ ts: z.string(), equity: decimalText, marginLevelPercent: decimalText.nullable().optional() })),
  totals: z.object({
    startCash: decimalText,
    gross: decimalText,
    fees: decimalText,
    slippage: decimalText,
    net: decimalText,
    endEquity: decimalText,
    openQty: decimalText,
  }),
  /** Derived from the stored trades and equity on every read, so a run stored before the report existed has one too. */
  metrics: quantBacktestMetricsSchema,
  /** The split the run was asked for, with the instant the out-of-sample part starts. Null: the run was not split. */
  split: z.object({ preset: z.enum(QUANT_SPLIT_PRESETS), outOfSampleFrom: z.string() }).nullable(),
  /** In-sample and out-of-sample figures, derived from the stored equity and trades. Null when the run was not split. */
  sections: z.object({ inSample: quantSampleSectionSchema, outOfSample: quantSampleSectionSchema }).nullable(),
  /**
   * Computed by the service from the out-of-sample section against the owner's criteria as they stood when the run
   * finished. Any blank criterion makes it inconclusive and is named in `unset`; it never reads passed.
   */
  verdict: z.object({
    status: z.enum(QUANT_VERDICT_STATUSES),
    reasons: z.array(z.string()),
    unset: z.array(z.enum(QUANT_VERDICT_CRITERIA)),
    criteria: quantVerdictCriteriaSchema,
  }),
  /** How many distinct runs of this strategy, symbol and bar size the account had finished, this one included. */
  variantCount: z.number().int().positive().nullable(),
  /** Whether the run kept clear of the owner's holdout, and where the holdout began when it did. */
  holdout: z.object({ enforced: z.boolean(), from: z.string().nullable() }),
  /** Fields the request sent that only the service may set; they were ignored. */
  ignoredInputs: z.array(z.string()),
  /** The margin account the run simulated, with the owner's rules as they stood. Null: a cash account. */
  account: quantAccountRulesSchema.extend({ leverage: z.string() }).nullable(),
  /** Margin calls and stop-outs, in the order they happened. */
  marginEvents: z.array(quantMarginEventSchema),
  /**
   * The same rules and costs run again from one bar after the window opens, to show how much the result leans on where
   * it starts. Null when it was not made; the `bar_offset` check says why (too few bars, or a run stored before it).
   */
  offsetRun: z.object({ from: z.string(), returnPercent: quantMetricSchema, trades: z.number().int().nonnegative() }).nullable(),
  /** Overfitting, look-ahead and repainting checks, derived on every read; every check is listed, none is hidden. */
  checks: z.array(quantCheckSchema),
  log: z.array(quantBacktestLogLineSchema),
  simulated: z.literal(true),
  live: z.literal(false),
  claimLabel: z.literal('Historical simulation — not a forecast'),
});
export type QuantBacktestResult = z.infer<typeof quantBacktestResultSchema>;

/** One stored bar backtest of the caller's, as the run history lists it: newest first, with its label. */
export const quantBacktestHistoryRowSchema = z.object({
  runId: z.string(),
  strategyId: z.string().nullable(),
  strategyVersion: z.number().int().positive().nullable(),
  started: z.string(),
  finished: z.string().nullable(),
  outcome: z.string().nullable(),
  label: z.string().nullable(),
});
export type QuantBacktestHistoryRow = z.infer<typeof quantBacktestHistoryRowSchema>;
export const quantBacktestHistorySchema = z.object({
  runs: z.array(quantBacktestHistoryRowSchema),
  nextCursor: z.string().nullable(),
});
/** A run's label: the person's own name for it. Renaming never touches the stored result. */
export const QUANT_RUN_LABEL_MAX = 80;

/**
 * Printable report of one stored bar backtest (AL-report-03). Every section has at least one row, so a print layout
 * has no empty section. Figures stay decimal strings or an explicit "not defined" line. Nothing here is a balance.
 */
export const QUANT_REPORT_SECTIONS = ['parameters', 'statistics', 'charts', 'coverage', 'warnings', 'labels'] as const;
export const quantReportRowSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
});
export const quantReportSectionSchema = z.object({
  id: z.enum(QUANT_REPORT_SECTIONS),
  rows: z.array(quantReportRowSchema).min(1),
});
export const quantReportSchema = z.object({
  runId: z.string(),
  claimLabel: z.literal('Historical simulation — not a forecast'),
  simulated: z.literal(true),
  live: z.literal(false),
  sections: z.tuple([
    quantReportSectionSchema.extend({ id: z.literal('parameters') }),
    quantReportSectionSchema.extend({ id: z.literal('statistics') }),
    quantReportSectionSchema.extend({ id: z.literal('charts') }),
    quantReportSectionSchema.extend({ id: z.literal('coverage') }),
    quantReportSectionSchema.extend({ id: z.literal('warnings') }),
    quantReportSectionSchema.extend({ id: z.literal('labels') }),
  ]),
});
export type QuantReport = z.infer<typeof quantReportSchema>;

/** Chart figures for a report or a public page: a summary of the equity series, not a second result. */
export const quantSeriesSummarySchema = z.object({
  points: z.number().int().nonnegative(),
  first: z.object({ ts: z.string(), equity: decimalText }).nullable(),
  last: z.object({ ts: z.string(), equity: decimalText }).nullable(),
  low: decimalText.nullable(),
  high: decimalText.nullable(),
});
export type QuantSeriesSummary = z.infer<typeof quantSeriesSummarySchema>;

/**
 * What a signed-out reader of a share link may see (AL-report-03). The historical-simulation label, the honesty
 * checks, the coverage and the result figures. No account, no strategy source, no run key.
 */
export const quantPublicResultSchema = z
  .object({
    claimLabel: z.literal('Historical simulation — not a forecast'),
    simulated: z.literal(true),
    live: z.literal(false),
    symbol: z.string(),
    window: z.object({ from: z.string(), to: z.string() }),
    coverage: quantCoverageSchema,
    costs: quantBacktestResultSchema.shape.costs,
    totals: quantBacktestResultSchema.shape.totals,
    metrics: quantBacktestMetricsSchema,
    verdict: quantBacktestResultSchema.shape.verdict,
    checks: z.array(quantCheckSchema),
    warnings: z.array(quantBacktestLogLineSchema),
    charts: quantSeriesSummarySchema,
    variantCount: z.number().int().positive().nullable(),
  })
  .strict();
export type QuantPublicResult = z.infer<typeof quantPublicResultSchema>;

/** How many links a run has, and whether one of them is still active. The token is never on this read. */
export const quantShareStateSchema = z.object({
  runId: z.string(),
  links: z.number().int().nonnegative(),
  active: z.boolean(),
  seq: z.number().int().nonnegative().nullable(),
});
export type QuantShareState = z.infer<typeof quantShareStateSchema>;

/**
 * Creating a share link (AL-report-03). `token` and `path` are set only on the call that stored the link. A replay,
 * including one whose reply was lost, does not show the token again. A blank embed-origin list leaves the link and
 * refuses only the snippet.
 */
export const quantShareCreatedSchema = quantShareStateSchema.extend({
  token: z.string().nullable(),
  path: z.string().nullable(),
  embed: z
    .object({
      snippet: z.string().min(1),
      origins: z.array(z.string().min(1)).min(1),
    })
    .nullable(),
  embedRefusal: z.literal('quant.embed_origins_unset').nullable(),
});
export type QuantShareCreated = z.infer<typeof quantShareCreatedSchema>;

export const quantShareEmbedSchema = z.object({
  snippet: z.string().min(1),
  origins: z.array(z.string().min(1)).min(1),
});
export type QuantShareEmbed = z.infer<typeof quantShareEmbedSchema>;

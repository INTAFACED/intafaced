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

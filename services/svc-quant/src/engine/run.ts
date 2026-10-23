import { createHash } from 'node:crypto';
import {
  QUANT_BACKTEST_ASSUMPTIONS,
  QUANT_FEE_ROLES,
  QUANT_FILL_TIMINGS,
  QUANT_SPLIT_PRESETS,
  quantBacktestResultSchema,
  quantOutOfSampleFrom,
  quantCheckThresholdsSchema,
  type QuantAccountRules,
  quantVerdictCriteriaSchema,
  type QuantBacktestInput,
  type QuantBacktestResult,
  type QuantCheckThresholds,
  type QuantSignalRules,
  type QuantSplitPreset,
  type QuantVerdictCriteria,
} from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import {
  QUANT_ACCOUNT_RULE_UNSET,
  QUANT_BACKTEST_FILLS_MISSING,
  QUANT_BACKTEST_RULES_REQUIRED,
  QUANT_BACKTEST_WINDOW_INVALID,
  QUANT_BACKTEST_WINDOW_OPEN,
  QUANT_CASH_UNSET,
  QUANT_COST_UNSET,
  QUANT_FILL_TIMING_UNSET,
  QUANT_HOLDOUT_DATE_UNSET,
  QUANT_HOLDOUT_OVERLAP,
  QuantError,
} from '../errors.js';
import { compileSignalRules } from '../studio/modules.js';
import { barSpanMs, coverageOf, type Bar, type BarSize } from './bars.js';
import { logOf } from './log.js';
import { metricsOf } from './metrics.js';
import type { FeePort, HistoryPort } from './ports.js';
import { simulateSignalRules, type MarginAccount } from './simulate.js';
import { sectionsOf, verdictOf } from './verdict.js';
import { checksOf, returnOf } from './checks.js';
import { z } from 'zod';

type FillTiming = (typeof QUANT_FILL_TIMINGS)[number];

/**
 * Part of every run key. Raise it whenever a change to the engine can change a result, so a stored run from the older
 * engine is never answered for a request the newer engine would compute differently.
 */
export const ENGINE_VERSION = 2;

/** Fields only the service may set (ENGINE MT-6, MT-7). A request that sends them is run, and they are ignored. */
const SERVICE_ONLY_INPUTS = ['outOfSampleStatus', 'strategyVariantCount'] as const;

/** The owner values a split run is judged against and kept clear of. Each is null while it is blank. */
export interface Judgement {
  readonly criteria: QuantVerdictCriteria;
  /** An instant with its UTC offset, or an ISO duration read as that long before the request. */
  readonly holdoutStart: string | null;
  /** The thresholds the overfitting and sensitivity checks warn above. */
  readonly checks: QuantCheckThresholds;
  /** The simulated account's margin rules (ENGINE RK-5). */
  readonly account: QuantAccountRules;
}

export const NO_JUDGEMENT: Judgement = {
  criteria: { minTrades: null, minReturnPercent: null, maxDrawdownPercent: null, maxShortfallPercent: null },
  holdoutStart: null,
  checks: { maxSampleGapPercent: null, maxVariants: null, maxOffsetShiftPercent: null },
  account: { mode: 'netting', maxLeverage: null, marginCallPercent: null, stopOutPercent: null },
};

/** A delay longer than this many bars is refused as out of range: it would outlast most windows the history holds. */
export const MAX_DELAY_BARS = 100;

/** The most runs one history page lists. */
export const BACKTEST_HISTORY_PAGE_MAX = 50;

/**
 * Every bar backtest's run key starts with this. The older fills-language `backtest.run` stores kind 'backtest' too,
 * under a key the caller chose, and has no bar result to open, so history and rename keep to this prefix.
 */
export const BAR_BACKTEST_KEY_PREFIX = 'algo:bt:';

export function isBarBacktest(run: { readonly kind: string; readonly idempotencyKey: string }): boolean {
  return run.kind === 'backtest' && run.idempotencyKey.startsWith(BAR_BACKTEST_KEY_PREFIX);
}

const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;
const DECIMAL = /^\d+(\.\d{1,18})?$/;

/** The strategy version a backtest runs, as the library stores it. */
export interface StrategyAtVersion {
  readonly id: string;
  readonly version: number;
  readonly modules: QuantSignalRules | null;
  /** The version's risk block. A bar backtest does not apply it, and a result says so when any limit is set. */
  readonly risk: { readonly maxDrawdown: string; readonly maxNotional: string; readonly kill: string };
}

/** Everything that decides a result, checked, with the derived run key (ENGINE BT-1). */
export interface PreparedBacktest {
  readonly key: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly rules: QuantSignalRules;
  readonly fromMs: number;
  readonly toMs: number;
  readonly cash: Amount;
  readonly fillTiming: FillTiming;
  readonly feeRole: (typeof QUANT_FEE_ROLES)[number];
  readonly feeBps: number;
  readonly feeScheduleVersion: string;
  readonly slippageBps: Amount;
  readonly delayBars: number;
  readonly riskSet: boolean;
  readonly split: { readonly preset: QuantSplitPreset; readonly outOfSampleFromMs: number } | null;
  readonly criteria: QuantVerdictCriteria;
  readonly checks: QuantCheckThresholds;
  /** The margin account, checked; null for a cash account. */
  readonly account: (MarginAccount & { readonly rules: QuantAccountRules & { readonly leverage: string } }) | null;
  /** A holdout refusal waits until no stored run answers the key: a stored run reads back after the owner moves the holdout. */
  readonly holdout: { readonly enforced: boolean; readonly fromMs: number | null; readonly refusal: QuantError | null };
  readonly ignoredInputs: readonly string[];
}

function instantOf(name: string, raw: string): number {
  const text = raw.trim();
  const at = EXPLICIT_OFFSET.test(text) ? Date.parse(text) : Number.NaN;
  // Date.parse rolls an impossible day forward (31 February becomes 3 March); a date that does not read back is refused.
  const day = /^(\d{4}-\d{2}-\d{2})T/.exec(text)?.[1];
  const offsetMs = offsetOf(text);
  if (!Number.isFinite(at) || !day || new Date(at + offsetMs).toISOString().slice(0, 10) !== day) {
    throw new QuantError(QUANT_BACKTEST_WINDOW_INVALID, `${name} must be a date and time with its UTC offset`);
  }
  return at;
}

/** The offset written on an instant, in milliseconds east of UTC. */
function offsetOf(text: string): number {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(text);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === '-' ? -1 : 1) * minutes * 60_000;
}

/**
 * The out-of-sample split of the window (ENGINE BT-9): the latest half, third or quarter, or a chosen start, moved up to
 * the next bar open. Absent, the run is not split and its verdict says so.
 */
function splitOf(split: QuantBacktestInput['split'], fromMs: number, toMs: number, spanMs: number): PreparedBacktest['split'] {
  if (!split) return null;
  const preset = split.preset.trim();
  if (!(QUANT_SPLIT_PRESETS as readonly string[]).includes(preset)) {
    throw new QuantError(QUANT_BACKTEST_WINDOW_INVALID, `split — choose one of ${QUANT_SPLIT_PRESETS.join(', ')}`);
  }
  const customMs = preset === 'custom' ? instantOf('out-of-sample start', split.outOfSampleFrom ?? '') : undefined;
  const at = quantOutOfSampleFrom({ fromMs, toMs }, preset as QuantSplitPreset, spanMs, customMs);
  if (at === null) {
    throw new QuantError(QUANT_BACKTEST_WINDOW_INVALID, 'split — each part must hold at least one whole bar inside the window');
  }
  return { preset: preset as QuantSplitPreset, outOfSampleFromMs: at };
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i;

/** Where the owner's holdout begins: a fixed instant, or a span back from the request. Null when blank or empty. */
export function holdoutStartMs(setting: string | null, now: number): number | null {
  if (!setting) return null;
  const span = DURATION.exec(setting);
  if (span) {
    const ms = ((Number(span[1] ?? 0) * 24 + Number(span[2] ?? 0)) * 60 + Number(span[3] ?? 0)) * 60_000;
    return ms > 0 ? now - ms : null;
  }
  const at = Date.parse(setting);
  return Number.isFinite(at) ? at : null;
}

/**
 * Keeps the in-sample part clear of the owner's holdout when the run asks to. The in-sample part ends where the
 * out-of-sample part starts, or at the window's end when the run is not split. A run that does not ask says so.
 */
function holdoutOf(enforced: boolean, setting: string | null, inSampleEndMs: number, now: number): PreparedBacktest['holdout'] {
  if (!enforced) return { enforced: false, fromMs: null, refusal: null };
  const fromMs = holdoutStartMs(setting, now);
  if (fromMs === null) {
    const refusal = new QuantError(
      QUANT_HOLDOUT_DATE_UNSET,
      'holdout — the owner has not set where the holdout begins; nothing is assumed',
    );
    return { enforced: true, fromMs: null, refusal };
  }
  if (inSampleEndMs > fromMs) {
    const refusal = new QuantError(
      QUANT_HOLDOUT_OVERLAP,
      `holdout — the in-sample part runs to ${new Date(inSampleEndMs).toISOString()}, into the holdout that begins ${new Date(fromMs).toISOString()}`,
    );
    return { enforced: true, fromMs, refusal };
  }
  return { enforced: true, fromMs, refusal: null };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

/**
 * Checks a backtest request in the order the form shows it, then reads the published fee for the strategy's symbol.
 * Every blank refuses by name and nothing runs; nothing is defaulted. `now` only decides whether the window has closed.
 */
export async function prepareBacktest(
  input: QuantBacktestInput,
  strategy: StrategyAtVersion,
  fees: FeePort,
  now: number,
  judgement: Judgement = NO_JUDGEMENT,
): Promise<PreparedBacktest> {
  if (!strategy.modules) {
    throw new QuantError(QUANT_BACKTEST_RULES_REQUIRED, 'a bar backtest runs signal rules; this version trades by order blocks');
  }
  const cashText = input.cash.trim();
  if (!cashText) throw new QuantError(QUANT_CASH_UNSET, 'cash — starting cash is unset; no amount is assumed');
  if (!DECIMAL.test(cashText) || parseAmount(cashText) <= 0n) {
    throw new QuantError(QUANT_CASH_UNSET, 'cash — starting cash must be an amount above 0');
  }
  const fromMs = instantOf('from', input.from);
  const toMs = instantOf('to', input.to);
  if (fromMs >= toMs) throw new QuantError(QUANT_BACKTEST_WINDOW_INVALID, 'from must be before to');
  if (toMs > now) throw new QuantError(QUANT_BACKTEST_WINDOW_OPEN, 'to is after now; a backtest reads closed bars only');

  const timing = input.fillTiming.trim();
  if (!timing) throw new QuantError(QUANT_FILL_TIMING_UNSET, 'fill timing is unset; choose the next bar open');
  if (!(QUANT_FILL_TIMINGS as readonly string[]).includes(timing)) {
    throw new QuantError(QUANT_FILL_TIMING_UNSET, `fill timing ${timing} is not one of ${QUANT_FILL_TIMINGS.join(', ')}`);
  }
  const role = input.costs.feeRole.trim();
  if (!(QUANT_FEE_ROLES as readonly string[]).includes(role)) {
    throw new QuantError(QUANT_COST_UNSET, 'fees — choose the taker or maker rate of the published schedule');
  }
  const slippageText = input.costs.slippageBps.trim();
  if (!slippageText) throw new QuantError(QUANT_COST_UNSET, 'slippage — fill in slippage in basis points; it is never assumed to be 0');
  if (!DECIMAL.test(slippageText) || parseAmount(slippageText) >= parseAmount('10000')) {
    throw new QuantError(QUANT_COST_UNSET, 'slippage — must be basis points from 0 up to, not including, 10000');
  }
  const delayText = input.costs.delayBars.trim();
  if (!delayText) throw new QuantError(QUANT_COST_UNSET, 'delay — fill in the delay in whole bars; it is never assumed to be 0');
  if (!/^\d{1,3}$/.test(delayText) || Number(delayText) > MAX_DELAY_BARS) {
    throw new QuantError(QUANT_COST_UNSET, `delay — must be a whole number of bars from 0 to ${MAX_DELAY_BARS}`);
  }

  const rules = compileSignalRules(strategy.modules).rules;
  const split = splitOf(input.split, fromMs, toMs, barSpanMs(rules.barSize as BarSize));
  const holdout = holdoutOf(input.enforceHoldout === true, judgement.holdoutStart, split?.outOfSampleFromMs ?? toMs, now);
  const account = accountOf(input.simulatedAccount, judgement.account);
  const fee = await fees.fee(rules.symbol);
  const feeRole = role as PreparedBacktest['feeRole'];
  const prepared = {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    rules,
    fromMs,
    toMs,
    cash: parseAmount(cashText),
    fillTiming: timing as FillTiming,
    feeRole,
    feeBps: feeRole === 'maker' ? fee.makerBps : fee.takerBps,
    feeScheduleVersion: fee.version,
    slippageBps: parseAmount(slippageText),
    delayBars: Number(delayText),
    riskSet: [strategy.risk.maxDrawdown, strategy.risk.maxNotional, strategy.risk.kill].some((value) => value.trim() !== ''),
    split,
    criteria: judgement.criteria,
    checks: judgement.checks,
    account,
    holdout,
    ignoredInputs: SERVICE_ONLY_INPUTS.filter((name) => input[name] !== undefined),
  };
  // The split and the holdout choice are part of the window.
  const windowHash = split || holdout.enforced ? hash([fromMs, toMs, split, holdout.enforced]) : hash([fromMs, toMs]);
  // The owner's criteria and thresholds are stored with the run, not hashed into its key: the same inputs after the owner
  // changes them read back the stored run, judged as it was, and stay one variant.
  // A margin account changes the trades, so its leverage and the owner's levels are part of the key; a cash run's is as before.
  const margin = account ? [account.rules] : [];
  const paramsHash = hash([ENGINE_VERSION, rules, prepared.fillTiming, formatAmount(prepared.cash), prepared.riskSet, ...margin]);
  const costsHash = hash([fee.version, feeRole, prepared.feeBps, formatAmount(prepared.slippageBps), prepared.delayBars]);
  return { ...prepared, key: `${BAR_BACKTEST_KEY_PREFIX}${strategy.id}:v${strategy.version}:${windowHash}:${paramsHash}:${costsHash}` };
}

const LEVERAGE = /^\d{1,4}(\.\d{1,2})?$/;

/**
 * The margin account a run asks for (ENGINE RK-5), or null for a cash account. The leverage is the developer's, from 1
 * up to the owner's maximum; the margin-call and stop-out levels are the owner's. Any blank refuses by name and nothing
 * runs; nothing is defaulted.
 */
function accountOf(asked: QuantBacktestInput['simulatedAccount'], rules: QuantAccountRules): PreparedBacktest['account'] {
  if (!asked) return null;
  const leverageText = asked.leverage.trim();
  if (!leverageText) throw new QuantError(QUANT_ACCOUNT_RULE_UNSET, 'leverage — fill in the leverage; it is never assumed to be 1');
  if (rules.maxLeverage === null) {
    throw new QuantError(QUANT_ACCOUNT_RULE_UNSET, 'maximum leverage — the owner has not published it; nothing is assumed');
  }
  if (rules.marginCallPercent === null) {
    throw new QuantError(QUANT_ACCOUNT_RULE_UNSET, 'margin call level — the owner has not published it; nothing is assumed');
  }
  if (rules.stopOutPercent === null) {
    throw new QuantError(QUANT_ACCOUNT_RULE_UNSET, 'stop-out level — the owner has not published it; nothing is assumed');
  }
  if (parseAmount(rules.stopOutPercent) <= 0n || parseAmount(rules.stopOutPercent) >= parseAmount(rules.marginCallPercent)) {
    throw new QuantError(QUANT_ACCOUNT_RULE_UNSET, 'stop-out level — the published level must be above 0 and below the margin call level');
  }
  const leverage = LEVERAGE.test(leverageText) ? parseAmount(leverageText) : -1n;
  if (leverage < parseAmount('1') || leverage > parseAmount(rules.maxLeverage)) {
    throw new QuantError(QUANT_ACCOUNT_RULE_UNSET, `leverage — must be from 1 up to the published maximum of ${rules.maxLeverage}`);
  }
  return {
    leverage,
    marginCallPercent: parseAmount(rules.marginCallPercent),
    stopOutPercent: parseAmount(rules.stopOutPercent),
    rules: { ...rules, leverage: formatAmount(leverage) },
  };
}

/** The window's closed bars. An empty window refuses; no bar is invented. */
export async function readWindowBars(prepared: PreparedBacktest, history: HistoryPort): Promise<Bar[]> {
  if (prepared.holdout.refusal) throw prepared.holdout.refusal;
  const barSize = prepared.rules.barSize as BarSize;
  const bars = await history.bars({ symbol: prepared.rules.symbol, barSize, fromMs: prepared.fromMs, toMs: prepared.toMs });
  if (bars.length === 0) {
    throw new QuantError(
      QUANT_BACKTEST_FILLS_MISSING,
      `no ${barSize} bar of ${prepared.rules.symbol} traded in the window; no bar is invented`,
    );
  }
  return bars;
}

/** Runs the engine on bars already read. The result holds only what this run computed. */
/**
 * What a run stores: everything but its row id and what is derived from it on every read (the report, the log, the
 * split sections and the verdict), plus the owner's criteria as they stood when it ran. A run stored before the split
 * existed reads as not split, not counted and not enforcing the holdout.
 */
const storedBacktestSchema = quantBacktestResultSchema
  .omit({ runId: true, metrics: true, log: true, sections: true, verdict: true, checks: true })
  .extend({
    split: quantBacktestResultSchema.shape.split.default(null),
    variantCount: quantBacktestResultSchema.shape.variantCount.default(null),
    holdout: quantBacktestResultSchema.shape.holdout.default({ enforced: false, from: null }),
    ignoredInputs: quantBacktestResultSchema.shape.ignoredInputs.default([]),
    criteria: quantVerdictCriteriaSchema.default(NO_JUDGEMENT.criteria),
    // Undefined on a run stored before the sensitivity run existed: its check says it was not run, not that bars were short.
    offsetRun: quantBacktestResultSchema.shape.offsetRun.optional(),
    account: quantBacktestResultSchema.shape.account.default(null),
    marginEvents: quantBacktestResultSchema.shape.marginEvents.default([]),
    checkThresholds: quantCheckThresholdsSchema.default(NO_JUDGEMENT.checks),
  });
export type StoredBacktest = z.infer<typeof storedBacktestSchema>;

/** A stored bar backtest, or null when the response is not one (another run kind, or a run of the older fills form). */
export function readStoredBacktest(response: unknown): StoredBacktest | null {
  const parsed = storedBacktestSchema.safeParse(response);
  return parsed.success ? parsed.data : null;
}

/** A stored run as the caller reads it: its row id, and the report, log, sections and verdict computed from it. */
export function presentBacktest(stored: StoredBacktest, runId: string): QuantBacktestResult {
  const { criteria, checkThresholds, ...rest } = stored;
  const sections = stored.split ? sectionsOf(stored, stored.split.outOfSampleFrom) : null;
  return {
    ...rest,
    offsetRun: stored.offsetRun ?? null,
    runId,
    metrics: metricsOf(stored),
    log: logOf(stored),
    sections,
    verdict: verdictOf(sections, criteria),
    checks: checksOf(stored, sections, checkThresholds),
  };
}

export function runOnBars(prepared: PreparedBacktest, bars: readonly Bar[], variantCount: number | null = null): StoredBacktest {
  if (prepared.holdout.refusal) throw prepared.holdout.refusal;
  const barSize = prepared.rules.barSize as BarSize;
  const simulate = (on: readonly Bar[]) =>
    simulateSignalRules({
      rules: prepared.rules,
      bars: on,
      spanMs: barSpanMs(barSize),
      cash: prepared.cash,
      feeBps: prepared.feeBps,
      slippageBps: prepared.slippageBps,
      delayBars: prepared.delayBars,
      account: prepared.account,
    });
  const ran = simulate(bars);
  // The sensitivity run: the same rules and costs from the window's second traded bar, by position, so a window that
  // opens in a gap still starts one bar later. Under two bars left, there is none.
  const later = bars.slice(1);
  const offset = later.length >= 2 ? simulate(later) : null;
  return {
    runKey: prepared.key,
    strategyId: prepared.strategyId,
    strategyVersion: prepared.strategyVersion,
    symbol: prepared.rules.symbol,
    window: { from: new Date(prepared.fromMs).toISOString(), to: new Date(prepared.toMs).toISOString() },
    fillTiming: prepared.fillTiming,
    costs: {
      feeScheduleVersion: prepared.feeScheduleVersion,
      feeRole: prepared.feeRole,
      feeBps: prepared.feeBps,
      slippageBps: formatAmount(prepared.slippageBps),
      delayBars: prepared.delayBars,
    },
    coverage: coverageOf(bars, barSize, prepared.fromMs, prepared.toMs),
    trades: [...ran.trades],
    rejected: [...ran.rejected],
    equity: [...ran.equity],
    assumptions: QUANT_BACKTEST_ASSUMPTIONS.filter(
      (name) => ran.assumptions.includes(name) || (name === 'risk_limits_not_simulated' && prepared.riskSet),
    ),
    totals: ran.totals,
    split: prepared.split
      ? { preset: prepared.split.preset, outOfSampleFrom: new Date(prepared.split.outOfSampleFromMs).toISOString() }
      : null,
    variantCount,
    holdout: {
      enforced: prepared.holdout.enforced,
      from: prepared.holdout.fromMs === null ? null : new Date(prepared.holdout.fromMs).toISOString(),
    },
    ignoredInputs: [...prepared.ignoredInputs],
    criteria: prepared.criteria,
    offsetRun:
      offset === null
        ? null
        : { from: new Date(later[0]!.openTimeMs).toISOString(), returnPercent: returnOf(offset.totals), trades: offset.trades.length },
    checkThresholds: prepared.checks,
    account: prepared.account?.rules ?? null,
    marginEvents: [...ran.marginEvents],
    simulated: true,
    live: false,
    claimLabel: 'Historical simulation — not a forecast',
  };
}

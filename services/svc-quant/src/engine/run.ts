import { createHash } from 'node:crypto';
import {
  QUANT_BACKTEST_ASSUMPTIONS,
  QUANT_FEE_ROLES,
  QUANT_FILL_TIMINGS,
  type QuantBacktestInput,
  type QuantBacktestResult,
  type QuantSignalRules,
} from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import {
  QUANT_BACKTEST_FILLS_MISSING,
  QUANT_BACKTEST_RULES_REQUIRED,
  QUANT_BACKTEST_WINDOW_INVALID,
  QUANT_BACKTEST_WINDOW_OPEN,
  QUANT_CASH_UNSET,
  QUANT_COST_UNSET,
  QUANT_FILL_TIMING_UNSET,
  QuantError,
} from '../errors.js';
import { compileSignalRules } from '../studio/modules.js';
import { barSpanMs, coverageOf, type Bar, type BarSize } from './bars.js';
import { logOf } from './log.js';
import { metricsOf } from './metrics.js';
import type { FeePort, HistoryPort } from './ports.js';
import { simulateSignalRules } from './simulate.js';

type FillTiming = (typeof QUANT_FILL_TIMINGS)[number];

/**
 * Part of every run key. Raise it whenever a change to the engine can change a result, so a stored run from the older
 * engine is never answered for a request the newer engine would compute differently.
 */
export const ENGINE_VERSION = 2;

/** A delay longer than this many bars is refused as out of range: it would outlast most windows the history holds. */
export const MAX_DELAY_BARS = 100;

/** The most runs one history page lists. */
export const BACKTEST_HISTORY_PAGE_MAX = 50;

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
}

function instant(name: 'from' | 'to', raw: string): number {
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
): Promise<PreparedBacktest> {
  if (!strategy.modules) {
    throw new QuantError(QUANT_BACKTEST_RULES_REQUIRED, 'a bar backtest runs signal rules; this version trades by order blocks');
  }
  const cashText = input.cash.trim();
  if (!cashText) throw new QuantError(QUANT_CASH_UNSET, 'cash — starting cash is unset; no amount is assumed');
  if (!DECIMAL.test(cashText) || parseAmount(cashText) <= 0n) {
    throw new QuantError(QUANT_CASH_UNSET, 'cash — starting cash must be an amount above 0');
  }
  const fromMs = instant('from', input.from);
  const toMs = instant('to', input.to);
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
  };
  const windowHash = hash([fromMs, toMs]);
  const paramsHash = hash([ENGINE_VERSION, rules, prepared.fillTiming, formatAmount(prepared.cash), prepared.riskSet]);
  const costsHash = hash([fee.version, feeRole, prepared.feeBps, formatAmount(prepared.slippageBps), prepared.delayBars]);
  return { ...prepared, key: `algo:bt:${strategy.id}:v${strategy.version}:${windowHash}:${paramsHash}:${costsHash}` };
}

/** The window's closed bars. An empty window refuses; no bar is invented. */
export async function readWindowBars(prepared: PreparedBacktest, history: HistoryPort): Promise<Bar[]> {
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
/** What a run stores: everything but its row id, the report and the log, which are derived from it on every read. */
export type StoredBacktest = Omit<QuantBacktestResult, 'runId' | 'metrics' | 'log'>;

/** A stored run as the caller reads it: its row id, and the report and log computed from what it stored. */
export function presentBacktest(stored: StoredBacktest, runId: string): QuantBacktestResult {
  return { ...stored, runId, metrics: metricsOf(stored), log: logOf(stored) };
}

export function runOnBars(prepared: PreparedBacktest, bars: readonly Bar[]): StoredBacktest {
  const barSize = prepared.rules.barSize as BarSize;
  const ran = simulateSignalRules({
    rules: prepared.rules,
    bars,
    spanMs: barSpanMs(barSize),
    cash: prepared.cash,
    feeBps: prepared.feeBps,
    slippageBps: prepared.slippageBps,
    delayBars: prepared.delayBars,
  });
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
    simulated: true,
    live: false,
    claimLabel: 'Historical simulation — not a forecast',
  };
}

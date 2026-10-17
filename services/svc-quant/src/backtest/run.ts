import { add, formatAmount, mul, parseAmount } from '@intafaced/ledger-client/money';
import {
  assessBacktestSurface,
  type BacktestCostModel,
  type OutOfSampleStatus,
  type OutOfSampleVerdict,
  type SimulatedPerformanceStamp,
} from '@intafaced/quant-honesty';
import {
  QUANT_BACKTEST_FILLS_MISSING,
  QUANT_BACKTEST_LAKE_MISSING,
  QUANT_BACKTEST_SURFACE_REFUSED,
  QUANT_BACKTEST_WALK_FORWARD_REQUIRED,
  QUANT_STRATEGY_VERSION_UNSET,
  QuantError,
} from '../errors.js';
import { requireSimulatedStamp } from '../honesty.js';
import { buildBacktestBody } from '../runs/detail.js';
import type { RunResultBody } from '../runs/types.js';
import type { BacktestLake, LakeFill } from './lake.js';

export interface WalkForwardWindow {
  readonly inSampleFrom: string;
  readonly inSampleTo: string;
  readonly outOfSampleFrom: string;
  readonly outOfSampleTo: string;
}

export interface BacktestRunInput {
  readonly strategyId: string;
  readonly symbol: string;
  readonly walkForward?: Partial<WalkForwardWindow> | null;
  readonly outOfSampleStatus?: OutOfSampleStatus | null;
  readonly costModel?: BacktestCostModel | null;
  readonly strategyVariantCount?: number;
  readonly environment?: string | null;
  readonly presentedAs?: string | null;
  /** Head or an older immutable version. Blank is refused, never assumed to be 1. */
  readonly strategyVersion?: number | null;
  /** Strategy cash. Blank leaves the equity curve null — 10000 is not assumed. */
  readonly cash?: string | null;
}

export interface FillWindowMetrics {
  readonly fillCount: number;
  readonly notional: string;
}

export type BacktestRunResult = SimulatedPerformanceStamp & {
  readonly ok: true;
  readonly runId: string;
  readonly strategyId: string;
  readonly walkForward: WalkForwardWindow;
  readonly inSample: FillWindowMetrics;
  readonly outOfSample: FillWindowMetrics;
  readonly claimLabel: 'Historical simulation — not a forecast';
  readonly outOfSampleLabel: string;
  readonly strategyVersion: number;
};

const recorded = new WeakMap<object, RunResultBody>();

/** Body computed for this result or refusal. Null when the run stopped before fills. */
export function backtestBodyOf(key: object): RunResultBody | null {
  return recorded.get(key) ?? null;
}

function requireStrategyVersion(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new QuantError(QUANT_STRATEGY_VERSION_UNSET, 'strategyVersion is unset — version 1 is not assumed');
  }
  return value;
}

function completeWalkForward(raw: Partial<WalkForwardWindow> | null | undefined): WalkForwardWindow | null {
  if (!raw) return null;
  const inSampleFrom = raw.inSampleFrom?.trim() ?? '';
  const inSampleTo = raw.inSampleTo?.trim() ?? '';
  const outOfSampleFrom = raw.outOfSampleFrom?.trim() ?? '';
  const outOfSampleTo = raw.outOfSampleTo?.trim() ?? '';
  if (!inSampleFrom || !inSampleTo || !outOfSampleFrom || !outOfSampleTo) return null;
  return { inSampleFrom, inSampleTo, outOfSampleFrom, outOfSampleTo };
}

// Date.parse reads a zone-less date-time as local time. Require Z or a numeric offset.
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/i;

function epoch(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !EXPLICIT_OFFSET.test(trimmed)) return null;
  const n = Date.parse(trimmed);
  return Number.isFinite(n) ? n : null;
}

function assertWalkForward(window: WalkForwardWindow): void {
  const isFrom = epoch(window.inSampleFrom);
  const isTo = epoch(window.inSampleTo);
  const oosFrom = epoch(window.outOfSampleFrom);
  const oosTo = epoch(window.outOfSampleTo);
  if (isFrom === null || isTo === null || oosFrom === null || oosTo === null || isFrom >= isTo || oosFrom >= oosTo || isTo > oosFrom) {
    throw new QuantError(QUANT_BACKTEST_WALK_FORWARD_REQUIRED, 'walk-forward needs ordered in-sample then out-of-sample ISO windows');
  }
}

function fillEpoch(ts: string): number {
  const t = epoch(ts);
  if (t === null) {
    throw new QuantError('quant.params_invalid', 'a fill timestamp is refused — candles are not invented');
  }
  return t;
}

function inRange(ts: string, from: string, to: string): boolean {
  const t = fillEpoch(ts);
  const a = epoch(from);
  const b = epoch(to);
  if (a === null || b === null) return false;
  return t >= a && t < b;
}

function metricsFromFills(fills: readonly LakeFill[]): FillWindowMetrics {
  let notional = 0n;
  let fillCount = 0;
  for (const fill of fills) {
    let qty = 0n;
    let price = 0n;
    try {
      qty = parseAmount(fill.qty);
      price = parseAmount(fill.price);
    } catch {
      throw new QuantError('quant.params_invalid', 'fill qty and price must be decimal strings — candles are not invented');
    }
    // parseAmount allows a leading minus. A negative leg must not count.
    if (qty < 0n || price < 0n) {
      throw new QuantError('quant.params_invalid', 'a negative fill qty or price is refused — candles are not invented');
    }
    notional = add(notional, mul(qty, price, 'half-up'));
    fillCount += 1;
  }
  return { fillCount, notional: formatAmount(notional) };
}

export function runBacktest(input: BacktestRunInput, lake: BacktestLake): BacktestRunResult {
  const stamp = requireSimulatedStamp(input.environment, input.presentedAs, ['backtest']);
  const walkForward = completeWalkForward(input.walkForward);
  if (!walkForward) {
    throw new QuantError(QUANT_BACKTEST_WALK_FORWARD_REQUIRED, 'backtest.run requires walk-forward in-sample and out-of-sample windows');
  }
  assertWalkForward(walkForward);

  if (!lake.wired) {
    throw new QuantError(QUANT_BACKTEST_LAKE_MISSING, 'connect data lake is not wired — fills are absent, candles are not invented');
  }

  const loaded = lake.fills({
    symbol: input.symbol,
    from: walkForward.inSampleFrom,
    to: walkForward.outOfSampleTo,
  });
  if (loaded === null) {
    throw new QuantError(QUANT_BACKTEST_LAKE_MISSING, 'connect data lake returned absent — fills are missing, candles are not invented');
  }
  if (loaded.length === 0) {
    throw new QuantError(
      QUANT_BACKTEST_FILLS_MISSING,
      'connect data lake has no fills in the walk-forward window — candles are not invented',
    );
  }

  const inSampleFills = loaded.filter((f) => inRange(f.ts, walkForward.inSampleFrom, walkForward.inSampleTo));
  const outOfSampleFills = loaded.filter((f) => inRange(f.ts, walkForward.outOfSampleFrom, walkForward.outOfSampleTo));
  const inSample = metricsFromFills(inSampleFills);
  const outOfSample = metricsFromFills(outOfSampleFills);

  const strategyVersion = requireStrategyVersion(input.strategyVersion);
  const traded = [...inSampleFills, ...outOfSampleFills];
  const body = buildBacktestBody({
    cash: input.cash,
    fills: traded,
    costModel: input.costModel,
    stamp,
  });

  const outOfSampleVerdict: OutOfSampleVerdict | null = input.outOfSampleStatus
    ? {
        status: input.outOfSampleStatus,
        evaluatedFrom: walkForward.outOfSampleFrom,
        evaluatedTo: walkForward.outOfSampleTo,
        sampleCount: outOfSample.fillCount,
      }
    : null;

  const assessment = assessBacktestSurface({
    runId: `bt_${input.strategyId}_v${strategyVersion}`,
    strategyId: input.strategyId,
    strategyVariantCount: input.strategyVariantCount,
    outOfSampleVerdict,
    costModel: input.costModel,
  });
  if (!assessment.ok) {
    const refused = new QuantError(QUANT_BACKTEST_SURFACE_REFUSED, `${assessment.refusal.code} — ${assessment.refusal.detail}`);
    recorded.set(refused, body);
    throw refused;
  }

  const result: BacktestRunResult = {
    ok: true,
    ...stamp,
    runId: assessment.surface.runId,
    strategyId: assessment.surface.strategyId,
    walkForward,
    inSample,
    outOfSample,
    claimLabel: assessment.surface.claimLabel,
    outOfSampleLabel: assessment.surface.outOfSample.label,
    strategyVersion,
  };
  recorded.set(result, body);
  return result;
}

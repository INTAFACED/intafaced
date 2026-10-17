import { formatAmount, mul, parseAmount, sub } from '@intafaced/ledger-client/money';
import type { BacktestCostModel } from '@intafaced/quant-honesty';
import type { SimulatedPerformanceStamp } from '@intafaced/quant-honesty';
import type { LakeFill } from '../backtest/lake.js';
import type { CostBreakdown, CostEvidence, EquityPoint, RunResultBody, RunTrade } from './types.js';

/**
 * Equity is the strategy's paper cash minus each lake fill's notional, in order.
 * Lake fills have no side. The notional is the same product the fill metrics use.
 * A missing cost model is null. A missing component inside a model is null.
 * Neither is stored as zero.
 */
export function buildBacktestBody(input: {
  readonly cash: string | null | undefined;
  readonly fills: readonly LakeFill[];
  readonly costModel?: BacktestCostModel | null;
  readonly stamp: SimulatedPerformanceStamp;
}): RunResultBody {
  const trades: RunTrade[] = input.fills.map((fill) => ({
    ts: fill.ts,
    symbol: fill.symbol,
    qty: formatAmount(parseAmount(fill.qty)),
    price: formatAmount(parseAmount(fill.price)),
  }));

  const cash = input.cash?.trim() ?? '';
  let equityCurve: EquityPoint[] | null = null;
  let pnl: string | null = null;
  if (cash) {
    const start = parseAmount(cash);
    let equity = start;
    equityCurve = [];
    for (const fill of input.fills) {
      const notional = mul(parseAmount(fill.qty), parseAmount(fill.price), 'half-up');
      equity = sub(equity, notional);
      equityCurve.push({ ts: fill.ts, equity: formatAmount(equity) });
    }
    pnl = formatAmount(sub(equity, start));
  }

  return {
    equityCurve,
    trades,
    costs: costsOf(input.costModel),
    pnl,
    simulated: true,
    live: false,
    environment: input.stamp.environment,
    kind: input.stamp.kind,
    claimLabel: input.stamp.claimLabel,
  };
}

function evidence(value: { readonly kind: string; readonly source: string } | null | undefined): CostEvidence | null {
  if (value == null) return null;
  return { kind: value.kind, source: value.source };
}

export function costsOf(model: BacktestCostModel | null | undefined): CostBreakdown | null {
  if (model == null) return null;
  return {
    fees: evidence(model.fees),
    slippage: evidence(model.slippage),
    latency: evidence(model.latency),
  };
}

import type { QuantBacktestMetrics, QuantBacktestResult, QuantMetric, QuantRoundTrip } from '@intafaced/contracts';
import { add, div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';

/** The reasons a statistic is not defined (ENGINE MT-4). The screen shows each one in words. */
export const METRIC_NO_TRADES = 'no_trades';
export const METRIC_NO_WINS = 'no_winning_trades';
export const METRIC_NO_LOSSES = 'no_losing_trades';
export const METRIC_TOO_FEW_POINTS = 'too_few_equity_points';
export const METRIC_ZERO_BASE = 'zero_base';
export const METRIC_RISK_FREE_UNSET = 'quant.risk_free_unset';

const UNIT = parseAmount('1');
const PERCENT_CUT = 10n ** 14n;

/** Rounding toward zero, so an average loss never reads deeper than it is. */
const towardZero = (value: Amount) => (value < 0n ? 'ceil' : 'floor');

const defined = (value: Amount): QuantMetric => ({ value: formatAmount(value), reason: null });
const undefinedBy = (reason: string): QuantMetric => ({ value: null, reason });

/** `part` as a percent of `base`, four places cut toward zero, so a figure never reads better than it is. */
export function percent(part: Amount, base: Amount): QuantMetric {
  if (base === 0n) return undefinedBy(METRIC_ZERO_BASE);
  // One bigint division truncates toward zero, then the cut to four places does too: a loss never reads deeper.
  const exact = (part * 100n * UNIT) / base;
  return defined((exact / PERCENT_CUT) * PERCENT_CUT);
}

/**
 * Pairs the run's sided fills into round trips, first in first out (ENGINE MT-5). The engine is long only and a sell
 * closes the whole position, so each buy is closed by the next sell. A position still open at the end is not a round
 * trip: its value is in the net result and the equity, not in the trade statistics.
 */
export function roundTripsOf(trades: QuantBacktestResult['trades']): QuantRoundTrip[] {
  const out: QuantRoundTrip[] = [];
  let open: QuantBacktestResult['trades'][number] | null = null;
  for (const trade of trades) {
    if (trade.side === 'buy') {
      open = trade;
      continue;
    }
    if (!open) continue;
    const qty = parseAmount(trade.qty);
    const cost = add(mul(parseAmount(open.qty), parseAmount(open.price), 'half-up'), parseAmount(open.fee));
    const proceeds = sub(mul(qty, parseAmount(trade.price), 'half-up'), parseAmount(trade.fee));
    out.push({
      side: 'long',
      entryTs: open.ts,
      exitTs: trade.ts,
      qty: trade.qty,
      entryPrice: open.price,
      exitPrice: trade.price,
      fees: formatAmount(add(parseAmount(open.fee), parseAmount(trade.fee))),
      profit: formatAmount(sub(proceeds, cost)),
      holdingMs: Date.parse(trade.ts) - Date.parse(open.ts),
    });
    open = null;
  }
  return out;
}

/**
 * Largest fall from a running peak, and the longest span in points from a peak to the next equal-or-higher point
 * (ENGINE MT-1, R-10). A peak the curve never gets back to counts to the last point.
 */
export function drawdownOf(points: readonly Amount[]): { fall: Amount; base: Amount; longest: number } {
  let peak = points[0]!;
  let fall = 0n;
  let base = peak;
  let longest = 0;
  let since = 0;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    if (point >= peak) {
      if (i - since > 1 && i - since > longest) longest = i - since;
      peak = point;
      since = i;
      continue;
    }
    if (sub(peak, point) > fall) {
      fall = sub(peak, point);
      base = peak;
    }
  }
  const last = points.length - 1;
  if (points[last]! < peak && last - since > longest) longest = last - since;
  return { fall, base, longest };
}

/** Largest rise from a running trough (run-up mirrors drawdown). */
function runUpOf(points: readonly Amount[]): { rise: Amount; base: Amount } {
  let trough = points[0]!;
  let rise = 0n;
  let base = trough;
  for (const point of points.slice(1)) {
    if (point <= trough) {
      trough = point;
      continue;
    }
    if (sub(point, trough) > rise) {
      rise = sub(point, trough);
      base = trough;
    }
  }
  return { rise, base };
}

function longestStreak(profits: readonly Amount[], win: boolean): number {
  let best = 0;
  let run = 0;
  for (const profit of profits) {
    run = (win ? profit > 0n : profit < 0n) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/**
 * The report of a run (AL-report-01, ENGINE section 7), from its own trades and equity points only. Deterministic, and
 * computed again on every read from what the run stored. A round trip that ends at exactly zero counts as neither a
 * win nor a loss.
 */
export function metricsOf(result: Pick<QuantBacktestResult, 'trades' | 'equity' | 'totals'>): QuantBacktestMetrics {
  const roundTrips = roundTripsOf(result.trades);
  const profits = roundTrips.map((trip) => parseAmount(trip.profit));
  const winners = profits.filter((profit) => profit > 0n);
  const losers = profits.filter((profit) => profit < 0n);
  const grossProfit = winners.reduce((sum, profit) => add(sum, profit), 0n);
  const grossLoss = losers.reduce((sum, profit) => add(sum, profit), 0n);
  const tradesNet = add(grossProfit, grossLoss);
  const count = BigInt(roundTrips.length);

  const startCash = parseAmount(result.totals.startCash);
  const net = parseAmount(result.totals.net);
  const points = result.equity.map((point) => parseAmount(point.equity));
  // The starting cash is the first point of the curve, before the first bar is marked.
  const curve = [startCash, ...points];
  const drawdown = curve.length < 2 ? null : drawdownOf(curve);
  const runUp = curve.length < 2 ? null : runUpOf(curve);
  const totalHolding = roundTrips.reduce((sum, trip) => sum + trip.holdingMs, 0);

  return {
    returns: {
      net: defined(net),
      netPercent: percent(net, startCash),
      grossProfit: roundTrips.length ? defined(grossProfit) : undefinedBy(METRIC_NO_TRADES),
      grossLoss: roundTrips.length ? defined(grossLoss) : undefinedBy(METRIC_NO_TRADES),
      profitFactor: !roundTrips.length
        ? undefinedBy(METRIC_NO_TRADES)
        : grossLoss === 0n
          ? undefinedBy(METRIC_NO_LOSSES)
          : defined(div(grossProfit, -grossLoss, 'floor')),
      expectedPayoff: roundTrips.length
        ? defined(div(tradesNet, parseAmount(String(count)), towardZero(tradesNet)))
        : undefinedBy(METRIC_NO_TRADES),
      sharpe: undefinedBy(METRIC_RISK_FREE_UNSET),
      sortino: undefinedBy(METRIC_RISK_FREE_UNSET),
    },
    risk: {
      maxDrawdown: drawdown ? defined(drawdown.fall) : undefinedBy(METRIC_TOO_FEW_POINTS),
      maxDrawdownPercent: drawdown ? percent(drawdown.fall, drawdown.base) : undefinedBy(METRIC_TOO_FEW_POINTS),
      longestDrawdownBars: drawdown ? defined(parseAmount(String(drawdown.longest))) : undefinedBy(METRIC_TOO_FEW_POINTS),
      maxRunUp: runUp ? defined(runUp.rise) : undefinedBy(METRIC_TOO_FEW_POINTS),
      maxRunUpPercent: runUp ? percent(runUp.rise, runUp.base) : undefinedBy(METRIC_TOO_FEW_POINTS),
    },
    trades: {
      roundTrips: roundTrips.length,
      wins: winners.length,
      losses: losers.length,
      winRate: roundTrips.length
        ? percent(parseAmount(String(winners.length)), parseAmount(String(roundTrips.length)))
        : undefinedBy(METRIC_NO_TRADES),
      averageWin: winners.length ? defined(div(grossProfit, parseAmount(String(winners.length)), 'floor')) : undefinedBy(METRIC_NO_WINS),
      averageLoss: losers.length ? defined(div(grossLoss, parseAmount(String(losers.length)), 'ceil')) : undefinedBy(METRIC_NO_LOSSES),
      largestWin: winners.length ? defined(winners.reduce((a, b) => (b > a ? b : a))) : undefinedBy(METRIC_NO_WINS),
      largestLoss: losers.length ? defined(losers.reduce((a, b) => (b < a ? b : a))) : undefinedBy(METRIC_NO_LOSSES),
      longestWinStreak: longestStreak(profits, true),
      longestLossStreak: longestStreak(profits, false),
      averageHoldingMs: roundTrips.length
        ? defined(parseAmount(String(Math.floor(totalHolding / roundTrips.length))))
        : undefinedBy(METRIC_NO_TRADES),
    },
    roundTrips,
  };
}

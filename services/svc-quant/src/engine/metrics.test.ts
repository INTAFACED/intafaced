import { describe, expect, it } from 'vitest';
import type { QuantBacktestResult } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { metricsOf } from './metrics.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();

function trade(hours: number, side: 'buy' | 'sell', price: string, fee: string): QuantBacktestResult['trades'][number] {
  return { ts: at(hours), side, reason: 'signal', qty: '1', barPrice: price, price, fee, slippage: '0' };
}

function run(trades: QuantBacktestResult['trades'], equity: readonly string[], net: string) {
  return {
    trades,
    equity: equity.map((value, i) => ({ ts: at(i), equity: value })),
    totals: { startCash: '1000', gross: net, fees: '0', slippage: '0', net, endEquity: '0', openQty: '0' },
  };
}

describe('backtest metrics (ENGINE T-9: hand-computed)', () => {
  it('computes returns, drawdown, run-up and trade statistics to the last decimal', () => {
    // Three round trips: +8 (110 - 1 fee - 100 - 1 fee), -7 (105 - 1 - 110 - 1), +3.
    const trades = [
      trade(0, 'buy', '100', '1'),
      trade(2, 'sell', '110', '1'),
      trade(3, 'buy', '110', '1'),
      trade(5, 'sell', '105', '1'),
      trade(6, 'buy', '100', '0'),
      trade(7, 'sell', '103', '0'),
    ];
    // No position is left open, so the net result is the round trips' sum: 8 - 7 + 3 = 4.
    const metrics = metricsOf(run(trades, ['1005', '1010', '1002', '995', '1000', '1004'], '4'));
    expect(metrics.roundTrips.map((trip) => trip.profit)).toEqual(['8', '-7', '3']);
    expect(metrics.roundTrips[0]).toMatchObject({ side: 'long', entryTs: at(0), exitTs: at(2), fees: '2', holdingMs: 2 * HOUR });
    expect(metrics.returns).toEqual({
      net: { value: '4', reason: null },
      netPercent: { value: '0.4', reason: null },
      grossProfit: { value: '11', reason: null },
      grossLoss: { value: '-7', reason: null },
      // 11 / 7, cut at 18 places.
      profitFactor: { value: '1.571428571428571428', reason: null },
      // (8 - 7 + 3) / 3
      expectedPayoff: { value: '1.333333333333333333', reason: null },
      sharpe: { value: null, reason: 'quant.risk_free_unset' },
      sortino: { value: null, reason: 'quant.risk_free_unset' },
    });
    // The curve starts at the cash: 1000, 1005, 1010, 1002, 995, 1000, 1004. The peak 1010 falls to 995 (15, 1.4851% of
    // 1010) and is never regained: 4 points from the peak to the end (R-10). The largest rise is 1000 to 1010 (10, 1%).
    expect(metrics.risk).toEqual({
      maxDrawdown: { value: '15', reason: null },
      maxDrawdownPercent: { value: '1.4851', reason: null },
      longestDrawdownBars: { value: '4', reason: null },
      maxRunUp: { value: '10', reason: null },
      maxRunUpPercent: { value: '1', reason: null },
    });
    expect(parseAmount(metrics.returns.grossProfit.value!) + parseAmount(metrics.returns.grossLoss.value!)).toBe(
      parseAmount(metrics.returns.net.value!),
    );
    expect(metrics.trades).toEqual({
      roundTrips: 3,
      wins: 2,
      losses: 1,
      winRate: { value: '66.6666', reason: null },
      averageWin: { value: '5.5', reason: null },
      averageLoss: { value: '-7', reason: null },
      largestWin: { value: '8', reason: null },
      largestLoss: { value: '-7', reason: null },
      longestWinStreak: 1,
      longestLossStreak: 1,
      averageHoldingMs: { value: String((5 * HOUR) / 3), reason: null },
    });
  });

  it('says "not defined" with a reason for an empty run, never zero', () => {
    const metrics = metricsOf(run([], ['1000', '1000'], '0'));
    expect(metrics.trades.winRate).toEqual({ value: null, reason: 'no_trades' });
    expect(metrics.returns.profitFactor).toEqual({ value: null, reason: 'no_trades' });
    expect(metrics.returns.expectedPayoff).toEqual({ value: null, reason: 'no_trades' });
    expect(metrics.trades.averageWin).toEqual({ value: null, reason: 'no_winning_trades' });
    expect(metrics.returns.sharpe).toEqual({ value: null, reason: 'quant.risk_free_unset' });
    // A flat curve has a defined drawdown of 0: the points exist, nothing fell.
    expect(metrics.risk.maxDrawdown).toEqual({ value: '0', reason: null });
    expect(metrics.returns.net).toEqual({ value: '0', reason: null });
  });

  it('leaves profit factor undefined when nothing lost, and counts streaks in order', () => {
    const trades = [
      trade(0, 'buy', '100', '0'),
      trade(1, 'sell', '101', '0'),
      trade(2, 'buy', '100', '0'),
      trade(3, 'sell', '102', '0'),
      trade(4, 'buy', '100', '0'),
    ];
    const metrics = metricsOf(run(trades, ['1001', '1003', '1003'], '3'));
    expect(metrics.returns.profitFactor).toEqual({ value: null, reason: 'no_losing_trades' });
    // The last buy is still open: it is not a round trip.
    expect(metrics.trades.roundTrips).toBe(2);
    expect(metrics.trades.longestWinStreak).toBe(2);
    expect(metrics.trades.averageLoss).toEqual({ value: null, reason: 'no_losing_trades' });
  });
});

describe('backtest metrics rounding and recovery', () => {
  it('cuts a negative percent and average toward zero, and counts a recovered drawdown from peak to recovery', () => {
    const trades = [
      trade(0, 'buy', '100', '0'),
      trade(1, 'sell', '99', '0'),
      trade(2, 'buy', '100', '0'),
      trade(3, 'sell', '99', '0'),
      trade(4, 'buy', '100', '0'),
      trade(5, 'sell', '99', '0'),
    ];
    const metrics = metricsOf({
      ...run(trades, ['999', '1001', '998', '999', '1002'], '-3'),
      totals: { startCash: '7', gross: '-3', fees: '0', slippage: '0', net: '-3', endEquity: '4', openQty: '0' },
    });
    // -3 / 7 = -42.857142…%: cut toward zero is -42.8571, never -42.8572.
    expect(metrics.returns.netPercent).toEqual({ value: '-42.8571', reason: null });
    // Three losses of 1 each: the average loss is exactly -1.
    expect(metrics.trades.averageLoss).toEqual({ value: '-1', reason: null });
    // Curve 1000, 999, 1001, 998, 999, 1002: the peak 1000 is regained at 1001 (2 points); 1001 is regained at 1002 (3).
    expect(metrics.risk.longestDrawdownBars).toEqual({ value: '3', reason: null });
  });

  it('reads an expected payoff of a small loss toward zero', () => {
    const trades = [
      trade(0, 'buy', '100', '0'),
      trade(1, 'sell', '99', '0'),
      trade(2, 'buy', '100', '0'),
      trade(3, 'sell', '100', '0'),
      trade(4, 'buy', '100', '0'),
      trade(5, 'sell', '100', '0'),
    ];
    expect(metricsOf(run(trades, ['999', '999'], '-1')).returns.expectedPayoff).toEqual({ value: '-0.333333333333333333', reason: null });
  });
});

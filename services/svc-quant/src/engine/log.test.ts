import { describe, expect, it } from 'vitest';
import { logOf } from './log.js';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 0, minute)).toISOString();

describe('backtest run log', () => {
  it('puts gaps, fills and unfilled orders in time order, and marks gaps and unfilled orders as warnings', () => {
    const log = logOf({
      runKey: 'algo:bt:x',
      strategyId: 'x',
      strategyVersion: 1,
      symbol: 'BTC/USDT',
      window: { from: at(0), to: at(10) },
      fillTiming: 'next_open',
      costs: { feeScheduleVersion: 'v1', feeRole: 'taker', feeBps: 10, slippageBps: '5', delayBars: 0 },
      coverage: { barSize: '1m', bars: 8, expected: 10, first: at(0), last: at(9), gaps: [{ from: at(4), to: at(6) }], fraction: '0.8' },
      trades: [
        { ts: at(2), side: 'buy', reason: 'signal', qty: '1', barPrice: '1', price: '1', fee: '0', slippage: '0' },
        { ts: at(7), side: 'sell', reason: 'stop_loss', qty: '1', barPrice: '1', price: '1', fee: '0', slippage: '0' },
      ],
      rejected: [{ ts: at(10), side: 'buy', reason: 'unfilled_at_window_end' }],
      equity: [],
      assumptions: ['long_only', 'stop_loss_first'],
      totals: { startCash: '1', gross: '0', fees: '0', slippage: '0', net: '0', endEquity: '1', openQty: '0' },
      simulated: true,
      live: false,
      claimLabel: 'Historical simulation — not a forecast',
    });
    expect(log.map((line) => [line.level, line.code])).toEqual([
      ['info', 'bars_read'],
      ['info', 'costs'],
      ['info', 'fill'],
      ['warn', 'gap'],
      ['info', 'fill'],
      ['warn', 'not_filled'],
      ['info', 'assumption'],
      ['warn', 'assumption'],
      ['info', 'finished'],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { add, formatAmount, mul, parseAmount, sub } from '@intafaced/ledger-client/money';
import type { QuantSignalRules } from '@intafaced/contracts';
import { simpleAverage, exponentialAverage } from './averages.js';
import { coverageOf, type Bar } from './bars.js';
import { simulateSignalRules, type SimulationInput } from './simulate.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');

/** One bar per close, an hour apart; open is the previous close, high and low bracket both. */
function barsOf(closes: readonly (string | null)[]): Bar[] {
  const out: Bar[] = [];
  let prev = closes.find((c) => c !== null) ?? '1';
  closes.forEach((close, i) => {
    if (close === null) return;
    const open = parseAmount(prev);
    const c = parseAmount(close);
    out.push({ openTimeMs: T0 + i * HOUR, open, high: open > c ? open : c, low: open < c ? open : c, close: c });
    prev = close;
  });
  return out;
}

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

function run(closes: readonly (string | null)[], patch: Partial<SimulationInput> = {}) {
  return simulateSignalRules({
    rules: RULES,
    bars: barsOf(closes),
    spanMs: HOUR,
    cash: parseAmount('1000'),
    feeBps: 10,
    slippageBps: parseAmount('0'),
    delayBars: 0,
    ...patch,
  });
}

describe('moving averages', () => {
  it('use only closes up to the bar, and stay null until full', () => {
    const closes = ['1', '2', '3', '4'].map(parseAmount);
    expect(simpleAverage(closes, 2).map((v) => (v === null ? null : formatAmount(v)))).toEqual([null, '1.5', '2.5', '3.5']);
    const ema = exponentialAverage(closes, 2).map((v) => (v === null ? null : formatAmount(v)));
    expect(ema[0]).toBeNull();
    expect(ema[1]).toBe('1.5');
    // weight 2/3: 1.5 + (3 - 1.5) * 2/3 = 2.5
    expect(Number(ema[2])).toBeCloseTo(2.5, 12);
  });
});

describe('bar loop', () => {
  it('buys on the cross up at the next open and sells on the cross down: equity rises then falls with sided trades', () => {
    const out = run(['100', '100', '100', '110', '120', '130', '115', '100']);
    expect(out.trades.map((t) => [t.side, t.ts, t.barPrice])).toEqual([
      ['buy', new Date(T0 + 4 * HOUR).toISOString(), '110'],
      ['sell', new Date(T0 + 7 * HOUR).toISOString(), '115'],
    ]);
    const equity = out.equity.map((p) => Number(p.equity));
    expect(equity[5]!).toBeGreaterThan(equity[4]!);
    expect(equity[6]!).toBeLessThan(equity[5]!);
    // Fees are the published rate on each fill's notional: 10 bps of 110 and of 115.
    expect(out.trades.map((t) => t.fee)).toEqual(['0.11', '0.115']);
    expect(out.totals.gross).toBe('5');
    expect(out.totals.fees).toBe('0.225');
    expect(out.totals.net).toBe('4.775');
    expect(out.totals.endEquity).toBe('1004.775');
    expect(out.assumptions).toEqual(['long_only', 'averages_over_traded_bars']);
  });

  it('never trades on a flat series: equity stays at the starting cash', () => {
    const out = run(['100', '100', '100', '100', '100']);
    expect(out.trades).toEqual([]);
    expect(new Set(out.equity.map((p) => p.equity))).toEqual(new Set(['1000']));
    expect(out.totals.net).toBe('0');
  });

  it('records a gap and fills nothing inside it: the order waits for the next bar that exists', () => {
    const closes = ['100', '100', '100', '110', null, null, '120', '125'];
    const out = run(closes);
    const coverage = coverageOf(barsOf(closes), '1h', T0, T0 + closes.length * HOUR);
    expect(coverage).toMatchObject({ bars: 6, expected: 8, fraction: '0.75' });
    expect(coverage.gaps).toEqual([{ from: new Date(T0 + 4 * HOUR).toISOString(), to: new Date(T0 + 6 * HOUR).toISOString() }]);
    const buy = out.trades[0]!;
    expect(buy.ts).toBe(new Date(T0 + 6 * HOUR).toISOString());
    for (const trade of out.trades) {
      const at = Date.parse(trade.ts);
      expect(at >= T0 + 4 * HOUR && at < T0 + 6 * HOUR).toBe(false);
    }
  });

  it('applies slippage against the order and keeps net = gross - fees - slippage', () => {
    const out = run(['100', '100', '100', '110', '120', '130', '115', '100'], { slippageBps: parseAmount('50') });
    expect(out.trades[0]!.price).toBe('110.55');
    expect(out.trades[1]!.price).toBe('114.425');
    const gross = parseAmount(out.totals.gross);
    const net = sub(sub(gross, parseAmount(out.totals.fees)), parseAmount(out.totals.slippage));
    expect(formatAmount(net)).toBe(out.totals.net);
  });

  it('fills at the open when a bar gaps through the stop (BT-5), and takes the stop first when a bar reaches both', () => {
    const rules = { ...RULES, exit: { stopLossPercent: '5', takeProfitPercent: '50' } };
    const bars = barsOf(['100', '100', '100', '110', '111']);
    // A bar that opens at 90, below the stop of 110 * 0.95 = 104.5.
    bars.push({
      openTimeMs: T0 + 5 * HOUR,
      open: parseAmount('90'),
      high: parseAmount('95'),
      low: parseAmount('88'),
      close: parseAmount('92'),
    });
    const out = run([], { rules, bars });
    const stop = out.trades.find((t) => t.reason === 'stop_loss')!;
    expect(stop.barPrice).toBe('90');
    const both = barsOf(['100', '100', '100', '110', '111']);
    both.push({
      openTimeMs: T0 + 5 * HOUR,
      open: parseAmount('111'),
      high: parseAmount('200'),
      low: parseAmount('100'),
      close: parseAmount('150'),
    });
    const pessimistic = run([], { rules, bars: both });
    expect(pessimistic.trades.find((t) => t.side === 'sell')!.reason).toBe('stop_loss');
    // The run says it took the stop first (BT-5), and that the position it still holds is marked at the last close.
    expect(pessimistic.assumptions).toContain('stop_loss_first');
    expect(out.assumptions).not.toContain('stop_loss_first');
  });

  it('never fills at the close the signal was read from, and counts the delay in intervals, not in bars that traded', () => {
    const closes = ['100', '100', '100', '110', '120', '130'];
    expect(run(closes).trades[0]).toMatchObject({ ts: new Date(T0 + 4 * HOUR).toISOString(), barPrice: '110' });
    expect(run(closes, { delayBars: 1 }).trades[0]).toMatchObject({ ts: new Date(T0 + 5 * HOUR).toISOString(), barPrice: '120' });
    // The signal closes at 03:00-04:00; with a delay of 1 the order is due at 05:00. The 04:00 interval did not trade,
    // and the 05:00 bar is the one it fills on: the gap counts as the hour it lasted.
    const gapped = ['100', '100', '100', '110', null, '120', '130', '140'];
    expect(run(gapped, { delayBars: 1 }).trades[0]).toMatchObject({ ts: new Date(T0 + 5 * HOUR).toISOString(), barPrice: '110' });
  });

  it('lists an order with no size and an order due after the last bar instead of dropping them', () => {
    const none = run(['100', '100', '100', '110', '120'], { rules: { ...RULES, sizing: { kind: 'quantity', value: '0' } } });
    expect(none.trades).toEqual([]);
    expect(none.rejected).toEqual([{ ts: new Date(T0 + 4 * HOUR).toISOString(), side: 'buy', reason: 'no_size' }]);
    const late = run(['100', '100', '100', '110']);
    expect(late.trades).toEqual([]);
    expect(late.rejected).toEqual([{ ts: new Date(T0 + 4 * HOUR).toISOString(), side: 'buy', reason: 'unfilled_at_window_end' }]);
  });

  it('says when a position is still held at the end and is valued at the last close', () => {
    const out = run(['100', '100', '100', '110', '120', '130']);
    expect(out.totals.openQty).toBe('1');
    expect(out.assumptions).toContain('open_position_marked_at_last_close');
  });

  it('rejects a buy the simulated cash cannot pay for, and records it', () => {
    const out = run(['100', '100', '100', '110', '120'], { cash: parseAmount('50') });
    expect(out.trades).toEqual([]);
    expect(out.rejected).toEqual([{ ts: new Date(T0 + 4 * HOUR).toISOString(), side: 'buy', reason: 'insufficient_cash' }]);
  });

  it('sizes a cash amount so the order and its fee stay inside it', () => {
    const rules = { ...RULES, sizing: { kind: 'cash' as const, value: '500' } };
    const out = run(['100', '100', '100', '110', '120'], { rules });
    const buy = out.trades[0]!;
    const spent = add(mul(parseAmount(buy.qty), parseAmount(buy.price), 'half-up'), parseAmount(buy.fee));
    expect(spent <= parseAmount('500')).toBe(true);
    expect(spent > parseAmount('499.99')).toBe(true);
  });

  it('gives the same result for the same inputs', () => {
    const closes = ['100', '101', '99', '104', '98', '107', '95', '110'];
    expect(JSON.stringify(run(closes, { slippageBps: parseAmount('3.5') }))).toBe(
      JSON.stringify(run(closes, { slippageBps: parseAmount('3.5') })),
    );
  });
});

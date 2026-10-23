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

  it('alternates buy and sell, starting with a buy: the shape the round-trip pairing in metrics.ts relies on', () => {
    // roundTripsOf pairs each sell with the one buy before it. If the engine ever adds to a position (pyramiding) or
    // sells part of one, this fails first, before the metrics quietly mis-pair.
    const closes = ['100', '101', '99', '104', '98', '107', '95', '110', '90', '120', '85', '130'];
    const sides = run(closes).trades.map((t) => t.side);
    expect(sides.length).toBeGreaterThan(3);
    sides.forEach((side, i) => expect(side).toBe(i % 2 === 0 ? 'buy' : 'sell'));
    const sized = run(closes, { rules: { ...RULES, sizing: { kind: 'cash', value: '500' } } }).trades;
    for (let i = 1; i < sized.length; i += 2) expect(sized[i]!.qty).toBe(sized[i - 1]!.qty);
  });

  it('gives the same result for the same inputs', () => {
    const closes = ['100', '101', '99', '104', '98', '107', '95', '110'];
    expect(JSON.stringify(run(closes, { slippageBps: parseAmount('3.5') }))).toBe(
      JSON.stringify(run(closes, { slippageBps: parseAmount('3.5') })),
    );
  });

  // The look-ahead canary the checks panel cites (checks.ts): no bar can change what happened before it opened.
  it('cannot read a bar before it closes: every prefix of the tape gives the same trades and equity up to its end', () => {
    const closes = ['100', '101', '99', '104', '98', '107', '95', '110', '90', '120'];
    const full = run(closes);
    for (let k = 2; k <= closes.length; k += 1) {
      const prefix = run(closes.slice(0, k));
      const end = T0 + (k - 1) * HOUR;
      expect(prefix.equity).toEqual(full.equity.slice(0, k));
      expect(prefix.trades).toEqual(full.trades.filter((trade) => Date.parse(trade.ts) <= end));
    }
    // A wild last bar moves nothing that came before it.
    const wild = run([...closes.slice(0, -1), '100000']);
    expect(wild.equity.slice(0, -1)).toEqual(full.equity.slice(0, -1));
    expect(wild.trades.filter((trade) => Date.parse(trade.ts) < T0 + 9 * HOUR)).toEqual(
      full.trades.filter((trade) => Date.parse(trade.ts) < T0 + 9 * HOUR),
    );
  });
});

describe('margin account (AL-backtest-02, ENGINE RK-5)', () => {
  const ACCOUNT = { leverage: parseAmount('10'), marginCallPercent: parseAmount('80'), stopOutPercent: parseAmount('50') };

  it('buys more than the cash holds with leverage; a cash account refuses the same order', () => {
    const closes = ['100', '100', '101', '102'];
    expect(run(closes, { cash: parseAmount('20') }).rejected.map((r) => r.reason)).toEqual(['insufficient_cash']);
    const margin = run(closes, { cash: parseAmount('20'), account: ACCOUNT });
    expect(margin.trades.map((t) => [t.side, t.price])).toEqual([['buy', '101']]);
    // Margin used 10.1 (101 over 10); equity at 102 is 20 - 101 - 0.101 fee + 102 = 20.899, a level of 206.9207 %.
    expect(margin.equity.at(-1)).toEqual({ ts: new Date(T0 + 3 * HOUR).toISOString(), equity: '20.899', marginLevelPercent: '206.9207' });
    expect(margin.equity[0]!.marginLevelPercent).toBeNull();
  });

  it('records the margin call, then the stop-out that closes the whole position at the price that reached its level', () => {
    // Entry at 101; one bar falls to 85 and passes the margin call (80 %) at 89.181, then the stop-out (50 %) at 86.151.
    const out = run(['100', '100', '101', '85', '90'], { cash: parseAmount('20'), account: ACCOUNT });
    expect(out.marginEvents).toEqual([
      { ts: new Date(T0 + 3 * HOUR).toISOString(), kind: 'margin_call', price: '89.181', marginLevelPercent: '80' },
      { ts: new Date(T0 + 3 * HOUR).toISOString(), kind: 'stop_out', price: '86.151', marginLevelPercent: '50' },
    ]);
    expect(out.trades.map((t) => [t.side, t.reason, t.price])).toEqual([
      ['buy', 'signal', '101'],
      ['sell', 'stop_out', '86.151'],
    ]);
    expect(out.totals.openQty).toBe('0');
    expect(out.assumptions).toContain('margin_level_at_bar_low');
  });

  it('fills a stop-out at the open when the bar gaps through its level', () => {
    const bar = (i: number, open: string, close: string): Bar => {
      const o = parseAmount(open);
      const c = parseAmount(close);
      return { openTimeMs: T0 + i * HOUR, open: o, high: o > c ? o : c, low: o < c ? o : c, close: c };
    };
    const bars = [bar(0, '100', '100'), bar(1, '100', '100'), bar(2, '100', '101'), bar(3, '101', '101'), bar(4, '70', '72')];
    const out = run([], { bars, cash: parseAmount('20'), account: ACCOUNT });
    expect(out.marginEvents.map((e) => [e.kind, e.price])).toEqual([
      ['margin_call', '70'],
      ['stop_out', '70'],
    ]);
    expect(out.trades.at(-1)).toMatchObject({ reason: 'stop_out', barPrice: '70' });
  });

  it('sizes a cash budget on margin so the margin and the fee fit inside it', () => {
    const sized = { ...RULES, sizing: { kind: 'cash' as const, value: '20' } };
    const out = run(['100', '100', '101', '102'], { rules: sized, cash: parseAmount('20'), account: ACCOUNT });
    const [buy] = out.trades;
    const qty = parseAmount(buy!.qty);
    const margin = (mul(qty, parseAmount('101'), 'half-up') + 9n) / 10n;
    expect(qty > parseAmount('1.9')).toBe(true);
    expect(margin + parseAmount(buy!.fee) <= parseAmount('20')).toBe(true);
  });

  it('leaves a cash run exactly as before: no margin level on its equity and no events', () => {
    const out = run(['100', '100', '101', '85', '90']);
    expect(out.marginEvents).toEqual([]);
    expect(out.equity.every((point) => !('marginLevelPercent' in point))).toBe(true);
  });
});

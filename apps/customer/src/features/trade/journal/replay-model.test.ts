import { describe, expect, it } from 'vitest';
import { tradeReplaySchema, type TradeReplay } from '@intafaced/contracts/trade-journal-procedures';
import { marksShown, replayPlan, stopLine, stopOn } from './replay-model';

const min = (hhmm: string) => Date.parse(`2026-11-20T${hhmm}:00.000Z`);
const bar = (hhmm: string) => ({
  openAt: `2026-11-20T${hhmm}:00.000Z`,
  openPrice: '100',
  highPrice: '101',
  lowPrice: '99',
  closePrice: '100',
  baseVolume: '1',
});

/*
 * A long opened 10:02:10 @ 100, its stop 95 placed 10:02:20 and moved to 90 at 10:03:30, closed 10:04:40 @ 102. Bars
 * 09:52 to 10:06: the entry bar 10:02 is index 10; the replay starts at index 0.
 */
const replay: TradeReplay = tradeReplaySchema.parse({
  venue: { id: 'hl-test', name: 'TEST venue', test: true },
  trade: {
    tradeId: 'x1',
    symbol: 'XRPY-PERP',
    side: 'long',
    openedAt: '2026-11-20T10:02:10.000Z',
    closedAt: '2026-11-20T10:04:40.000Z',
    entryPrice: '100',
    exitPrice: '102',
    size: '1',
    fees: '0.08',
    feeAsset: 'USDC',
    grossPnl: '2',
    netPnl: '1.92',
    plannedStop: '95',
    plannedTarget: null,
    rMultiple: '0.384',
    maePrice: '99',
    mae: '1',
    mfePrice: '102',
    mfe: '2',
    candleInterval: '1m',
    disciplined: { exit: 'unresolved', exitPrice: null, netPnl: null },
    rules: { verdict: 'kept', netPnl: '1.92', oneR: '5', widenedStop: null, dailyLoss: null },
    fillIds: ['x1', 'x2'],
  },
  tickSize: '0.01',
  stops: [
    { price: '95', placedAt: '2026-11-20T10:02:20.000Z' },
    { price: '90', placedAt: '2026-11-20T10:03:30.000Z' },
  ],
  interval: '1m',
  bars: {
    source: 'venue',
    asOf: '2026-11-20T10:07:00.000Z',
    candles: [
      '09:52',
      '09:53',
      '09:54',
      '09:55',
      '09:56',
      '09:57',
      '09:58',
      '09:59',
      '10:00',
      '10:01',
      '10:02',
      '10:03',
      '10:04',
      '10:05',
      '10:06',
    ].map(bar),
    entryIndex: 10,
    startIndex: 0,
  },
});

describe('replayPlan', () => {
  const plan = replayPlan(replay)!;
  it('puts each mark on the bar its moment falls in', () => {
    expect(plan.marks).toEqual([
      { kind: 'entry', price: '100', bar: min('10:02') },
      { kind: 'stop', price: '95', bar: min('10:02') },
      { kind: 'stop-moved', price: '90', bar: min('10:03') },
      { kind: 'exit', price: '102', bar: min('10:04') },
    ]);
    expect([plan.start, plan.entryIndex, plan.bars.length]).toEqual([0, 10, 15]);
  });
  it('shows no mark from later than the bar the replay has reached', () => {
    expect(marksShown(plan, min('10:01'))).toEqual([]);
    expect(marksShown(plan, min('10:02')).map((m) => m.kind)).toEqual(['entry', 'stop']);
    expect(marksShown(plan, min('10:03')).map((m) => m.kind)).toEqual(['entry', 'stop', 'stop-moved']);
    expect(marksShown(plan, min('10:06')).map((m) => m.kind)).toEqual(['entry', 'stop', 'stop-moved', 'exit']);
  });
  it('draws the stop line from the entry bar to the exit bar, stepping on the bar it was moved', () => {
    expect([stopOn(plan, min('10:01')), stopOn(plan, min('10:02')), stopOn(plan, min('10:03')), stopOn(plan, min('10:04'))]).toEqual([
      null,
      '95',
      '90',
      '90',
    ]);
    expect(stopOn(plan, min('10:05'))).toBeNull();
    expect(stopLine(plan, plan.bars.slice(0, 12))).toEqual([
      { time: min('10:02'), value: '95' },
      { time: min('10:03'), value: '90' },
    ]);
  });
  it('a stop placed with the entry order, before its fill, stands from the entry bar', () => {
    const early: TradeReplay = { ...replay, stops: [{ price: '95', placedAt: '2026-11-20T10:01:59.000Z' }] };
    expect(replayPlan(early)!.marks[1]).toEqual({ kind: 'stop', price: '95', bar: min('10:02') });
  });
  it('has no plan when the venue no longer returns the bars', () => {
    expect(replayPlan({ ...replay, bars: { source: 'none' } })).toBeNull();
  });
});

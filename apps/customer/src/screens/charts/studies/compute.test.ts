// The study layer's honesty rules, with fixed bars. Expected values are worked by hand; see math.test.ts for the formulas.
import { describe, expect, it } from 'vitest';
import type { Candle, Loadable } from '../../../data/types';
import type { ChartInterval } from '../../trade/chart/candles';
import { defaultInputs, type StudyInstance } from './model';
import { STUDIES, type StudyKind } from './catalogue';
import { computeStudy, type StudyContext, type StudyResult } from './compute';
import type { Print } from './math';

const MIN = 60_000;
const bar = (t: number, h: string, l: string, c: string, v = '1', o = c, filled = false): Candle => ({ t, o, h, l, c, v, filled });
const ready = <T>(data: T): Loadable<T> => ({ status: 'ready', data, asOf: 0 });

function study(kind: StudyKind, inputs: Record<string, string> = {}): StudyInstance {
  return { id: `${kind}-1`, kind, inputs: { ...defaultInputs(kind), ...inputs }, color: 'ma-1', hiddenOn: [] };
}

function context(bars: Candle[], over: Partial<StudyContext> = {}): StudyContext {
  return {
    symbol: 'BTC-USDT',
    interval: '1m' as ChartInterval,
    bars,
    tickSize: '0.01',
    lotSize: '0.001',
    higher: {},
    tape: undefined,
    ...over,
  };
}

const run = (s: StudyInstance, ctx: StudyContext): StudyResult => computeStudy(s, ctx);
const seriesNamed = (result: StudyResult, name: string) => {
  if (result.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(result)}`);
  const found = result.series.find((s) => s.name === name);
  if (!found) throw new Error(`no series ${name}`);
  return found;
};

describe('blank inputs refuse and never take a default', () => {
  it('a blank period is refused with "enter a period" and no line is drawn', () => {
    expect(run(study('sma', { period: '' }), context([bar(0, '1', '1', '1')]))).toEqual({
      status: 'refused',
      reason: 'enterPeriod',
      params: {},
    });
  });

  it('a stochastic with a blank %K period refuses the same way', () => {
    expect(run(study('stochastic', { k: '' }), context([bar(0, '1', '1', '1')]))).toMatchObject({ reason: 'enterPeriod' });
  });

  it('a blank rating weight gives a rating with its counts but no score', () => {
    const bars = Array.from({ length: 210 }, (_, i) => bar(i * MIN, '5', '5', '5'));
    const result = run(study('rating'), context(bars));
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.notes).toEqual([{ label: 'Rating', reason: 'weightsBlank', params: {} }]);
    expect(result.facts.find((f) => f.name === 'Neutral')?.text).toBe('7');
    expect(result.facts.find((f) => f.name === 'Score')).toBeUndefined();
  });

  it('the rating shows a score once every weight is set', () => {
    const bars = Array.from({ length: 210 }, (_, i) => bar(i * MIN, '5', '5', '5'));
    const weights = Object.fromEntries(
      ['sma20', 'sma50', 'sma200', 'ema20', 'ema50', 'ema200', 'rsi14', 'stoch14', 'macd'].map((id) => [`w.${id}`, '1']),
    );
    const result = run(study('rating', weights), context(bars));
    if (result.status !== 'ready') throw new Error('expected a rating');
    expect(result.facts.find((f) => f.name === 'Score')?.text).toBe('0.00');
    expect(result.notes).toEqual([]);
  });
});

describe('moving averages read the source the person chose', () => {
  it('SMA 50 on highs equals the mean of the last 50 highs, shown to the tick', () => {
    // Highs are 1, 2, ... 200. SMA 50 at bar 49 is (1 + ... + 50) / 50 = 25.5; at bar 199 it is (151 + ... + 200) / 50 = 175.5.
    const bars = Array.from({ length: 200 }, (_, i) => bar(i * MIN, String(i + 1), '0.5', String(i + 1)));
    const s = seriesNamed(run(study('sma', { period: '50', source: 'high' }), context(bars)), 'SMA 50 high');
    expect(s.points[49]).toMatchObject({ value: 25.5, text: '25.50' });
    expect(s.points[199]).toMatchObject({ value: 175.5, text: '175.50' });
    expect(s.points[48]).toMatchObject({ value: null, text: null });
    expect(s.color).toBe('ma-1');
  });

  it('a period larger than the loaded bars says how many bars it needs and draws nothing', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i * MIN, '1', '1', '1'));
    expect(run(study('sma', { period: '50' }), context(bars))).toEqual({ status: 'refused', reason: 'needsBars', params: { count: '50' } });
  });
});

describe('Ichimoku with 40 bars', () => {
  it('draws the lines that fit and names the 52 bars the leading span B needs; no cloud is invented', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i * MIN, String(100 + i + 1), String(100 + i - 1), String(100 + i)));
    const result = run(study('ichimoku'), context(bars));
    if (result.status !== 'ready') throw new Error('expected a ready Ichimoku');
    expect(result.series.map((s) => s.name)).toEqual(['Conversion', 'Base', 'Lagging', 'Leading A']);
    expect(result.notes).toEqual([{ label: 'Leading B', reason: 'needsBars', params: { count: '52' } }]);
  });
});

describe('volume and VWAP say so when a market has no volume', () => {
  it('a market with no volume refuses VWAP and volume', () => {
    const bars = Array.from({ length: 5 }, (_, i) => bar(i * MIN, '2', '1', '1.5', '0'));
    expect(run(study('vwap'), context(bars))).toMatchObject({ reason: 'noVolume' });
    expect(run(study('volume'), context(bars))).toMatchObject({ reason: 'noVolume' });
  });

  it('bars with no volume are gaps, counted, and never drawn as zero', () => {
    const bars = [bar(0, '2', '1', '1.5', '4', '1'), bar(MIN, '2', '1', '1.5', '0', '1'), bar(2 * MIN, '2', '1', '1.5', '3', '1')];
    const result = run(study('volume'), context(bars));
    const s = seriesNamed(result, 'Volume');
    expect(s.pane).toBe('sub');
    expect(s.points.map((p) => p.value)).toEqual([4, null, 3]);
    expect(s.points[0]?.tone).toBe('up');
    if (result.status === 'ready') expect(result.facts).toEqual([{ name: 'Bars with no volume', text: '1' }]);
  });
});

describe('RSI needs more bars than its period', () => {
  it('says it needs period + 1 bars', () => {
    expect(run(study('rsi'), context(Array.from({ length: 14 }, (_, i) => bar(i * MIN, '2', '1', String(1 + (i % 2))))))).toEqual({
      status: 'refused',
      reason: 'needsBars',
      params: { count: '15' },
    });
  });
});

describe('the tape: volume delta and the profile', () => {
  const bars = [bar(0, '2', '1', '1.5'), bar(MIN, '2', '1', '1.5'), bar(2 * MIN, '2', '1', '1.5')];
  const prints: Print[] = [
    { t: 0, side: 'buy', amount: '2', price: '1.5' },
    { t: 30_000, side: 'sell', amount: '1', price: '1.55' },
    { t: MIN, side: 'buy', amount: '5', price: '1.7' },
  ];

  it('while the trades load the study shows loading, not a value', () => {
    expect(run(study('volume-delta'), context(bars))).toEqual({ status: 'loading' });
  });

  it('with no trades for the market it says so', () => {
    expect(run(study('volume-delta'), context(bars, { tape: ready([]) }))).toMatchObject({ reason: 'noTape' });
  });

  it('delta is buy minus sell per bar and a bar with no prints is a gap', () => {
    const result = run(study('volume-delta'), context(bars, { tape: ready(prints) }));
    const delta = seriesNamed(result, 'Delta');
    expect(delta.points.map((p) => p.value)).toEqual([1, 5, null]);
    expect(delta.points.map((p) => p.tone)).toEqual(['up', 'up', null]);
    expect(seriesNamed(result, 'Cumulative delta').points.map((p) => p.value)).toEqual([1, 6, null]);
  });

  it('the profile lists bins with the point of control and says how far back the trades reach', () => {
    const result = run(study('volume-profile', { bins: '2' }), context(bars, { tape: ready(prints) }));
    if (result.status !== 'ready') throw new Error('expected a profile');
    expect(result.table?.map((r) => [r.buy, r.sell, r.poc])).toEqual([
      ['2.000', '1.000', false],
      ['5.000', '0.000', true],
    ]);
    expect(result.table?.[1]?.share).toBe(100);
    expect(result.notes).toEqual([{ label: 'Profile', reason: 'tapeDepth', params: { count: '3' } }]);
  });

  it('a tape that does not reach the loaded bars refuses instead of showing zeros', () => {
    const late = [bar(10 * MIN, '2', '1', '1.5'), bar(11 * MIN, '2', '1', '1.5')];
    expect(run(study('volume-delta'), context(late, { tape: ready([{ t: 0, side: 'buy', amount: '1', price: '1' }]) }))).toMatchObject({
      reason: 'tapeWindow',
    });
  });
});

describe('higher-timeframe and levels', () => {
  it('a higher-timeframe study on an interval that is not coarser than the chart refuses', () => {
    const s = study('htf-sma', { interval: '1m', period: '2' });
    expect(run(s, context([bar(0, '1', '1', '1')]))).toEqual({ status: 'refused', reason: 'htfNotCoarser', params: { interval: '1m' } });
  });

  it('a higher-timeframe study waits for its bars', () => {
    const s = study('htf-sma', { interval: '1h', period: '2' });
    expect(run(s, context([bar(0, '1', '1', '1')]))).toEqual({ status: 'loading' });
  });

  it('pivot points need a daily or finer interval', () => {
    const weekly = { ...context([bar(0, '1', '1', '1')]), interval: '1w' as ChartInterval };
    expect(run(study('pivots'), weekly)).toMatchObject({ reason: 'needsDaily' });
  });

  it('the derivative and on-chain series refuse by name', () => {
    expect(run(study('open-interest'), context([bar(0, '1', '1', '1')]))).toEqual({
      status: 'refused',
      reason: 'notServed',
      params: { series: 'Open interest', symbol: 'BTC-USDT' },
    });
    expect(run(study('funding'), context([bar(0, '1', '1', '1')]))).toMatchObject({
      reason: 'notServed',
      params: { series: 'Funding rate' },
    });
    expect(run(study('on-chain'), context([bar(0, '1', '1', '1')]))).toMatchObject({ reason: 'notServed' });
  });

  it('pivots on the day after a whole prior day use that day’s high, low and close', () => {
    const hour = 3_600_000;
    const bars = Array.from({ length: 48 }, (_, i) => bar(i * hour, String(101 + i), String(99 + i), String(100 + i)));
    const result = run(study('pivots'), { ...context(bars), interval: '1h' as ChartInterval });
    const p = seriesNamed(result, 'P');
    // Prior day (the first 24 hours): high 124, low 99, close 123. P = (124 + 99 + 123) / 3.
    expect(p.points[23]?.value).toBeNull();
    expect(p.points[24]?.value).toBeCloseTo(346 / 3, 2);
  });
});

describe('the catalogue and the registry agree', () => {
  it('every study kind computes without throwing on empty bars, and says no bars', () => {
    for (const def of STUDIES) {
      expect(run(study(def.kind), context([]))).toMatchObject({ status: 'refused' });
    }
  });

  it('an unknown tick size is refused before any value is shown', () => {
    expect(run(study('sma'), context([bar(0, '1', '1', '1')], { tickSize: null }))).toEqual({
      status: 'refused',
      reason: 'noTickSize',
      params: {},
    });
  });
});

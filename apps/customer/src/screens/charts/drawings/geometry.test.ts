import { describe, expect, it } from 'vitest';
import { diffAtTick, percentChange, priceFromNumber, ratioText, roundToTick, tickPlaces } from './decimal';
import {
  collinear,
  extensionPrices,
  formatSpan,
  FIB_LEVELS,
  gannSlopes,
  magnetSnap,
  measureFigures,
  positionFigures,
  retracementPrices,
} from './geometry';

// TEST values only: the figures are computed from these fixture points, never from market data.
const pt = (time: number, price: string) => ({ time, price });

describe('decimal helpers at the tick size', () => {
  it('rounds to the nearest tick, half away from zero, at the tick places', () => {
    expect(roundToTick('121.46', '0.01')).toBe('121.46');
    expect(roundToTick('121.46', '0.5')).toBe('121.5');
    expect(roundToTick('121.245', '0.01')).toBe('121.25');
    expect(roundToTick('-121.245', '0.01')).toBe('-121.25');
    expect(roundToTick('65000', '0.1')).toBe('65000.0');
  });

  it('refuses a blank, malformed or non-positive tick', () => {
    expect(tickPlaces('')).toBeNull();
    expect(tickPlaces('abc')).toBeNull();
    expect(tickPlaces('0')).toBeNull();
    expect(roundToTick('1', '')).toBeNull();
    expect(roundToTick('1', '-0.01')).toBeNull();
  });

  it('turns a canvas number into a tick-rounded decimal, and refuses a non-finite one', () => {
    expect(priceFromNumber(65000.126, '0.01')).toBe('65000.13');
    expect(priceFromNumber(Number.NaN, '0.01')).toBeNull();
  });

  it('computes differences, percentages and ratios exactly', () => {
    expect(diffAtTick('100', '104', '0.01')).toBe('4.00');
    expect(percentChange('100', '95')).toBe('-5.00');
    expect(ratioText('10', '5')).toBe('2.00');
    expect(ratioText('10', '0')).toBeNull();
  });
});

describe('Fibonacci retracement and extension', () => {
  it('draws a retracement from bar 50 to bar 80 at the figures of the two points', () => {
    // Fixture: the first point at 110.00, the second at 140.00. Level L is b + (a - b) * L.
    const levels = retracementPrices(pt(50, '110.00'), pt(80, '140.00'), FIB_LEVELS, '0.01');
    expect(levels).not.toBe('bad-price');
    const byLevel = Object.fromEntries((levels as Array<{ level: string; price: string }>).map((l) => [l.level, l.price]));
    expect(byLevel['0']).toBe('140.00');
    expect(byLevel['0.5']).toBe('125.00');
    expect(byLevel['0.618']).toBe('121.46');
    expect(byLevel['1']).toBe('110.00');
  });

  it('rounds each level to the tick, not to the cent', () => {
    const levels = retracementPrices(pt(50, '110.00'), pt(80, '140.00'), ['0.618'], '0.5') as Array<{ price: string }>;
    expect(levels[0]!.price).toBe('121.5');
  });

  it('refuses a blank or invalid level and a blank tick', () => {
    expect(retracementPrices(pt(1, '1'), pt(2, '2'), ['0.5', ''], '0.01')).toBe('bad-levels');
    expect(retracementPrices(pt(1, '1'), pt(2, '2'), [], '0.01')).toBe('bad-levels');
    expect(retracementPrices(pt(1, '1'), pt(2, '2'), ['0.5'], '')).toBe('bad-tick');
  });

  it('projects extension levels from the third point with the first leg', () => {
    // Rule: c + (b - a) * level. Here (b - a) = 10 and c = 105, so level 1.618 gives 121.18.
    const levels = extensionPrices(pt(1, '100'), pt(2, '110'), pt(3, '105'), ['1.618'], '0.01') as Array<{ price: string }>;
    expect(levels[0]!.price).toBe('121.18');
  });
});

describe('collinear points', () => {
  it('is exact for three points on one line, and false otherwise', () => {
    expect(collinear(pt(0, '100'), pt(10, '110'), pt(20, '120'))).toBe(true);
    expect(collinear(pt(0, '100'), pt(10, '110'), pt(20, '125'))).toBe(false);
  });
});

describe('position box', () => {
  it('gives the risk, the reward and the risk to reward ratio for a long', () => {
    const figures = positionFigures('long', pt(1, '100'), pt(2, '95'), pt(3, '110'), '0.01');
    expect(typeof figures).toBe('object');
    if (typeof figures === 'string') return;
    expect(figures.risk).toBe('5.00');
    expect(figures.reward).toBe('10.00');
    expect(figures.ratio).toBe('2.00');
    expect(figures.riskPct).toBe('5.00');
  });

  it('refuses a stop or target on the wrong side of the entry', () => {
    expect(positionFigures('long', pt(1, '100'), pt(2, '105'), pt(3, '110'), '0.01')).toBe('wrong-side');
    expect(positionFigures('short', pt(1, '100'), pt(2, '95'), pt(3, '90'), '0.01')).toBe('wrong-side');
  });

  it('gives a short its own figures when the stop is above and the target below', () => {
    const figures = positionFigures('short', pt(1, '100'), pt(2, '105'), pt(3, '90'), '0.01');
    expect(typeof figures === 'object' && figures.ratio).toBe('2.00');
  });
});

describe('measure and info figures', () => {
  it('counts bars, the price difference at the tick, and the time span', () => {
    const figures = measureFigures(pt(40, '100'), pt(90, '104'), '0.01', (time) => time);
    expect(figures).toEqual({ bars: 50, priceDiff: '4.00', pct: '4.00', span: '0d 00h 00m' });
  });

  it('formats a whole span in days, hours and minutes', () => {
    expect(formatSpan(26 * 3600 + 30 * 60)).toBe('1d 02h 30m');
  });
});

describe('Gann fan', () => {
  it('gives the ratio slopes from the base slope of the two points', () => {
    const slopes = gannSlopes(pt(0, '100'), pt(10, '110'), '0.01', (time) => time);
    expect(typeof slopes).toBe('object');
    const byRatio = Object.fromEntries((slopes as Array<{ ratio: string; slope: string }>).map((s) => [s.ratio, s.slope]));
    expect(byRatio['1']).toBe('1.00');
    expect(byRatio['2']).toBe('2.00');
    expect(byRatio['0.5']).toBe('0.50');
  });

  it('refuses two points on the same bar', () => {
    expect(gannSlopes(pt(5, '100'), pt(5, '110'), '0.01', (time) => time)).toBe('degenerate');
  });
});

describe('magnet', () => {
  // y falls as price rises: y = 100 - price.
  const yOf = (price: string) => 100 - Number(price);
  it('snaps to the nearest OHLC price within the sensitivity', () => {
    expect(magnetSnap(['100', '105', '95', '102'], 50, yOf, 50)).toBe('95');
  });
  it('does not snap when the nearest price is outside the sensitivity', () => {
    expect(magnetSnap(['100', '105', '95', '102'], 50, yOf, 8)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { onVenuePriceRule, venueBound } from './venue-price.js';

/** The venue's own check, restated: whole, or at most 5 significant figures and the tick's places. */
function venueTakes(price: string, tick: string): boolean {
  const [whole = '0', fraction = ''] = price.split('.');
  if (fraction === '') return true;
  const tickPlaces = (tick.split('.')[1] ?? '').length;
  const sig = (whole + fraction).replace(/^0+/, '').length;
  return fraction.length <= tickPlaces && sig <= 5;
}

describe('onVenuePriceRule', () => {
  it('BTC-PERP at about 62,424 plus a 50 bps cap: a buy rounds down, a sell up, to 5 significant figures', () => {
    expect(onVenuePriceRule('62744.16', '0.1', 'down')).toBe('62744');
    expect(onVenuePriceRule('62110.885', '0.1', 'up')).toBe('62111');
  });

  it('keeps a price already on the rule, and a whole number of any size', () => {
    expect(onVenuePriceRule('62744', '0.1', 'down')).toBe('62744');
    expect(onVenuePriceRule('1234.5', '0.1', 'up')).toBe('1234.5');
    expect(onVenuePriceRule('123456.7', '0.1', 'down')).toBe('123456');
    expect(onVenuePriceRule('123456.7', '0.1', 'up')).toBe('123457');
  });

  it('below one, leading zeros are not significant; the tick still bounds the places', () => {
    expect(onVenuePriceRule('0.00123456', '0.00000001', 'down')).toBe('0.0012345');
    expect(onVenuePriceRule('0.00123456', '0.00000001', 'up')).toBe('0.0012346');
    expect(onVenuePriceRule('0.123456', '0.0001', 'up')).toBe('0.1235');
    expect(onVenuePriceRule('3.456789', '0.01', 'down')).toBe('3.45');
  });

  it('a carry across a power of ten stays on the rule', () => {
    expect(onVenuePriceRule('9.999951', '0.000001', 'up')).toBe('10');
    expect(onVenuePriceRule('99999.5', '0.1', 'up')).toBe('100000');
  });

  it('never moves past the price it was given in the wrong direction, and the venue takes every answer', () => {
    const ticks = ['1', '0.1', '0.01', '0.001', '0.000001', '0.00000001'];
    for (let i = 0; i < 2000; i += 1) {
      const scale = 10 ** ((i % 12) - 5);
      const raw = ((i * 7919.123457) % 1000) * scale + scale / 3;
      const price = raw.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
      const tick = ticks[i % ticks.length]!;
      for (const toward of ['up', 'down'] as const) {
        const out = onVenuePriceRule(price, tick, toward);
        expect(venueTakes(out, tick), `${price} ${tick} ${toward} → ${out}`).toBe(true);
        const cmp = Number(out) - Number(price);
        if (toward === 'down') expect(cmp).toBeLessThanOrEqual(0);
        else expect(cmp).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('refuses what is not a decimal, or a tick that is not a power of ten', () => {
    expect(() => onVenuePriceRule('1e5', '0.1', 'up')).toThrow(RangeError);
    expect(() => onVenuePriceRule('100', '0.5', 'up')).toThrow(RangeError);
    expect(() => onVenuePriceRule('100', '10', 'up')).toThrow(RangeError);
  });
});

describe('venueBound', () => {
  it('rounds toward the market while that stays beyond the reference', () => {
    expect(venueBound('buy', { moved: '62744.16', reference: '62432', tick: '0.1' })).toBe('62744');
    expect(venueBound('sell', { moved: '62110.885', reference: '62423', tick: '0.1' })).toBe('62111');
  });

  it('a cap finer than one price step takes the nearest price beyond the reference, never the reference itself', () => {
    // Best ask 10, tick 0.01, a 1 bps cap: 10.001 rounds down to 10, which would leave no slippage limit at all.
    expect(venueBound('buy', { moved: '10.001', reference: '10', tick: '0.01' })).toBe('10.01');
    expect(venueBound('sell', { moved: '9.999', reference: '10', tick: '0.01' })).toBe('9.99');
    // Past 5 significant figures the same: 62432.4 on a 62432 ask is 62432 toward the market, so 62433.
    expect(venueBound('buy', { moved: '62432.4', reference: '62432', tick: '0.1' })).toBe('62433');
  });

  it('a zero cap stays at the reference', () => {
    expect(venueBound('buy', { moved: '10', reference: '10', tick: '0.01' })).toBe('10');
  });
});

import { describe, expect, it } from 'vitest';
import { bpsText, onTick, protectionCheck, samePrice, snapToTick, tickPlaces } from './chart-orders';

describe('snapToTick', () => {
  it('rounds a pointer price to the nearest tick, written with the tick places', () => {
    expect(snapToTick(65000.104, '0.01')).toBe('65000.10');
    expect(snapToTick(65000.105, '0.01')).toBe('65000.11');
    expect(snapToTick(65000, '0.01')).toBe('65000.00');
    expect(snapToTick(12.26, '0.5')).toBe('12.5');
    expect(snapToTick(1234.4, '1')).toBe('1234');
  });
  it('refuses a price that is not positive or a tick that is not set', () => {
    expect(snapToTick(0, '0.01')).toBeNull();
    expect(snapToTick(-5, '0.01')).toBeNull();
    expect(snapToTick(Number.NaN, '0.01')).toBeNull();
    expect(snapToTick(10, '')).toBeNull();
    expect(snapToTick(10, '0')).toBeNull();
    expect(snapToTick(0.004, '0.01')).toBeNull();
  });
  it('counts tick places', () => {
    expect(tickPlaces('0.01')).toBe(2);
    expect(tickPlaces('1')).toBe(0);
  });
});

describe('onTick', () => {
  it('accepts a positive multiple of the tick only', () => {
    expect(onTick('65000.10', '0.01')).toBe(true);
    expect(onTick('65000.105', '0.01')).toBe(false);
    expect(onTick('0', '0.01')).toBe(false);
    expect(onTick('abc', '0.01')).toBe(false);
  });
});

describe('protectionCheck', () => {
  it('refuses with unset when the owner has not set the distance', () => {
    expect(protectionCheck('60000', '60000', null)).toEqual({ kind: 'unset' });
  });
  it('has no reference without a last price', () => {
    expect(protectionCheck('60000', null, 500)).toEqual({ kind: 'no-reference' });
    expect(protectionCheck('60000', '0', 500)).toEqual({ kind: 'no-reference' });
  });
  it('is within at exactly the distance and beyond one tick past it, either side of the last price', () => {
    expect(protectionCheck('63000.00', '60000.00', 500)).toEqual({ kind: 'within', distance: '5.00%', limit: '5.00%' });
    expect(protectionCheck('63000.01', '60000.00', 500)).toEqual({ kind: 'beyond', distance: '5.01%', limit: '5.00%' });
    expect(protectionCheck('56999.99', '60000.00', 500).kind).toBe('beyond');
    expect(protectionCheck('57000.00', '60000.00', 500).kind).toBe('within');
  });
  it('names the distance in percent with two places', () => {
    expect(protectionCheck('55650', '60000', 500)).toEqual({ kind: 'beyond', distance: '7.25%', limit: '5.00%' });
    expect(bpsText(5n)).toBe('0.05%');
  });
});

describe('samePrice', () => {
  it('compares decimals, not text', () => {
    expect(samePrice('60000.1', '60000.10')).toBe(true);
    expect(samePrice('60000.1', '60000.11')).toBe(false);
    expect(samePrice('x', 'x')).toBe(false);
  });
});

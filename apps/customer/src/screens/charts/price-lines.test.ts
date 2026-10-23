import { describe, expect, it } from 'vitest';
import { checkPriceLine, linesFor } from './price-lines';
import { DEFAULT_CHART_SETTINGS, readChartSettings } from './chart-settings';

describe('checkPriceLine: a price is a decimal on the tick grid, or it is refused', () => {
  it('accepts a price on the tick grid and keeps the typed decimal string', () => {
    expect(checkPriceLine('64500.10', '0.01')).toEqual({ ok: true, price: '64500.10' });
    expect(checkPriceLine(' 64500 ', '0.5')).toEqual({ ok: true, price: '64500' });
  });

  it('refuses a blank price, with nothing drawn', () => {
    expect(checkPriceLine('   ', '0.01')).toEqual({ ok: false, reason: 'blank' });
  });

  it('refuses zero, negative, exponent and non-numeric prices', () => {
    for (const bad of ['0', '0.00', '-5', '1e3', 'abc', '1,000']) {
      expect(checkPriceLine(bad, '0.01')).toEqual({ ok: false, reason: 'not-positive' });
    }
  });

  it('refuses a price that is not a whole multiple of the tick size, exactly (no float rounding)', () => {
    expect(checkPriceLine('64500.005', '0.01')).toEqual({ ok: false, reason: 'off-tick' });
    expect(checkPriceLine('64500.3', '0.5')).toEqual({ ok: false, reason: 'off-tick' });
    expect(checkPriceLine('0.3', '0.1')).toEqual({ ok: true, price: '0.3' });
  });
});

describe('linesFor: stored lines are read per market, and malformed ones are dropped', () => {
  it('keeps well-formed lines of that market and drops the rest', () => {
    const store = {
      'BTC/USDT': [
        { id: 'a', price: '64500.00', label: 'Support' },
        { id: 'b', price: 'nope', label: 'x' },
        { id: 'c', price: '1', label: 2 },
        'junk',
      ],
    };
    expect(linesFor(store, 'BTC/USDT')).toEqual([{ id: 'a', price: '64500.00', label: 'Support' }]);
    expect(linesFor(store, 'ETH/USDT')).toEqual([]);
    expect(linesFor('not a store', 'BTC/USDT')).toEqual([]);
  });
});

describe('readChartSettings: an unknown key or wrong type takes the default', () => {
  it('reads known booleans and defaults everything else', () => {
    expect(readChartSettings({ logScale: true, gridLines: 'yes', unknown: true })).toEqual({
      ...DEFAULT_CHART_SETTINGS,
      logScale: true,
    });
    expect(readChartSettings(null)).toEqual(DEFAULT_CHART_SETTINGS);
  });
});

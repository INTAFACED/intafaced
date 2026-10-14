import { describe, expect, it } from 'vitest';
import { discountPercent, rateRows, ratePercent } from './model';
import type { MarketRow } from '../../../data/types';

const market = (base: string, quote = 'USDT'): MarketRow => ({
  symbol: `${base}-${quote}`,
  base,
  quote,
  orderable: true,
  tickSize: '0.01',
  lotSize: '0.0001',
  minAmount: null,
  listedAt: null,
});

describe('ratePercent', () => {
  it('turns a rate into an exact percent with at least two decimals', () => {
    expect(ratePercent('0.001')).toBe('0.10%');
    expect(ratePercent('0.0001')).toBe('0.01%');
    expect(ratePercent('0.00025')).toBe('0.025%');
    expect(ratePercent('0')).toBe('0.00%');
    expect(ratePercent('0.01')).toBe('1.00%');
    expect(ratePercent('0.0035')).toBe('0.35%');
  });
  it('is a dash for anything missing or malformed, never zero', () => {
    for (const bad of [null, undefined, '', 'abc', '-0.001', '1e-3']) expect(ratePercent(bad), String(bad)).toBe('—');
  });
});

describe('discountPercent', () => {
  it('shows basis points as a percent', () => {
    expect(discountPercent(0)).toBe('0.00%');
    expect(discountPercent(50)).toBe('0.50%');
    expect(discountPercent(1234)).toBe('12.34%');
    expect(discountPercent(10_000)).toBe('100.00%');
  });
  it('is a dash for a value that cannot be a discount', () => {
    for (const bad of [-1, 10_001, 1.5, Number.NaN]) expect(discountPercent(bad)).toBe('—');
  });
});

describe('rateRows', () => {
  it('uses the published rate and dashes where the owner has set none', () => {
    const rows = rateRows([market('BTC'), market('ETH')], { 'BTC-USDT': { maker: '0.001', taker: '0.0015' } });
    expect(rows).toEqual([
      { symbol: 'BTC-USDT', market: 'BTC/USDT', maker: '0.10%', taker: '0.15%', unset: false },
      { symbol: 'ETH-USDT', market: 'ETH/USDT', maker: '—', taker: '—', unset: true },
    ]);
  });
  it('finds a rate filed under the slash form', () => {
    expect(rateRows([market('SOL')], { 'SOL/USDT': { maker: '0.002', taker: '0.002' } })[0]).toMatchObject({
      maker: '0.20%',
      unset: false,
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../../../data';
import { defaultPair, edgeFor, edges, fromAssets, planConvert, refinedQty, toAssets } from './convert-model';

const market = (base: string, quote: string, overrides: Partial<MarketRow> = {}): MarketRow => ({
  symbol: `${base}/${quote}`,
  base,
  quote,
  orderable: true,
  tickSize: '0.01',
  lotSize: '0.0001',
  minAmount: '0.0001',
  listedAt: null,
  ...overrides,
});
const all = edges([
  market('BTC', 'USDT'),
  market('ETH', 'USDT'),
  market('ETH', 'USDC'),
  market('IFC', 'USDT'),
  market('SOL', 'USDT', { orderable: false }),
]);

describe('which swaps exist', () => {
  it('offers only direct swaps on open markets, both ways', () => {
    expect(fromAssets(all)).toEqual(['USDT', 'USDC', 'BTC', 'ETH', 'IFC']);
    expect(toAssets(all, 'USDT')).toEqual(['BTC', 'ETH', 'IFC']);
    expect(toAssets(all, 'ETH')).toEqual(['USDT', 'USDC']);
    expect(toAssets(all, 'BTC')).toEqual(['USDT']);
    expect(edgeFor(all, 'BTC', 'ETH')).toBeNull();
    expect(edgeFor(all, 'SOL', 'USDT')).toBeNull();
  });
  it('maps paying with the quote asset to a buy and selling the coin to a sell', () => {
    expect(edgeFor(all, 'USDT', 'ETH')).toMatchObject({ side: 'buy', market: { symbol: 'ETH/USDT' } });
    expect(edgeFor(all, 'ETH', 'USDT')).toMatchObject({ side: 'sell', market: { symbol: 'ETH/USDT' } });
    expect(edgeFor(all, 'ETH', 'USDC')).toMatchObject({ side: 'sell', market: { symbol: 'ETH/USDC' } });
  });
  it('starts from a link, else USDT to BTC', () => {
    expect(defaultPair(all, { asset: 'ETH' })).toEqual({ from: 'USDT', to: 'ETH' });
    expect(defaultPair(all, { from: 'ETH', to: 'USDC' })).toEqual({ from: 'ETH', to: 'USDC' });
    expect(defaultPair(all, { from: 'BTC', to: 'ETH' })).toEqual({ from: 'USDT', to: 'BTC' });
    expect(defaultPair(all, { asset: 'NOPE' })).toEqual({ from: 'USDT', to: 'BTC' });
    expect(defaultPair([], {})).toBeNull();
  });
});

describe('planConvert', () => {
  const buy = edgeFor(all, 'USDT', 'ETH')!;
  const sell = edgeFor(all, 'ETH', 'USDT')!;
  it('sizes 10 USDT into whole ETH lots, rounded down (the brief: convert 10 USDT to ETH)', () => {
    expect(planConvert({ edge: buy, amount: '10', price: '2602.84', minAmount: '0.0001', minCost: '5' })).toMatchObject({
      ok: true,
      base: '0.0038',
    });
  });
  it('takes the coin amount as typed when selling, on the lot', () => {
    expect(planConvert({ edge: sell, amount: '0.01', price: '2601.95', minAmount: '0.0001', minCost: '5' })).toMatchObject({
      ok: true,
      base: '0.01',
    });
    expect(planConvert({ edge: sell, amount: '0.00015', price: '2601.95', minAmount: '0.0001', minCost: '5' })).toEqual({
      ok: false,
      problem: { kind: 'notOnLot', step: '0.0001' },
    });
  });
  it('says the minimum in the From asset', () => {
    expect(planConvert({ edge: buy, amount: '3', price: '2602.84', minAmount: '0.0001', minCost: '5' })).toEqual({
      ok: false,
      problem: { kind: 'tooSmall', min: '5.21', asset: 'USDT' },
    });
    expect(planConvert({ edge: sell, amount: '0.0001', price: '2601.95', minAmount: '0.0001', minCost: '5' })).toMatchObject({
      ok: false,
      problem: { kind: 'tooSmall', min: '0.002', asset: 'ETH' },
    });
  });
});

describe('refinedQty', () => {
  it('tightens a first quote that fell one lot short of what was typed', () => {
    // Asked 0.0038 ETH for "10 USDT": priced at 9.910573584. 0.0038 * 10 / 9.9105... = 0.003834... -> still 0.0038.
    expect(refinedQty({ qty: '0.0038', spent: '9.910573584', typed: '10', lot: '0.0001' })).toBeNull();
    // A coarser lot leaves more room: 10 USDT, first 0.003 priced at 7.8: 0.003 * 10 / 7.8 = 0.003846 -> 0.0038.
    expect(refinedQty({ qty: '0.003', spent: '7.8', typed: '10', lot: '0.0001' })).toBe('0.0038');
  });
  it('does nothing when the quote already costs what was typed, or the numbers are unknown', () => {
    expect(refinedQty({ qty: '0.0038', spent: '10', typed: '10', lot: '0.0001' })).toBeNull();
    expect(refinedQty({ qty: 'x', spent: '9', typed: '10', lot: '0.0001' })).toBeNull();
    expect(refinedQty({ qty: '1', spent: '0', typed: '10', lot: '0.0001' })).toBeNull();
  });
});

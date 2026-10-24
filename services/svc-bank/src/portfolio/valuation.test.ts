import { describe, expect, it } from 'vitest';
import { parseAmount as amt, type Balance } from '@intafaced/ledger-client';
import {
  formatUsd2,
  holdingsFromBalances,
  needsPrices,
  valuePortfolio,
  type Holding,
  type TickerMap,
  type TickerQuote,
} from './valuation.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const h = (assetId: string, total: string, used = '0'): Holding => ({
  assetId,
  free: amt(total) - amt(used),
  used: amt(used),
  total: amt(total),
});

const q = (last: string | null, open: string | null = null, windowStart: number | null = null): TickerQuote => ({
  last: last === null ? null : amt(last),
  open: open === null ? null : amt(open),
  windowStart,
});

const tickers = (rows: Record<string, TickerQuote>): TickerMap => new Map(Object.entries(rows));

const value = (holdings: Holding[], rows: Record<string, TickerQuote> = {}) =>
  valuePortfolio({ holdings, tickers: tickers(rows), nowMs: NOW });

describe('valuePortfolio, the one total-value rule (UI-SPEC §1.2)', () => {
  it('counts USDT, USDC and USD at exactly 1 and calls them cash, with no price needed', () => {
    const s = value([h('USDT', '100.5'), h('USDC', '20'), h('USD', '0.25')]);
    expect(s.totalUsd).toBe('120.75');
    expect(s.cashUsd).toBe('120.75');
    expect(s.cryptoUsd).toBe('0.00');
    expect(s.change24hUsd).toBe('0.00');
    expect(s.unpriced).toEqual([]);
    expect(s.priced.map((r) => [r.asset, r.priceUsd, r.pair, r.change24hUsd])).toEqual([
      ['USDT', '1', null, '0'],
      ['USDC', '1', null, '0'],
      ['USD', '1', null, '0'],
    ]);
    expect(s.asOf).toBe(NOW);
    expect(s.windowStart).toBeNull();
  });

  it('values a mixed portfolio at the last price of the asset/USDT market and sums the price move', () => {
    const s = value([h('USDT', '1000'), h('BTC', '0.5'), h('ETH', '2')], {
      'BTC/USDT': q('60000', '58000'),
      'ETH/USDT': q('3000', '3100'),
    });
    expect(s.cashUsd).toBe('1000.00');
    expect(s.cryptoUsd).toBe('36000.00'); // 30000 + 6000
    expect(s.totalUsd).toBe('37000.00');
    // 0.5 x (60000 - 58000) + 2 x (3000 - 3100) = 1000 - 200
    expect(s.change24hUsd).toBe('800.00');
    const btc = s.priced.find((r) => r.asset === 'BTC')!;
    expect(btc).toEqual({
      asset: 'BTC',
      amount: '0.5',
      priceUsd: '60000',
      valueUsd: '30000',
      change24hUsd: '1000',
      pair: 'BTC/USDT',
    });
    expect(s.priced.find((r) => r.asset === 'ETH')!.change24hUsd).toBe('-200');
  });

  it('lists an asset with no market in unpriced, never guessed and never valued at zero', () => {
    const s = value([h('USDT', '10'), h('IFC', '500')], { 'BTC/USDT': q('60000', '58000') });
    expect(s.totalUsd).toBe('10.00');
    expect(s.unpriced).toEqual([{ asset: 'IFC', amount: '500', reason: 'no_market' }]);
    expect(s.priced.map((r) => r.asset)).toEqual(['USDT']);
    // The unpriced coin does not make the change unknown; it is simply not counted.
    expect(s.change24hUsd).toBe('0.00');
  });

  it('treats another fiat code as unpriced (no FX source) and a market that never traded as unpriced', () => {
    const s = value([h('EUR', '50'), h('SOL', '3')], { 'SOL/USDT': q(null) });
    expect(s.unpriced.map((r) => [r.asset, r.reason])).toEqual([
      ['EUR', 'no_market'],
      ['SOL', 'no_price_yet'],
    ]);
    expect(s.totalUsd).toBeNull();
    expect(s.cashUsd).toBeNull();
    expect(s.cryptoUsd).toBeNull();
    expect(s.change24hUsd).toBeNull();
  });

  it('falls back to the USDC market when there is no usable USDT price, and prefers USDT when both exist', () => {
    const fallback = value([h('XYZ', '10')], { 'XYZ/USDT': q(null), 'XYZ/USDC': q('2.5', '2') });
    expect(fallback.priced[0]).toMatchObject({ asset: 'XYZ', pair: 'XYZ/USDC', priceUsd: '2.5', valueUsd: '25', change24hUsd: '5' });

    const both = value([h('XYZ', '10')], { 'XYZ/USDT': q('3', '3'), 'XYZ/USDC': q('2.5', '2') });
    expect(both.priced[0]).toMatchObject({ pair: 'XYZ/USDT', priceUsd: '3' });
  });

  it('does not cross through a third market (BTC priced only against ETH stays unpriced)', () => {
    const s = value([h('BTC', '1')], { 'BTC/ETH': q('20') });
    expect(s.unpriced).toEqual([{ asset: 'BTC', amount: '1', reason: 'no_market' }]);
  });

  it('is case-insensitive on the asset code', () => {
    const s = value([h('btc', '2')], { 'BTC/USDT': q('10', '9') });
    expect(s.priced[0]).toMatchObject({ asset: 'btc', pair: 'BTC/USDT', valueUsd: '20' });
  });

  it('makes change24hUsd null, not partial, when any priced non-stable asset lacks open24h', () => {
    const s = value([h('USDT', '5'), h('BTC', '1'), h('ETH', '1')], {
      'BTC/USDT': q('60000', '58000'),
      'ETH/USDT': q('3000', null),
    });
    expect(s.totalUsd).toBe('63005.00'); // the total is still counted
    expect(s.change24hUsd).toBeNull();
    expect(s.priced.find((r) => r.asset === 'BTC')!.change24hUsd).toBe('2000');
    expect(s.priced.find((r) => r.asset === 'ETH')!.change24hUsd).toBeNull();
  });

  it("is null change on today's svc-trade where every open is null (before PR #4642)", () => {
    const s = value([h('BTC', '1')], { 'BTC/USDT': q('60000', null, null) });
    expect(s.totalUsd).toBe('60000.00');
    expect(s.change24hUsd).toBeNull();
  });

  it('treats a zero open as unknown rather than dividing or inventing a move', () => {
    const s = value([h('BTC', '1')], { 'BTC/USDT': q('60000', '0') });
    expect(s.change24hUsd).toBeNull();
  });

  it('keeps full precision per asset for dust and many decimals, and rounds only the headline once', () => {
    const s = value([h('BTC', '0.000000000000000001'), h('ETH', '0.123456789012345678'), h('USDT', '0.004')], {
      'BTC/USDT': q('60000.123456789012345678', '59999'),
      'ETH/USDT': q('3000.987654321', '3000'),
    });
    const btc = s.priced.find((r) => r.asset === 'BTC')!;
    // 1e-18 BTC x 60000.12... = 6.0000123e-14, rounds at 18dp to 0.00000000000006
    expect(btc.valueUsd).toBe('0.00000000000006');
    const eth = s.priced.find((r) => r.asset === 'ETH')!;
    expect(eth.amount).toBe('0.123456789012345678');
    // exact: 0.123456789012345678 x 3000.987654321 = 370.492299668161862531222..., kept to 18dp
    expect(eth.valueUsd).toBe('370.492299668161862531');
    // 370.4923 + 0.004 + ~0 = 370.4963, rounded once to 370.50
    expect(s.totalUsd).toBe('370.50');
    expect(s.cashUsd).toBe('0.00'); // 0.004 rounds down
  });

  it('a pure-dust portfolio rounds to 0.00 but is still a counted total, not null', () => {
    const s = value([h('BTC', '0.000000000000000001')], { 'BTC/USDT': q('60000', '59000') });
    expect(s.totalUsd).toBe('0.00');
    expect(s.change24hUsd).toBe('0.00');
    expect(s.priced).toHaveLength(1);
  });

  it('answers an empty portfolio with 0.00, because the ledger really holds nothing', () => {
    const s = value([]);
    expect(s).toMatchObject({ totalUsd: '0.00', change24hUsd: '0.00', cashUsd: '0.00', cryptoUsd: '0.00', priced: [], unpriced: [] });
  });

  it('ignores zero and negative holdings', () => {
    const s = value([h('BTC', '0'), { assetId: 'ETH', free: -1n, used: 0n, total: -1n }]);
    expect(s.priced).toEqual([]);
    expect(s.unpriced).toEqual([]);
    expect(s.totalUsd).toBe('0.00');
  });

  it('reports windowStart only when a priced market is younger than a day (the latest start wins)', () => {
    const young = NOW - 5 * 3_600_000;
    const youngest = NOW - 2 * 3_600_000;
    const s = value([h('BTC', '1'), h('ETH', '1'), h('SOL', '1')], {
      'BTC/USDT': q('10', '9', NOW - DAY),
      'ETH/USDT': q('10', '9', young),
      'SOL/USDT': q('10', '9', youngest),
    });
    expect(s.windowStart).toBe(youngest);
    const full = value([h('BTC', '1')], { 'BTC/USDT': q('10', '9', NOW - DAY) });
    expect(full.windowStart).toBeNull();
  });

  it('sorts biggest value first, ties by asset code', () => {
    const s = value([h('AAA', '1'), h('BBB', '1'), h('USDT', '5')], { 'AAA/USDT': q('5', '5'), 'BBB/USDT': q('9', '9') });
    expect(s.priced.map((r) => r.asset)).toEqual(['BBB', 'AAA', 'USDT']);
  });
});

describe('formatUsd2', () => {
  it('rounds half away from zero to 2 decimals', () => {
    expect(formatUsd2(amt('1.005'))).toBe('1.01');
    expect(formatUsd2(amt('1.004999999999999999'))).toBe('1.00');
    expect(formatUsd2(amt('-1.005'))).toBe('-1.01');
    expect(formatUsd2(amt('-0.004'))).toBe('0.00');
    expect(formatUsd2(0n)).toBe('0.00');
    expect(formatUsd2(amt('12345678901234567890.999'))).toBe('12345678901234567891.00');
  });
});

describe('holdingsFromBalances, the same projection as /api/v1/account/balance', () => {
  const row = (assetId: string, kind: 'available' | 'hold' | 'escrow' | 'stake' | 'collateral', amount: string): Balance => ({
    account: { ownerType: 'user', ownerId: 'u', assetId, kind },
    accountId: `${assetId}-${kind}`,
    amount: amt(amount),
  });

  it('free = available, used = hold + escrow + stake + collateral, total = free + used, staked = the stake part', () => {
    const rows = [
      row('BTC', 'available', '1'),
      row('BTC', 'hold', '0.25'),
      row('BTC', 'stake', '0.5'),
      row('BTC', 'collateral', '0.125'),
      row('BTC', 'escrow', '0.0625'),
      row('USDT', 'available', '10'),
      row('ETH', 'available', '0'),
    ];
    expect(holdingsFromBalances(rows)).toEqual([
      { assetId: 'BTC', free: amt('1'), used: amt('0.9375'), total: amt('1.9375'), staked: amt('0.5') },
      { assetId: 'USDT', free: amt('10'), used: 0n, total: amt('10') },
    ]);
  });

  it('counts locked-only holdings, and needsPrices is false for stable-only books', () => {
    const locked = holdingsFromBalances([row('SOL', 'stake', '4')]);
    expect(locked).toEqual([{ assetId: 'SOL', free: 0n, used: amt('4'), total: amt('4'), staked: amt('4') }]);
    expect(needsPrices(locked)).toBe(true);
    expect(needsPrices(holdingsFromBalances([row('usdt', 'available', '1'), row('USDC', 'hold', '1')]))).toBe(false);
    expect(needsPrices([])).toBe(false);
  });
});

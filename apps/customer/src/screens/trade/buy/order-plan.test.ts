import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../../../data';
import {
  coinOptions,
  dollarsForBase,
  smallestOrder,
  isPayAsset,
  marketFor,
  maxBase,
  payOptions,
  planOrder,
  type PlanInput,
} from './order-plan';

const market = (base: string, quote: string, overrides: Partial<MarketRow> = {}): MarketRow => ({
  symbol: `${base}/${quote}`,
  base,
  quote,
  orderable: true,
  tickSize: '0.01',
  lotSize: '0.00001',
  minAmount: '0.00001',
  listedAt: null,
  ...overrides,
});

const BTC: Omit<PlanInput, 'unit' | 'amount'> = {
  price: '65083.66',
  lot: '0.00001',
  minAmount: '0.00001',
  minCost: '5',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
};

describe('coins and markets', () => {
  const all = [
    market('IFC', 'USDT'),
    market('ETH', 'USDC'),
    market('BTC', 'USDT'),
    market('BTC', 'USDC'),
    market('ETH', 'USDT'),
    market('SOL', 'USDT', { orderable: false }),
    market('USDC', 'USDT'),
    market('AUD', 'USD'),
  ];
  it('lists only coins that open USDT or USDC markets can pay for, BTC and ETH first', () => {
    expect(coinOptions(all).map((coin) => coin.base)).toEqual(['BTC', 'ETH', 'IFC']);
  });
  it('prefers USDT, falls back to USDC, and honours an explicit payer', () => {
    const [btc, eth] = coinOptions(all);
    expect(payOptions(btc!)).toEqual(['USDT', 'USDC']);
    expect(marketFor(btc!)!.symbol).toBe('BTC/USDT');
    expect(marketFor(btc!, 'USDC')!.symbol).toBe('BTC/USDC');
    const usdcOnly = coinOptions([market('XRP', 'USDC')])[0]!;
    expect(marketFor(usdcOnly)!.symbol).toBe('XRP/USDC');
    expect(marketFor(usdcOnly, 'USDT')!.symbol).toBe('XRP/USDC');
    expect(eth!.markets.USDT).toBeDefined();
    expect(isPayAsset('USDT')).toBe(true);
    expect(isPayAsset('BTC')).toBe(false);
  });
});

describe('planOrder', () => {
  it('sizes a dollar amount into whole lots, rounded down, and prices it', () => {
    const plan = planOrder({ ...BTC, unit: 'quote', amount: '10' });
    expect(plan).toMatchObject({ ok: true, base: '0.00015' });
    // 0.00015 BTC at 65,083.66 = 9.762549: never more than the 10 typed.
    expect(plan.ok && plan.notional).toBe('9.762549');
  });

  it('keeps a coin amount as typed when it sits on the lot', () => {
    expect(planOrder({ ...BTC, unit: 'base', amount: '0.00015' })).toMatchObject({ ok: true, base: '0.00015', notional: '9.762549' });
  });

  it('refuses a coin amount between lots instead of rounding it', () => {
    expect(planOrder({ ...BTC, unit: 'base', amount: '0.000155' })).toEqual({ ok: false, problem: { kind: 'notOnLot', step: '0.00001' } });
  });

  it('says nothing for an empty or zero amount', () => {
    expect(planOrder({ ...BTC, unit: 'quote', amount: '' })).toEqual({ ok: false, problem: { kind: 'empty' } });
    expect(planOrder({ ...BTC, unit: 'quote', amount: '0' })).toEqual({ ok: false, problem: { kind: 'empty' } });
    expect(planOrder({ ...BTC, unit: 'base', amount: '0.00' })).toEqual({ ok: false, problem: { kind: 'empty' } });
  });

  it('needs a price to turn dollars into coins', () => {
    expect(planOrder({ ...BTC, price: null, unit: 'quote', amount: '10' })).toEqual({ ok: false, problem: { kind: 'noPrice' } });
    expect(planOrder({ ...BTC, price: null, unit: 'base', amount: '0.00015' })).toMatchObject({ ok: true, notional: null });
  });

  it('refuses under the minimum order value, in dollars, rounded up to cents', () => {
    expect(planOrder({ ...BTC, unit: 'quote', amount: '4' })).toEqual({
      ok: false,
      problem: { kind: 'tooSmall', min: '5', asset: 'USDT' },
    });
    // 4.99 buys 0.00007 BTC = 4.55 < 5.
    expect(planOrder({ ...BTC, unit: 'quote', amount: '4.99' })).toMatchObject({ ok: false, problem: { kind: 'tooSmall', asset: 'USDT' } });
    expect(planOrder({ ...BTC, unit: 'quote', amount: '5.5' })).toMatchObject({ ok: true });
  });

  it('refuses under the minimum order value when entered in coins, in coins rounded up to a lot', () => {
    expect(planOrder({ ...BTC, unit: 'base', amount: '0.00007' })).toEqual({
      ok: false,
      problem: { kind: 'tooSmall', min: '0.00008', asset: 'BTC' },
    });
  });

  it('refuses under the smallest order size', () => {
    const plan = planOrder({ ...BTC, minCost: null, minAmount: '0.001', unit: 'base', amount: '0.0005' });
    expect(plan).toEqual({ ok: false, problem: { kind: 'tooSmall', min: '0.001', asset: 'BTC' } });
  });

  it('refuses dollars that do not buy one whole lot', () => {
    const plan = planOrder({ ...BTC, minCost: null, lot: '1', minAmount: '1', price: '65083.66', unit: 'quote', amount: '100' });
    expect(plan).toMatchObject({ ok: false, problem: { kind: 'tooSmall', min: '65083.66', asset: 'USDT' } });
  });

  it('never trusts a missing lot', () => {
    expect(planOrder({ ...BTC, lot: '0', unit: 'base', amount: '1' })).toEqual({ ok: false, problem: { kind: 'noPrice' } });
  });
});

describe('maxBase (available minus the fee)', () => {
  const buy = { side: 'buy' as const, lot: '0.00001', spendAsset: 'USDT' };
  it('sizes a buy at the protection price, the worst price the order may fill at', () => {
    // 100 / 65,409.08 = 0.0015288... -> 0.00152 BTC; the fee is taken in BTC so it does not shrink the dollars.
    expect(maxBase({ ...buy, available: '100', holdPrice: '65409.08', feeBps: 10, feeAsset: 'BTC' })).toBe('0.00152');
  });
  it('holds the fee back when it is taken in the asset being spent', () => {
    // 100 / 1.001 = 99.9000999 -> / 65,409.08 = 0.0015273 -> 0.00152
    expect(maxBase({ ...buy, available: '100', holdPrice: '65409.08', feeBps: 10, feeAsset: 'USDT' })).toBe('0.00152');
    // A fee of 10 % makes the difference visible: 100 / 1.1 = 90.909 -> 0.00138
    expect(maxBase({ ...buy, available: '100', holdPrice: '65409.08', feeBps: 1000, feeAsset: 'USDT' })).toBe('0.00138');
  });
  it('sells the whole coin balance minus a coin-denominated fee, in whole lots', () => {
    const sell = { side: 'sell' as const, lot: '0.00001', spendAsset: 'BTC', holdPrice: null };
    expect(maxBase({ ...sell, available: '0.25', feeBps: 10, feeAsset: 'USDT' })).toBe('0.25');
    expect(maxBase({ ...sell, available: '0.25', feeBps: 10, feeAsset: 'BTC' })).toBe('0.24975');
  });
  it('does nothing when something is unknown or nothing fits', () => {
    expect(maxBase({ ...buy, available: null, holdPrice: '1', feeBps: 10, feeAsset: 'BTC' })).toBeNull();
    expect(maxBase({ ...buy, available: '0', holdPrice: '1', feeBps: 10, feeAsset: 'BTC' })).toBeNull();
    expect(maxBase({ ...buy, available: '100', holdPrice: null, feeBps: 10, feeAsset: 'BTC' })).toBeNull();
    expect(maxBase({ ...buy, available: '100', holdPrice: '65409.08', feeBps: null, feeAsset: 'BTC' })).toBeNull();
    expect(maxBase({ ...buy, available: '0.5', holdPrice: '65409.08', feeBps: 10, feeAsset: 'BTC' })).toBeNull();
  });
});

describe('dollarsForBase (the box a Max lands in)', () => {
  it('rounds up to cents so Max is not one lot short, and plans back to the same coins', () => {
    // 0.15277 BTC at 65,083.66 = 9942.7... -> cents up; floor(dollars / price) must still be 0.15277.
    const dollars = dollarsForBase('0.15277', '65083.66', '0.00001')!;
    const plan = planOrder({
      unit: 'quote',
      amount: dollars,
      price: '65083.66',
      lot: '0.00001',
      minAmount: '0.00001',
      minCost: '5',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    });
    expect(plan).toMatchObject({ ok: true, base: '0.15277' });
  });
  it('falls back to rounding down when rounding up would buy another lot', () => {
    // A cheap coin with a big lot: 1 cent is more than one lot.
    const dollars = dollarsForBase('10', '0.4130', '0.01')!;
    const plan = planOrder({
      unit: 'quote',
      amount: dollars,
      price: '0.4130',
      lot: '0.01',
      minAmount: '0.01',
      minCost: null,
      baseAsset: 'IFC',
      quoteAsset: 'USDT',
    });
    expect(plan).toMatchObject({ ok: true, base: '10' });
  });
  it('is null when anything is unknown', () => {
    expect(dollarsForBase('x', '1', '0.1')).toBeNull();
    expect(dollarsForBase('1', null, '0.1')).toBeNull();
  });
});

describe('smallestOrder', () => {
  it('is the larger of the lot, the minimum size and the minimum order value at the price', () => {
    expect(smallestOrder({ lot: '0.00001', minAmount: '0.00001', minCost: '5', price: '65083.66' })).toBe('0.00008');
    expect(smallestOrder({ lot: '0.01', minAmount: '0.5', minCost: null, price: null })).toBe('0.5');
    expect(smallestOrder({ lot: '0', minAmount: null, minCost: null, price: null })).toBeNull();
  });
});

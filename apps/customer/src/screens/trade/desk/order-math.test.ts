import { describe, expect, it } from 'vitest';
import {
  amountForValue,
  bboPrice,
  checkOrder,
  maxAmount,
  orderValue,
  padDecimals,
  portionOf,
  referencePrice,
  scaleStep,
} from './order-math';

const market = { tickSize: '0.01', lotSize: '0.00001', minAmount: '0.00001', minCost: '5', taker: '0.002', maker: '0.001' };
const ref = { bestBid: '65005.6', bestAsk: '65083.66' };

describe('checkOrder', () => {
  it('refuses an empty amount', () => {
    expect(checkOrder({ side: 'buy', type: 'limit', price: '64000', amount: '' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'amountEmpty' },
    });
    expect(checkOrder({ side: 'buy', type: 'limit', price: '64000', amount: '0' }, market, ref).ok).toBe(false);
    expect(checkOrder({ side: 'buy', type: 'limit', price: '64000', amount: 'abc' }, market, ref).ok).toBe(false);
  });

  it('refuses an amount that is not a whole number of lots', () => {
    expect(checkOrder({ side: 'buy', type: 'limit', price: '64000', amount: '0.000015' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'amountLot', lot: '0.00001' },
    });
  });

  it('refuses an amount below the minimum', () => {
    const coarse = { ...market, lotSize: '0.001', minAmount: '0.01' };
    expect(checkOrder({ side: 'buy', type: 'limit', price: '64000', amount: '0.005' }, coarse, ref)).toEqual({
      ok: false,
      problem: { kind: 'amountMin', min: '0.01' },
    });
  });

  it('refuses a limit price off the tick and one that is empty', () => {
    expect(checkOrder({ side: 'buy', type: 'limit', price: '64000.005', amount: '0.0001' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'priceTick', tick: '0.01' },
    });
    expect(checkOrder({ side: 'buy', type: 'limit', price: '', amount: '0.0001' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'priceEmpty' },
    });
  });

  it('refuses an order below the minimum value, by exact arithmetic', () => {
    // 0.0001 BTC at 49,999.99 is 4.999999 USDT: one hair under the 5 minimum.
    expect(checkOrder({ side: 'buy', type: 'limit', price: '49999.99', amount: '0.0001' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'valueMin', min: '5' },
    });
    expect(checkOrder({ side: 'buy', type: 'limit', price: '50000', amount: '0.0001' }, market, ref).ok).toBe(true);
  });

  it('accepts the order from the live check: 0.0001 BTC 1,000 under the best bid', () => {
    expect(checkOrder({ side: 'buy', type: 'limit', price: '64005.6', amount: '0.0001' }, market, ref)).toEqual({
      ok: true,
      amount: '0.0001',
      price: '64005.6',
    });
  });

  it('judges a market order against the opposite best price and carries no price', () => {
    expect(checkOrder({ side: 'buy', type: 'market', price: '', amount: '0.0001' }, market, ref)).toEqual({
      ok: true,
      amount: '0.0001',
      price: null,
    });
    // 0.00001 BTC at 65,083.66 is 0.65 USDT, under the minimum.
    expect(checkOrder({ side: 'buy', type: 'market', price: '', amount: '0.00001' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'valueMin', min: '5' },
    });
    expect(checkOrder({ side: 'buy', type: 'market', price: '', amount: '0.0001' }, market, { bestBid: null, bestAsk: null })).toEqual({
      ok: false,
      problem: { kind: 'noPrice' },
    });
  });

  it('normalises trailing zeros', () => {
    const result = checkOrder({ side: 'sell', type: 'limit', price: '70000.10', amount: '0.00020' }, market, ref);
    expect(result).toEqual({ ok: true, amount: '0.0002', price: '70000.1' });
  });
});

describe('orderValue', () => {
  it('is exact for a limit and flagged as an estimate for a market order', () => {
    expect(orderValue({ side: 'buy', type: 'limit', price: '64005.6', amount: '0.0001' }, ref)).toEqual({
      value: '6.40056',
      estimated: false,
    });
    expect(orderValue({ side: 'buy', type: 'market', price: '', amount: '0.0001' }, ref)).toEqual({ value: '6.508366', estimated: true });
    expect(orderValue({ side: 'buy', type: 'limit', price: '', amount: '0.0001' }, ref)).toBeNull();
  });
});

describe('maxAmount and portionOf', () => {
  it('sell: the whole balance, down to the lot', () => {
    expect(maxAmount({ side: 'sell', type: 'limit', price: '', available: '0.250009', market, ref })).toBe('0.25');
    expect(maxAmount({ side: 'sell', type: 'limit', price: '', available: null, market, ref })).toBeNull();
  });

  it('buy: the balance over price plus taker fee, rounded down so the order never exceeds it', () => {
    const max = maxAmount({ side: 'buy', type: 'limit', price: '65000', available: '1000', market, ref })!;
    // 1000 / (65000 x 1.002) = 0.015353..., floored to 0.01535 BTC
    expect(max).toBe('0.01535');
    // Spending it all plus fee stays inside the balance.
    const cost = (BigInt(max.replace('0.', '')) * 65000n * 1002n) / 1000n; // in 1e-5 units
    expect(cost <= 1000n * 100000n).toBe(true);
  });

  it('buy at market uses the best ask; with no price it is unknown, never a guess', () => {
    expect(maxAmount({ side: 'buy', type: 'market', price: '', available: '100', market, ref })).toBe('0.00153');
    expect(
      maxAmount({ side: 'buy', type: 'market', price: '', available: '100', market, ref: { bestBid: null, bestAsk: null } }),
    ).toBeNull();
    expect(maxAmount({ side: 'buy', type: 'limit', price: '', available: '100', market, ref })).toBeNull();
  });

  it('percent chips round down to the lot and give null for nothing', () => {
    expect(portionOf('0.01535', 50, '0.00001')).toBe('0.00767');
    expect(portionOf('0.01535', 25, '0.001')).toBe('0.003');
    expect(portionOf('0.00001', 25, '0.00001')).toBeNull();
    expect(portionOf(null, 100, '0.00001')).toBeNull();
  });
});

describe('helpers', () => {
  it('picks the reference and BBO prices by side', () => {
    expect(referencePrice('buy', ref)).toBe('65083.66');
    expect(referencePrice('sell', ref)).toBe('65005.6');
    expect(bboPrice('buy', ref)).toBe('65005.6');
    expect(bboPrice('sell', ref)).toBe('65083.66');
    expect(bboPrice('buy', null)).toBeNull();
  });

  it('turns a typed order value into whole lots at the limit price', () => {
    expect(amountForValue('10', '64000', '0.00001')).toBe('0.00015');
    expect(amountForValue('0.0001', '64000', '0.00001')).toBeNull();
  });

  it('pads a price to the tick decimals and never cuts digits', () => {
    expect(padDecimals('65000.1', 2)).toBe('65000.10');
    expect(padDecimals('65000', 2)).toBe('65000.00');
    expect(padDecimals('65000.123', 2)).toBe('65000.123');
    expect(padDecimals('', 2)).toBe('');
  });

  it('scales grouping steps exactly', () => {
    expect(scaleStep('0.01', 1)).toBe('0.1');
    expect(scaleStep('0.01', 2)).toBe('1');
    expect(scaleStep('0.0001', 3)).toBe('0.1');
  });
});

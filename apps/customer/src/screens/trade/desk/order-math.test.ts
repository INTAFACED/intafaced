import { describe, expect, it } from 'vitest';
import {
  amountForValue,
  bboPrice,
  checkOrder,
  exitSideOff,
  serviceType,
  maxAmount,
  orderValue,
  padDecimals,
  portionOf,
  probeAmount,
  protectionNow,
  referencePrice,
  scaled,
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
    expect(maxAmount({ side: 'sell', type: 'limit', price: '', available: '0.250009', market })).toBe('0.25');
    expect(maxAmount({ side: 'sell', type: 'limit', price: '', available: null, market })).toBeNull();
  });

  it('limit buy: the balance over the price, rounded down so the hold never exceeds it (no fee factor)', () => {
    // 1000 / 65000 = 0.0153846..., down to the 0.00001 lot
    expect(maxAmount({ side: 'buy', type: 'limit', price: '65000', available: '1000', market })).toBe('0.01538');
    expect(maxAmount({ side: 'buy', type: 'limit', price: '', available: '100', market })).toBeNull();
  });

  it('market buy: sized from the price protection, so the hold is never more than the balance', () => {
    // The live case: 9,937.39 available and protection 65,409.08 gave 0.15238 BTC by best ask, a 9,967 hold.
    const max = maxAmount({ side: 'buy', type: 'market', price: '', available: '9937.39399533', market, protectionPrice: '65409.08' })!;
    expect(max).toBe('0.15192');
    expect(scaled(max)! * scaled('65409.08')! <= scaled('9937.39399533')! * 10n ** 18n).toBe(true);
    // No protection price: unknown, never a guess from the best ask.
    expect(maxAmount({ side: 'buy', type: 'market', price: '', available: '100', market, protectionPrice: null })).toBeNull();
  });

  it('carries a protection price to a moved best ask, rounded up', () => {
    expect(protectionNow('65409.08', '65083.66', '65083.66')).toBe('65409.08');
    expect(scaled(protectionNow('65409.08', '65083.66', '65200')!)! > scaled('65409.08')!).toBe(true);
    expect(protectionNow(null, '1', '1')).toBeNull();
  });

  it('a probe amount clears the minimum order value with room to spare', () => {
    const probe = probeAmount(market, '65083.66')!;
    expect(checkOrder({ side: 'buy', type: 'market', price: '', amount: probe }, market, { bestBid: null, bestAsk: '65083.66' }).ok).toBe(
      true,
    );
    expect(probeAmount(market, '0')).toBeNull();
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

  it('a stop-limit needs a price and a stop price on the tick grid, and carries both', () => {
    const base = { side: 'sell' as const, type: 'stop_limit' as const, price: '70000.10', amount: '0.0002' };
    expect(checkOrder({ ...base, stopPrice: '' }, market, ref)).toEqual({ ok: false, problem: { kind: 'stopEmpty' } });
    expect(checkOrder({ ...base, price: '', stopPrice: '70100' }, market, ref)).toEqual({ ok: false, problem: { kind: 'priceEmpty' } });
    expect(checkOrder({ ...base, stopPrice: '70100.10' }, market, ref)).toEqual({
      ok: true,
      amount: '0.0002',
      price: '70000.1',
      stopPrice: '70100.1',
    });
  });
});

describe('exit orders (OCO and bracket)', () => {
  const oco = { side: 'sell', type: 'oco', price: '70000', stopPrice: '60000', amount: '0.001' } as const;
  const bracket = { side: 'buy', type: 'bracket', price: '', stopPrice: '60000', takeProfit: '70000', amount: '0.001' } as const;

  it('an OCO is a limit priced at its take-profit with both exits carried', () => {
    expect(checkOrder(oco, market, ref)).toEqual({
      ok: true,
      amount: '0.001',
      price: '70000',
      exit: { takeProfit: '70000', stopLoss: '60000' },
    });
  });

  it('a bracket without an entry price is a market entry, with one it is a limit entry', () => {
    expect(checkOrder(bracket, market, ref)).toEqual({
      ok: true,
      amount: '0.001',
      price: null,
      exit: { takeProfit: '70000', stopLoss: '60000' },
    });
    expect(serviceType('bracket', '')).toBe('market');
    expect(serviceType('bracket', '65000')).toBe('limit');
    expect(serviceType('oco', '70000')).toBe('limit');
    expect(checkOrder({ ...bracket, price: '65000' }, market, ref)).toMatchObject({ ok: true, price: '65000' });
  });

  it('refuses a missing or off-step exit, in the exit words', () => {
    expect(checkOrder({ ...oco, price: '' }, market, ref)).toEqual({ ok: false, problem: { kind: 'takeProfitEmpty' } });
    expect(checkOrder({ ...oco, stopPrice: '' }, market, ref)).toEqual({ ok: false, problem: { kind: 'stopLossEmpty' } });
    expect(checkOrder({ ...oco, price: '70000.005' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'takeProfitTick', tick: '0.01' },
    });
    expect(checkOrder({ ...oco, stopPrice: '60000.005' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'stopLossTick', tick: '0.01' },
    });
    expect(checkOrder({ ...bracket, takeProfit: '' }, market, ref)).toEqual({ ok: false, problem: { kind: 'takeProfitEmpty' } });
  });

  it('refuses a take-profit at or under the stop-loss, and an entry outside the exits', () => {
    expect(checkOrder({ ...oco, price: '60000' }, market, ref)).toEqual({ ok: false, problem: { kind: 'exitOrder' } });
    expect(checkOrder({ ...oco, price: '59000' }, market, ref)).toEqual({ ok: false, problem: { kind: 'exitOrder' } });
    expect(checkOrder({ ...bracket, price: '70000' }, market, ref)).toEqual({ ok: false, problem: { kind: 'entryBetween' } });
    expect(checkOrder({ ...bracket, price: '59000' }, market, ref)).toEqual({ ok: false, problem: { kind: 'entryBetween' } });
  });

  it('OCO works on both sides and a bracket is buy-only', () => {
    expect(exitSideOff('buy', 'oco')).toBe(false);
    expect(exitSideOff('sell', 'oco')).toBe(false);
    expect(exitSideOff('sell', 'bracket')).toBe(true);
    expect(exitSideOff('buy', 'bracket')).toBe(false);
    expect(exitSideOff('buy', 'limit')).toBe(false);
  });

  it('a buy OCO needs take-profit < stop loss <= stop-loss limit, and is held and sized at the limit', () => {
    const buyOco = { ...oco, side: 'buy', price: '58000', stopPrice: '60000', stopLimit: '60100' } as const;
    expect(checkOrder(buyOco, market, ref)).toEqual({
      ok: true,
      amount: '0.001',
      price: '58000',
      exit: { takeProfit: '58000', stopLoss: '60000', stopLossLimit: '60100' },
    });
    // equal trigger and limit is allowed
    expect(checkOrder({ ...buyOco, stopLimit: '60000' }, market, ref)).toMatchObject({ ok: true });
    expect(checkOrder({ ...buyOco, stopLimit: '' }, market, ref)).toEqual({ ok: false, problem: { kind: 'stopLimitEmpty' } });
    expect(checkOrder({ ...buyOco, stopLimit: '60100.005' }, market, ref)).toEqual({
      ok: false,
      problem: { kind: 'stopLimitTick', tick: '0.01' },
    });
    expect(checkOrder({ ...buyOco, stopLimit: '59999' }, market, ref)).toEqual({ ok: false, problem: { kind: 'stopLimitBelowTrigger' } });
    expect(checkOrder({ ...buyOco, price: '60000' }, market, ref)).toEqual({ ok: false, problem: { kind: 'exitOrderBuy' } });
    expect(checkOrder({ ...buyOco, price: '61000' }, market, ref)).toEqual({ ok: false, problem: { kind: 'exitOrderBuy' } });
    expect(orderValue(buyOco, ref)).toEqual({ value: '60.1', estimated: false });
    expect(maxAmount({ side: 'buy', type: 'oco', price: '58000', stopLimit: '100', available: '1000', market: { lotSize: '0.001' } })).toBe(
      '10',
    );
  });

  it('a resting bracket entry (good till cancelled) needs an entry price', () => {
    expect(checkOrder({ ...bracket, tif: 'GTC' }, market, ref)).toEqual({ ok: false, problem: { kind: 'priceEmpty' } });
    expect(checkOrder({ ...bracket, price: '65000', tif: 'GTC' }, market, ref)).toMatchObject({ ok: true, price: '65000' });
    expect(checkOrder({ ...bracket, tif: 'IOC' }, market, ref)).toMatchObject({ ok: true, price: null });
  });

  it('a market-entry bracket is sized from the price protection, a limit entry from its own price', () => {
    const args = { side: 'buy', available: '1000', market: { lotSize: '0.001' }, protectionPrice: '100' } as const;
    expect(maxAmount({ ...args, type: 'bracket', price: '' })).toBe('10');
    expect(maxAmount({ ...args, type: 'bracket', price: '50' })).toBe('20');
  });
});

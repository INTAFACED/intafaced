import { describe, expect, it } from 'vitest';
import { draftSchema } from './trade-api';

const base = {
  symbol: 'BTC/USDT',
  side: 'sell',
  type: 'stop_limit',
  amount: '0.1',
  price: '69000',
  stopPrice: '70000',
  timeInForce: 'GTC',
  postOnly: false,
  clientOrderId: 'desk:1',
} as const;

describe('stop-limit draft', () => {
  it('needs both a limit price and a stop price', () => {
    expect(draftSchema.safeParse(base).success).toBe(true);
    expect(draftSchema.safeParse({ ...base, stopPrice: undefined }).success).toBe(false);
    expect(draftSchema.safeParse({ ...base, price: undefined }).success).toBe(false);
  });

  it('a stop price on any other type is refused', () => {
    expect(draftSchema.safeParse({ ...base, type: 'limit' }).success).toBe(false);
  });
});

describe('stop-market draft', () => {
  const market = { ...base, type: 'stop', price: undefined } as const;
  it('needs a stop price and names no price: the service places it at its protection price', () => {
    expect(draftSchema.safeParse(market).success).toBe(true);
    expect(draftSchema.safeParse({ ...market, stopPrice: undefined }).success).toBe(false);
    expect(draftSchema.safeParse({ ...market, price: '69000' }).success).toBe(false);
  });
});

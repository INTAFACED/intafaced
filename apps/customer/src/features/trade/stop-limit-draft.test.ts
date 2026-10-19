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

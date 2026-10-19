import { describe, expect, it } from 'vitest';
import { marketSchema } from './schemas.js';

const ZERO_OR_NEGATIVE = ['0', '0.0', '00', '-1', '-0'] as const;

function market(overrides: {
  precision?: { amount: string; price: string };
  contractSize?: string | null;
  limits?: {
    amount?: { min: string | null; max: string | null };
    price?: { min: string | null; max: string | null };
    cost?: { min: string | null; max: string | null };
    leverage?: { min: string | null; max: string | null };
  };
}) {
  return {
    id: 'm-1',
    symbol: 'EUR/USD',
    base: 'EUR',
    quote: 'USD',
    settle: null,
    baseId: 'EUR',
    quoteId: 'USD',
    type: 'spot',
    spot: true,
    swap: false,
    future: false,
    option: false,
    contract: false,
    linear: null,
    inverse: null,
    active: true,
    paper: false,
    schedule: 'fx-global' as const,
    sessionOpen: true,
    nextSessionChange: null,
    hours: {
      kind: 'sessions' as const,
      timezone: 'America/New_York',
      windows: [{ open: { day: 0, time: '17:00' }, close: { day: 5, time: '17:00' } }],
      holidays: [] as string[],
    },
    taker: '0.001',
    maker: '0.0005',
    contractSize: overrides.contractSize === undefined ? null : overrides.contractSize,
    expiry: null,
    expiryDatetime: null,
    strike: null,
    optionType: null,
    precisionMode: 'TICK_SIZE' as const,
    precision: overrides.precision ?? { amount: '1000', price: '0.00001' },
    limits: {
      amount: { min: '1000', max: null as string | null },
      price: { min: '0.00001', max: null as string | null },
      cost: { min: '1000', max: null as string | null },
      leverage: { min: null as string | null, max: null as string | null },
      ...overrides.limits,
    },
  };
}

describe('tick, lot, and contract size', () => {
  it('refuses a zero or negative lot', () => {
    for (const amount of ZERO_OR_NEGATIVE) {
      expect(marketSchema.safeParse(market({ precision: { amount, price: '0.00001' } })).success, amount).toBe(false);
    }
  });

  it('refuses a zero or negative tick', () => {
    for (const price of ZERO_OR_NEGATIVE) {
      expect(marketSchema.safeParse(market({ precision: { amount: '1000', price } })).success, price).toBe(false);
    }
  });

  it('refuses a zero or negative contract size', () => {
    for (const contractSize of ['0', '0.0', '-1'] as const) {
      expect(marketSchema.safeParse(market({ contractSize })).success, contractSize).toBe(false);
    }
  });

  it('refuses a negative amount or price limit', () => {
    for (const bound of ['-1', '-0', '-0.0'] as const) {
      expect(marketSchema.safeParse(market({ limits: { amount: { min: bound, max: null } } })).success, `amount.min ${bound}`).toBe(false);
      expect(marketSchema.safeParse(market({ limits: { amount: { min: null, max: bound } } })).success, `amount.max ${bound}`).toBe(false);
      expect(marketSchema.safeParse(market({ limits: { price: { min: bound, max: null } } })).success, `price.min ${bound}`).toBe(false);
      expect(marketSchema.safeParse(market({ limits: { price: { min: null, max: bound } } })).success, `price.max ${bound}`).toBe(false);
    }
  });

  it('accepts a positive tick, lot, and contract size, and a zero or absent limit', () => {
    expect(
      marketSchema.safeParse(
        market({
          precision: { amount: '0.000000000000000001', price: '1000' },
          contractSize: '1',
          limits: {
            amount: { min: '0', max: '0.0' },
            price: { min: null, max: '0' },
            cost: { min: '-1', max: null },
            leverage: { min: '-1', max: null },
          },
        }),
      ).success,
    ).toBe(true);
    expect(marketSchema.safeParse(market({ contractSize: null })).success).toBe(true);
  });
});

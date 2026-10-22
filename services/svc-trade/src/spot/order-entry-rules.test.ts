import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { bandEdges, checkOpenOrderCaps, orderEntryRulesFromEnv, parseCapsByLevel, validBandRule } from './order-entry-rules.js';
import type { Market } from './types.js';

const market = { id: 'm', tickSize: amt('0.01') } as unknown as Market;

function code(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    return (err as { code: string }).code;
  }
  return 'ok';
}

describe('order-entry-rules (SP-order-entry-03)', () => {
  it('band edges sit on the tick grid, high floored and low ceiled', () => {
    expect(bandEdges(market, amt('100.01'), 500)).toEqual({ low: amt('95.01'), high: amt('105.01') });
    expect(bandEdges(market, amt('100'), 10_000)).toEqual({ low: 0n, high: amt('200') });
  });

  it('a band rule outside 1..10000 bps or with no age is not a valid band', () => {
    const reference = { reference: async () => null };
    expect(validBandRule({ bandBps: 0, maxReferenceAgeMs: 1, reference })).toBe(false);
    expect(validBandRule({ bandBps: 10_001, maxReferenceAgeMs: 1, reference })).toBe(false);
    expect(validBandRule({ bandBps: 1, maxReferenceAgeMs: 0, reference })).toBe(false);
    expect(validBandRule({ bandBps: 1, maxReferenceAgeMs: 1, reference })).toBe(true);
  });

  it('caps by level parse, and any malformed entry empties the map so nothing loosens', () => {
    expect(parseCapsByLevel('basic:5, full:50')).toEqual({ basic: 5, full: 50 });
    expect(parseCapsByLevel('')).toEqual({});
    expect(parseCapsByLevel('basic:5,gold:9')).toEqual({});
    expect(parseCapsByLevel('basic:-1')).toEqual({});
  });

  it('caps: unset, total full, level full, under both', () => {
    expect(code(() => checkOpenOrderCaps(null, 'basic', 0))).toBe('trade.open_order_cap_unset');
    expect(code(() => checkOpenOrderCaps({ total: null, byLevel: { basic: 1 } }, 'basic', 0))).toBe('trade.open_order_cap_unset');
    expect(code(() => checkOpenOrderCaps({ total: 5, byLevel: {} }, 'basic', 0))).toBe('trade.open_order_cap_unset');
    expect(code(() => checkOpenOrderCaps({ total: 2, byLevel: { basic: 5 } }, 'basic', 2))).toBe('trade.open_order_cap_total');
    expect(code(() => checkOpenOrderCaps({ total: 5, byLevel: { basic: 2 } }, 'basic', 2))).toBe('trade.open_order_cap_level');
    expect(code(() => checkOpenOrderCaps({ total: 5, byLevel: { basic: 5 } }, 'basic', 4))).toBe('ok');
  });

  it('blank env gives null rules (refuse), never a default', () => {
    const rules = orderEntryRulesFromEnv({} as never, {
      TRADE_PRICE_BAND_BPS: null,
      TRADE_PRICE_REFERENCE_MAX_AGE_MS: null,
      TRADE_OPEN_ORDER_CAP_TOTAL: null,
      TRADE_OPEN_ORDER_CAP_BY_LEVEL: '',
    });
    expect(rules.priceBand).toBeNull();
    expect(rules.openOrderCaps).toBeNull();
    const half = orderEntryRulesFromEnv({} as never, {
      TRADE_PRICE_BAND_BPS: 500,
      TRADE_PRICE_REFERENCE_MAX_AGE_MS: null,
      TRADE_OPEN_ORDER_CAP_TOTAL: 10,
      TRADE_OPEN_ORDER_CAP_BY_LEVEL: 'basic:3',
    });
    expect(half.priceBand).toBeNull();
    expect(half.openOrderCaps).toEqual({ total: 10, byLevel: { basic: 3 } });
  });
});

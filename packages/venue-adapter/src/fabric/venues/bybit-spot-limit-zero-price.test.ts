import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { mapBybitSpotOrder } from './bybit-spot-trade.js';

const now = new Date('2026-10-07T00:00:00.000Z');

function limitRow(price: string): Record<string, unknown> {
  return {
    orderId: '9',
    orderLinkId: 'abc',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    price,
    qty: '1',
    cumExecQty: '0',
    avgPrice: '0',
    orderStatus: 'New',
    createdTime: '1',
  };
}

describe('mapBybitSpotOrder limit price of zero', () => {
  it('stores a limit price of exactly 0 as null', () => {
    expect(mapBybitSpotOrder(limitRow('0'), 'BTC/USDT', now).price).toBeNull();
  });

  it('stores a limit price of 0.00 as null, not a zero scaled amount', () => {
    const price = mapBybitSpotOrder(limitRow('0.00'), 'BTC/USDT', now).price;
    expect(price).toBeNull();
    expect(price).not.toBe(0n);
  });

  it('keeps a limit price of 1.00 as a positive scaled amount', () => {
    const price = mapBybitSpotOrder(limitRow('1.00'), 'BTC/USDT', now).price;
    expect(price).not.toBeNull();
    expect(price).toBeGreaterThan(0n);
    expect(formatAmount(price!)).toBe('1');
  });
});

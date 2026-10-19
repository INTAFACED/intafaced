import { describe, expect, it } from 'vitest';
import { parseAmount as A } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import type { EngineOrder } from './types.js';

const o = (x: Record<string, unknown>) => x as unknown as EngineOrder;
const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const lim = (i: number, acct: string, side: 'buy' | 'sell', qty: string, price: string) =>
  o({ orderId: id(i), accountId: acct, type: 'limit', side, qty: A(qty), price: A(price), stopPrice: null, tif: 'GTC' });

describe('OrderBook.clone', () => {
  it('keeps the previous print and the mark and index prices that toState drops', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(lim(1, 'mm', 'sell', '1', '100'));
    book.submit(lim(2, 'tk', 'buy', '1', '100'));
    book.submit(lim(3, 'mm', 'sell', '1', '101'));
    book.submit(lim(4, 'tk', 'buy', '1', '101'));
    book.applyTriggerReference('mark', A('105'));
    book.applyTriggerReference('index', A('106'));
    const copy = book.clone() as unknown as Record<string, unknown>;
    const live = book as unknown as Record<string, unknown>;
    expect(copy.previousTradePrice).toBe(live.previousTradePrice);
    expect(copy.previousTradePrice).toBe(A('100'));
    expect(copy.markPrice).toBe(A('105'));
    expect(copy.indexPrice).toBe(A('106'));
    expect(copy.lastTradePrice).toBe(A('101'));
  });

  it('a copy is independent of the live book', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(lim(1, 'mm', 'sell', '1', '100'));
    const copy = book.clone();
    copy.submit(lim(2, 'tk', 'buy', '1', '100'));
    expect(book.toState().asks).toHaveLength(1);
    expect(copy.toState().asks).toHaveLength(0);
  });
});

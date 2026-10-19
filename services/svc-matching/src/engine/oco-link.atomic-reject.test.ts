import { describe, expect, it } from 'vitest';
import { parseAmount as A } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { installOcoLink } from './oco-link.js';
import type { EngineOrder } from './types.js';

installOcoLink(OrderBook);
const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const o = (x: Record<string, unknown>) => x as unknown as EngineOrder;
const lim = (i: number, acct: string, side: 'buy' | 'sell', qty: string, price: string) =>
  o({ orderId: id(i), accountId: acct, type: 'limit', side, qty: A(qty), price: A(price), stopPrice: null, tif: 'GTC' });

describe('L287 linked OCO submit is atomic', () => {
  it('a rejected take-profit leg must not leave the stop leg executed', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(lim(1, 'mm', 'sell', '1', '100'));
    book.submit(lim(2, 'tk', 'buy', '1', '100')); // last trade 100
    book.submit(lim(3, 'mm', 'buy', '1', '99'));
    const r = book.submit(
      o({
        orderId: id(4),
        accountId: 'desk',
        type: 'limit',
        side: 'sell',
        qty: A('1'),
        price: A('99'),
        stopPrice: null,
        tif: 'FOK',
        oco: true,
        takeProfit: A('99'),
        stopLoss: A('100'),
        takeProfitOrderId: id(5),
        stopLossOrderId: id(6),
      }),
    );
    const executed = r.fills.length + r.triggered.reduce((n, t) => n + t.fills.length, 0);
    expect(r.accepted === false && executed > 0).toBe(false);
  });
});

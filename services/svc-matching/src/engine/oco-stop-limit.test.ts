import { describe, expect, it } from 'vitest';
import { parseAmount as A } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { installOcoCancel } from './oco-cancel.js';
import { installOcoLink } from './oco-link.js';
import { replay, toWire } from './journal.js';
import { encode } from './journal-codec.js';
import { decodeAll } from './journal-io.js';
import type { JournalRecord } from './journal.js';
import type { EngineOrder } from './types.js';

/**
 * A buy-side OCO is only fundable if its stop leg has a worst price. A market stop pays whatever the book offers
 * once it triggers; a stop-limit leg cannot pay more than its limit.
 */
installOcoCancel(OrderBook);
installOcoLink(OrderBook);

const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEAR = '11111111-1111-4111-8111-111111111111';
const FAR = '22222222-2222-4222-8222-222222222222';
const PRINT = '44444444-4444-4444-8444-444444444444';

const limit = (id: string, side: 'buy' | 'sell', qty: string, price: string, account: string): EngineOrder =>
  ({ orderId: id, accountId: account, type: 'limit', side, qty: A(qty), price: A(price), stopPrice: null, tif: 'GTC' }) as EngineOrder;

const buyOco = (extra: Record<string, unknown>): EngineOrder =>
  ({
    orderId: PARENT,
    accountId: 'desk',
    type: 'limit',
    side: 'buy',
    qty: A('1'),
    price: A('100'),
    stopPrice: null,
    tif: 'GTC',
    oco: true,
    takeProfit: A('100'),
    stopLoss: A('120'),
    ...extra,
  }) as unknown as EngineOrder;

/** Asks: 0.1 at 121 (the print that triggers the stop) and 1 at 130 (the thin liquidity behind it). */
function seeded(): OrderBook {
  const book = new OrderBook('BTC/USDT');
  book.submit(limit(NEAR, 'sell', '0.1', '121', 'mm'));
  book.submit(limit(FAR, 'sell', '1', '130', 'mm'));
  return book;
}
const trigger = (book: OrderBook) => book.submit(limit(PRINT, 'buy', '0.1', '121', 'taker'));

describe('OCO stop-loss limit', () => {
  it('rests the stop leg as a stop-limit with the caller limit price', () => {
    const book = seeded();
    const placed = book.submit(buyOco({ stopLossLimit: A('125') }));
    expect(placed.accepted).toBe(true);
    const stop = book.toState().stops.find((s) => s.orderId === `${PARENT}:sl`);
    expect(stop).toMatchObject({ type: 'stop_limit', stopPrice: '120', price: '125' });
  });

  it('a triggered stop-limit buy never pays above its limit, where a market stop pays the thin book at 130', () => {
    const bounded = seeded();
    bounded.submit(buyOco({ stopLossLimit: A('125') }));
    const boundedOut = trigger(bounded);
    const boundedFills = [...boundedOut.fills, ...boundedOut.triggered.flatMap((t) => t.fills ?? [])];
    expect(boundedFills.filter((f) => f.takerOrderId === `${PARENT}:sl`)).toHaveLength(0);
    // the far ask is untouched and the stop leg now rests as a bid at its limit
    expect(bounded.toState().asks.flatMap((l) => l.orders.map((o) => o.orderId))).toContain(FAR);
    expect(bounded.toState().bids.flatMap((l) => l.orders.map((o) => o.orderId))).toContain(`${PARENT}:sl`);

    const market = seeded();
    market.submit(buyOco({}));
    const marketOut = trigger(market);
    const marketFills = [...marketOut.fills, ...marketOut.triggered.flatMap((t) => t.fills ?? [])];
    expect(marketFills.some((f) => f.takerOrderId === `${PARENT}:sl` && f.price === A('130'))).toBe(true);
  });

  it('the stop-loss limit survives the journal: replay and the on-disk codec rest the same stop-limit', () => {
    const records: JournalRecord[] = [
      { kind: 'submit', marketId: 'BTC/USDT', at: '2026-10-19T08:00:00.000Z', seq: 1, order: toWire(buyOco({ stopLossLimit: A('125') })) },
    ];
    const onDisk = decodeAll(records.map(encode).join('\n'));
    for (const tape of [records, onDisk]) {
      const book = replay(tape).get('BTC/USDT')!;
      expect(book.toState().stops.find((s) => s.orderId === `${PARENT}:sl`)).toMatchObject({ type: 'stop_limit', price: '125' });
    }
  });
});

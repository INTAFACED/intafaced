import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { MemoryJournal, replay, toWire } from './journal.js';
import type { EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';

/**
 * Rest a reduce-only. Refuse if it would increase the position.
 * No invented mark — position is net fills on this book.
 */

const A = parseAmount;

const OPEN = '11111111-1111-4111-8111-111111111111';
const LIQ = '22222222-2222-4222-8222-222222222222';
const RO = '33333333-3333-4333-8333-333333333333';
const FLAT = '44444444-4444-4444-8444-444444444444';
const CLOSE = '55555555-5555-4555-8555-555555555555';
const TAKER = '66666666-6666-4666-8666-666666666666';

function order(spec: {
  id: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  tif?: TimeInForce;
  reduceOnly?: boolean;
}): EngineOrder {
  const type = spec.type ?? (spec.price === undefined ? 'market' : 'limit');
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type,
    side: spec.side,
    qty: A(spec.qty),
    price: spec.price === undefined ? null : A(spec.price),
    stopPrice: null,
    tif: spec.tif ?? 'GTC',
    ...(spec.reduceOnly ? { reduceOnly: true } : {}),
  };
}

function liveIds(book: OrderBook): string[] {
  const state = book.toState();
  const ids = [
    ...state.bids.flatMap((l) => l.orders.map((o) => o.orderId)),
    ...state.asks.flatMap((l) => l.orders.map((o) => o.orderId)),
    ...state.stops.map((s) => s.orderId),
  ];
  return ids.sort();
}

/** Desk buys 2 from mm at 100 — desk is long 2. Position is fills, not a mark. */
function openLong(book: OrderBook): void {
  book.submit(order({ id: LIQ, account: 'mm', side: 'sell', qty: '2', price: '100' }));
  const fill = book.submit(order({ id: OPEN, side: 'buy', qty: '2', price: '100' }));
  expect(fill.accepted).toBe(true);
  expect(fill.fills).toHaveLength(1);
  expect(book.toState().positions).toEqual([
    { accountId: 'desk', qty: '2' },
    { accountId: 'mm', qty: '-2' },
  ]);
}

describe('reduce-only — rest if it shrinks the position', () => {
  it('rests a reduce-only sell against a long — no invented mark', () => {
    const book = new OrderBook('BTC/USDT');
    openLong(book);
    const result = book.submit(order({ id: RO, side: 'sell', qty: '1', price: '101', reduceOnly: true }));

    expect(result.accepted).toBe(true);
    expect(result.resting?.kind).toBe('book');
    expect(formatAmount(result.resting!.remaining)).toBe('1');
    expect(book.toState().asks[0]!.orders[0]!.reduceOnly).toBe(true);
    expect(liveIds(book)).toEqual([RO]);
  });

  it('refuses a reduce-only buy on a long — that would increase', () => {
    const book = new OrderBook('BTC/USDT');
    openLong(book);
    const result = book.submit(order({ id: RO, side: 'buy', qty: '1', price: '99', reduceOnly: true }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('would_increase_position');
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([]);
  });

  it('refuses a flat account — opening is an increase', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: RO, account: 'stranger', side: 'sell', qty: '1', price: '101', reduceOnly: true }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('would_increase_position');
    expect(book.currentSequence).toBe(0);
  });

  it('refuses a qty larger than the position — flip would increase the other side', () => {
    const book = new OrderBook('BTC/USDT');
    openLong(book);
    const result = book.submit(order({ id: RO, side: 'sell', qty: '3', price: '101', reduceOnly: true }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('would_increase_position');
    expect(liveIds(book)).toEqual([]);
  });

  it('a later fill that closes the long pulls the resting reduce-only', () => {
    const book = new OrderBook('BTC/USDT');
    openLong(book);
    book.submit(order({ id: RO, side: 'sell', qty: '1', price: '101', reduceOnly: true }));
    book.submit(order({ id: FLAT, account: 'mm', side: 'buy', qty: '2', price: '99' }));
    const close = book.submit(order({ id: CLOSE, side: 'sell', qty: '2', price: '99' }));

    expect(close.accepted).toBe(true);
    expect(close.cancellations.map((c) => [c.orderId, c.reason])).toEqual([[RO, 'would_increase_position']]);
    expect(liveIds(book)).toEqual([]);
    expect(book.toState().positions).toBeUndefined();
  });

  it('GTC without reduceOnly never grows a reduceOnly flag', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    expect(book.toState().asks[0]!.orders[0]!.reduceOnly).toBeUndefined();
    expect(book.toState().positions).toBeUndefined();
  });

  it('journal replay rebuilds the rest and the fill-derived position', () => {
    const marketId = 'BTC/USDT';
    const journal = new MemoryJournal();
    const live = new OrderBook(marketId);

    const liq = order({ id: LIQ, account: 'mm', side: 'sell', qty: '2', price: '100' });
    const open = order({ id: OPEN, side: 'buy', qty: '2', price: '100' });
    const rest = order({ id: RO, side: 'sell', qty: '1', price: '101', reduceOnly: true });

    for (const o of [liq, open, rest]) {
      journal.append({ kind: 'submit', marketId, at: '2026-08-25T12:00:00.000Z', order: toWire(o) });
      live.submit(o);
    }

    const restored = replay(journal.read()).get(marketId)!;
    expect(restored.serialize()).toBe(live.serialize());
    expect(liveIds(restored)).toEqual([RO]);
    expect(restored.toState().positions).toEqual([
      { accountId: 'desk', qty: '2' },
      { accountId: 'mm', qty: '-2' },
    ]);
    expect(restored.toState().asks[0]!.orders[0]!.reduceOnly).toBe(true);
  });
});

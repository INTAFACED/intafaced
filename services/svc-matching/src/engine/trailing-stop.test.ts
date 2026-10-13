import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { MemoryJournal, replay, toWire } from './journal.js';
import type { EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';
import {
  MARK_MISSING,
  TRAIL_MISSING,
  applyMark,
  installTrailingStop,
  markRefuse,
  ratchetPeak,
  readMark,
  readTrail,
  trailRefuse,
  walkStop,
  wantsTrailing,
} from './trailing-stop.js';

installTrailingStop(OrderBook);

/**
 * Rest a trailing stop. The stop walks with the mark.
 * Refuse if trail is missing. No invented mark.
 */

const A = parseAmount;

const TS = '11111111-1111-4111-8111-111111111111';
const MM = '22222222-2222-4222-8222-222222222222';
const TAKE = '33333333-3333-4333-8333-333333333333';
const MISS = '44444444-4444-4444-8444-444444444444';
const PLAIN = '55555555-5555-4555-8555-555555555555';

function order(spec: {
  id: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  stopPx?: string | null;
  trail?: string | null;
  mark?: string | null;
  tif?: TimeInForce;
}): EngineOrder {
  const type = spec.type ?? (spec.trail !== undefined ? 'stop' : spec.price !== undefined ? 'limit' : 'market');
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type,
    side: spec.side,
    qty: A(spec.qty),
    price: spec.price === undefined ? null : A(spec.price),
    stopPrice: spec.stopPx === undefined || spec.stopPx == null ? null : A(spec.stopPx),
    tif: spec.tif ?? 'GTC',
    ...(spec.trail !== undefined ? { trail: spec.trail == null ? null : A(spec.trail) } : {}),
    ...(spec.mark !== undefined ? { mark: spec.mark == null ? null : A(spec.mark) } : {}),
  };
}

describe('trailing stop — walks with the mark', () => {
  it('rests a sell trail off the public book at mark minus trail', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: TS, type: 'stop', side: 'sell', qty: '2', trail: '5', mark: '100' }));

    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ kind: 'stop', orderId: TS });
    expect(result.fills).toHaveLength(0);
    expect(book.depth(50).bids).toEqual([]);
    expect(book.depth(50).asks).toEqual([]);
    expect(book.toState().stops).toHaveLength(1);
    expect(book.toState().stops[0]!.stopPrice).toBe('95');
  });

  it('refuses a missing trail — no invented distance', () => {
    const book = new OrderBook('BTC/USDT');
    for (const trail of [null, '0'] as const) {
      const result = book.submit(order({ id: MISS, type: 'stop', side: 'sell', qty: '2', trail, mark: '100' }));
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(TRAIL_MISSING);
      expect(result.resting).toBeNull();
    }
    expect(book.toState().stops).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([]);
  });

  it('refuses a missing mark — no invented mark', () => {
    const book = new OrderBook('BTC/USDT');
    for (const mark of [null, '0'] as const) {
      const result = book.submit(order({ id: MISS, type: 'stop', side: 'sell', qty: '2', trail: '5', mark }));
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(MARK_MISSING);
      expect(result.resting).toBeNull();
    }
    const omitted = book.submit(order({ id: MISS, type: 'stop', side: 'sell', qty: '2', trail: '5' }));
    expect(omitted.accepted).toBe(false);
    expect(omitted.rejected?.code).toBe(MARK_MISSING);
    expect(book.toState().stops).toHaveLength(0);
  });

  it('walks a sell stop with a better mark and does not walk back', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: TS, type: 'stop', side: 'sell', qty: '2', trail: '5', mark: '100' }));
    expect(book.toState().stops[0]!.stopPrice).toBe('95');

    expect(applyMark(book, A('110')).refused).toBeNull();
    expect(book.toState().stops[0]!.stopPrice).toBe('105');

    expect(applyMark(book, A('108')).refused).toBeNull();
    expect(book.toState().stops[0]!.stopPrice).toBe('105');
  });

  it('a print that reaches the walked stop triggers it', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: TS, type: 'stop', side: 'sell', qty: '2', trail: '5', mark: '100' }));
    applyMark(book, A('110'));
    expect(book.toState().stops[0]!.stopPrice).toBe('105');

    book.submit(order({ id: MM, account: 'mm', type: 'limit', side: 'buy', qty: '2', price: '100' }));
    const trigger = book.submit(order({ id: TAKE, account: 'taker', type: 'market', side: 'sell', qty: '1' }));
    expect(trigger.triggered).toHaveLength(1);
    expect(trigger.triggered[0]!.orderId).toBe(TS);
    expect(book.toState().stops).toHaveLength(0);
  });

  it('a plain limit and a plain stop without trail stay unchanged', () => {
    const book = new OrderBook('BTC/USDT');
    const limit = book.submit(order({ id: PLAIN, type: 'limit', side: 'buy', qty: '2', price: '99' }));
    expect(limit.accepted).toBe(true);
    expect(limit.resting).toMatchObject({ kind: 'book', orderId: PLAIN });
    expect(book.depth(50).bids).toEqual([['99', '2']]);

    const stop = book.submit(order({ id: TS, type: 'stop', side: 'sell', qty: '2', stopPx: '90' }));
    expect(stop.accepted).toBe(true);
    expect(stop.resting).toMatchObject({ kind: 'stop', orderId: TS });
    expect(book.toState().stops[0]!.stopPrice).toBe('90');
    expect(wantsTrailing(stop.resting ? { type: 'stop' } : { type: 'stop' })).toBe(false);
  });

  it('a journaled trailing stop walks after restore, and a tighter stopPrice is not loosened', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: TS, type: 'stop', side: 'sell', qty: '2', trail: '5', mark: '100' }));
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '95', trail: '5', peak: '100' });
    expect(typeof book.toState().stops[0]!.trail).toBe('string');
    expect(typeof book.toState().stops[0]!.peak).toBe('string');

    const tightened = book.amend({ orderId: TS, expectedVersion: 1, stopPrice: A('98') });
    expect(tightened.accepted).toBe(true);
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '98', trail: '5', peak: '100', version: 2 });

    expect(applyMark(book, A('100')).refused).toBeNull();
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '98', peak: '100', version: 2 });

    expect(applyMark(book, A('99')).refused).toBeNull();
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '98', peak: '100', version: 2 });

    expect(applyMark(book, A('102')).refused).toBeNull();
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '98', peak: '102', trail: '5', version: 2 });

    expect(applyMark(book, A('110')).refused).toBeNull();
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '105', peak: '110', trail: '5' });
    expect(book.depth(50).asks).toEqual([]);
    expect(book.depth(50).bids).toEqual([]);

    const restored = OrderBook.fromState(JSON.parse(book.serialize()) as ReturnType<OrderBook['toState']>);
    expect(restored.toState().stops[0]).toMatchObject({ stopPrice: '105', trail: '5', peak: '110' });
    expect(applyMark(restored, A('120')).refused).toBeNull();
    expect(restored.toState().stops[0]).toMatchObject({ stopPrice: '115', peak: '120', trail: '5' });
    expect(applyMark(restored, A('118')).refused).toBeNull();
    expect(restored.toState().stops[0]).toMatchObject({ stopPrice: '115', peak: '120' });
    expect(restored.depth(50).asks).toEqual([]);

    const buy = new OrderBook('ETH/USDT');
    buy.submit(order({ id: TS, type: 'stop', side: 'buy', qty: '1', trail: '5', mark: '100' }));
    expect(buy.toState().stops[0]).toMatchObject({ stopPrice: '105', trail: '5', peak: '100' });
    expect(buy.amend({ orderId: TS, expectedVersion: 1, stopPrice: A('102') }).accepted).toBe(true);
    expect(applyMark(buy, A('100')).refused).toBeNull();
    expect(buy.toState().stops[0]).toMatchObject({ stopPrice: '102', peak: '100', trail: '5' });
    expect(applyMark(buy, A('101')).refused).toBeNull();
    expect(buy.toState().stops[0]).toMatchObject({ stopPrice: '102', peak: '100' });

    const buyRestored = OrderBook.fromState(JSON.parse(buy.serialize()) as ReturnType<OrderBook['toState']>);
    expect(applyMark(buyRestored, A('90')).refused).toBeNull();
    expect(buyRestored.toState().stops[0]).toMatchObject({ stopPrice: '95', peak: '90', trail: '5' });
    expect(applyMark(buyRestored, A('92')).refused).toBeNull();
    expect(buyRestored.toState().stops[0]).toMatchObject({ stopPrice: '95', peak: '90' });
  });

  it('a refused trail amend keeps the previous peak and stopPrice', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: MM, account: 'mm', type: 'limit', side: 'sell', qty: '1', price: '100' }));
    book.submit(order({ id: TAKE, account: 'taker', type: 'limit', side: 'buy', qty: '1', price: '100' }));
    expect(formatAmount(book.lastPrice!)).toBe('100');

    const rested = book.submit(order({ id: TS, type: 'stop', side: 'sell', qty: '2', trail: '5', mark: '100', tif: 'FOK' }));
    expect(rested.accepted).toBe(true);
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '95', trail: '5', peak: '100', tif: 'FOK', version: 1 });

    expect(applyMark(book, A('110')).refused).toBeNull();
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '95', peak: '100', version: 1 });
    expect(book.toState().stops).toHaveLength(1);

    expect(applyMark(book, A('104')).refused).toBeNull();
    expect(book.toState().stops[0]).toMatchObject({ stopPrice: '99', peak: '104', trail: '5' });
  });

  it('journal replay keeps a trailing rest off the public book at the same stop', () => {
    const marketId = 'BTC/USDT';
    const journal = new MemoryJournal();
    const live = new OrderBook(marketId);
    const ts = order({ id: TS, type: 'stop', side: 'sell', qty: '2', trail: '5', mark: '100' });
    journal.append({ kind: 'submit', marketId, at: '2026-08-25T16:00:00.000Z', order: toWire(ts) });
    live.submit(ts);
    const restored = replay(journal.read()).get(marketId)!;
    expect(restored.serialize()).toBe(live.serialize());
    expect(restored.depth(50).asks).toEqual([]);
    expect(restored.toState().stops[0]!.stopPrice).toBe('95');
  });

  it('helpers refuse a missing trail or mark and walk only with the extreme', () => {
    expect(trailRefuse(null)?.code).toBe(TRAIL_MISSING);
    expect(trailRefuse(A('0'))?.code).toBe(TRAIL_MISSING);
    expect(trailRefuse(A('5'))).toBeNull();
    expect(markRefuse(null)?.code).toBe(MARK_MISSING);
    expect(markRefuse(A('0'))?.code).toBe(MARK_MISSING);
    expect(markRefuse(A('100'))).toBeNull();
    expect(wantsTrailing({ trail: A('5') })).toBe(true);
    expect(wantsTrailing({ type: 'stop' })).toBe(false);
    expect(formatAmount(readTrail({ trail: A('5') })!)).toBe('5');
    expect(formatAmount(readMark({ mark: A('100') })!)).toBe('100');
    expect(formatAmount(ratchetPeak('sell', A('100'), A('110')))).toBe('110');
    expect(formatAmount(ratchetPeak('sell', A('110'), A('108')))).toBe('110');
    expect(formatAmount(ratchetPeak('buy', A('100'), A('90')))).toBe('90');
    expect(formatAmount(ratchetPeak('buy', A('90'), A('95')))).toBe('90');
    expect(formatAmount(walkStop('sell', A('100'), A('5'))!)).toBe('95');
    expect(formatAmount(walkStop('buy', A('100'), A('5'))!)).toBe('105');
    expect(walkStop('sell', A('5'), A('5'))).toBeNull();
  });
});

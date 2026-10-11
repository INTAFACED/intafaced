import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import type { EngineAmend, EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';
import { EXPIRY_DISAGREES, EXPIRY_MISSING, PRICE_MISSING, STRIKE_DISAGREES, STRIKE_MISSING, installOption } from './option.js';

installOption(OrderBook);

/**
 * Amend price on a resting option.
 * Refuse if strike, expiry, or price is missing. No invented mark.
 */

const A = parseAmount;

const OPT = '11111111-1111-4111-8111-111111111111';
const TAKE = '22222222-2222-4222-8222-222222222222';
const ASK2 = '33333333-3333-4333-8333-333333333333';
const MISS = '44444444-4444-4444-8444-444444444444';
const PLAIN = '55555555-5555-4555-8555-555555555555';
const EXER = '66666666-6666-4666-8666-666666666666';
const EXER2 = '77777777-7777-4777-8777-777777777777';
const EXPIRY = '2026-12-31T00:00:00.000Z';
const OTHER = '2026-06-30T00:00:00.000Z';

function order(spec: {
  id: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  mark?: string | null;
  strike?: string | null;
  expiry?: string | null;
  exercise?: boolean;
  tif?: TimeInForce;
}): EngineOrder {
  const type = spec.type ?? (spec.price !== undefined ? 'limit' : 'market');
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type,
    side: spec.side,
    qty: A(spec.qty),
    price: spec.price === undefined ? null : A(spec.price),
    stopPrice: null,
    tif: spec.tif ?? 'GTC',
    ...(spec.mark !== undefined ? { mark: spec.mark == null ? null : A(spec.mark) } : {}),
    ...(spec.strike !== undefined ? { strike: spec.strike == null ? null : A(spec.strike) } : {}),
    ...(spec.expiry !== undefined ? { expiry: spec.expiry } : {}),
    ...(spec.exercise === true ? { exercise: true } : {}),
  } as EngineOrder;
}

function patch(
  rest: { orderId: string; version: number },
  extra: {
    strike?: string | null;
    expiry?: string | null;
    price?: string | null;
    mark?: string | null;
  },
): EngineAmend {
  return {
    orderId: rest.orderId,
    expectedVersion: rest.version,
    ...(extra.price !== undefined ? { price: extra.price == null ? null : A(extra.price) } : {}),
    ...(extra.strike !== undefined ? { strike: extra.strike == null ? null : A(extra.strike) } : {}),
    ...(extra.expiry !== undefined ? { expiry: extra.expiry } : {}),
    ...(extra.mark !== undefined ? { mark: extra.mark == null ? null : A(extra.mark) } : {}),
  } as EngineAmend;
}

describe('option — amend price on a rest', () => {
  it('moves the rest to the new price — remainder stays, mark is not used', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    expect(rest.accepted).toBe(true);
    expect(book.depth(50).bids).toEqual([['99', '2']]);

    const amended = book.amend(patch({ orderId: OPT, version: rest.resting!.version }, { strike: '100', expiry: EXPIRY, price: '101' }));
    expect(amended.accepted).toBe(true);
    expect(amended.rejected).toBeUndefined();
    expect(formatAmount(amended.resting!.price)).toBe('101');
    expect(formatAmount(amended.resting!.remaining)).toBe('2');
    expect(book.depth(50).bids).toEqual([['101', '2']]);
  });

  it('refuses a missing strike — still at the old price, no invented mark', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const amended = book.amend(patch({ orderId: OPT, version: rest.resting!.version }, { expiry: EXPIRY, price: '101' }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(STRIKE_MISSING);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('refuses a missing expiry — still at the old price, no invented mark', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const amended = book.amend(patch({ orderId: OPT, version: rest.resting!.version }, { strike: '100', price: '101' }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(EXPIRY_MISSING);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('refuses a missing price — still at the old price, no invented mark', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const amended = book.amend(patch({ orderId: OPT, version: rest.resting!.version }, { strike: '100', expiry: EXPIRY, price: null }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(PRICE_MISSING);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('refuses a supplied mark — unsupported amend field, rest unchanged', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const amended = book.amend(
      patch({ orderId: OPT, version: rest.resting!.version }, { strike: '100', expiry: EXPIRY, price: '98', mark: '50' }),
    );
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe('amend_field_unsupported');
    expect(amended.rejected?.message).toContain('mark');
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('refuses when strike disagrees — do not amend a different contract', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const amended = book.amend(patch({ orderId: OPT, version: rest.resting!.version }, { strike: '105', expiry: EXPIRY, price: '101' }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('refuses when expiry disagrees — do not amend a different contract', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const amended = book.amend(patch({ orderId: OPT, version: rest.resting!.version }, { strike: '100', expiry: OTHER, price: '101' }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(EXPIRY_DISAGREES);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('refuses when nothing is resting — no invented amend', () => {
    const book = new OrderBook('BTC/USDT');
    const amended = book.amend(patch({ orderId: MISS, version: 1 }, { strike: '100', expiry: EXPIRY, price: '101' }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe('order_not_found');
    expect(book.depth(50).bids).toEqual([]);
  });

  it('refuses an amend that would cross a plain limit — book unchanged', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '101', strike: '100', expiry: EXPIRY }));
    book.submit(order({ id: PLAIN, type: 'limit', side: 'buy', qty: '2', price: '99' }));
    const before = book.currentSequence;
    const amended = book.amend(patch({ orderId: OPT, version: rest.resting!.version }, { strike: '100', expiry: EXPIRY, price: '99' }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(amended.fills).toHaveLength(0);
    expect(book.currentSequence).toBe(before);
    expect(book.depth(50).asks).toEqual([['101', '2']]);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('refuses an amend that would cross a different strike — book unchanged', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '101', strike: '100', expiry: EXPIRY }));
    const bid = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '105', expiry: EXPIRY }));
    const before = book.currentSequence;
    const amended = book.amend(patch({ orderId: TAKE, version: bid.resting!.version }, { strike: '105', expiry: EXPIRY, price: '101' }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(amended.fills).toHaveLength(0);
    expect(book.currentSequence).toBe(before);
    expect(book.depth(50).asks).toEqual([['101', '2']]);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('refuses an amend that would cross a different expiry — book unchanged', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '101', strike: '100', expiry: EXPIRY }));
    const bid = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: OTHER }));
    const before = book.currentSequence;
    const amended = book.amend(patch({ orderId: TAKE, version: bid.resting!.version }, { strike: '100', expiry: OTHER, price: '101' }));
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(EXPIRY_DISAGREES);
    expect(amended.fills).toHaveLength(0);
    expect(book.currentSequence).toBe(before);
    expect(book.depth(50).asks).toEqual([['101', '2']]);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('a non-crossing amend of the same strike and expiry still applies', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: OPT, type: 'limit', side: 'sell', qty: '2', price: '110', strike: '100', expiry: EXPIRY }));
    const bid = book.submit(order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    const amended = book.amend(patch({ orderId: TAKE, version: bid.resting!.version }, { strike: '100', expiry: EXPIRY, price: '101' }));
    expect(amended.accepted).toBe(true);
    expect(amended.fills).toHaveLength(0);
    expect(formatAmount(amended.resting!.price)).toBe('101');
    expect(book.depth(50).bids).toEqual([['101', '2']]);
    expect(book.depth(50).asks).toEqual([['110', '2']]);
    const ex = book.submit(
      order({ id: EXER, account: 'desk', type: 'limit', side: 'buy', qty: '2', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(ex.accepted).toBe(false);
    expect(ex.rejected?.code).toBe('position_flat');
  });

  it('records every amend fill on the option position for that strike and expiry', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: OPT, account: 'writer-a', type: 'limit', side: 'sell', qty: '1', price: '101', strike: '100', expiry: EXPIRY }),
    );
    book.submit(
      order({ id: ASK2, account: 'writer-b', type: 'limit', side: 'sell', qty: '1', price: '102', strike: '100', expiry: EXPIRY }),
    );
    const bid = book.submit(
      order({ id: TAKE, account: 'holder', type: 'limit', side: 'buy', qty: '3', price: '99', strike: '100', expiry: EXPIRY }),
    );
    const amended = book.amend(patch({ orderId: TAKE, version: bid.resting!.version }, { strike: '100', expiry: EXPIRY, price: '102' }));
    expect(amended.accepted).toBe(true);
    expect(amended.fills).toHaveLength(2);
    expect(formatAmount(amended.fills[0]!.qty)).toBe('1');
    expect(formatAmount(amended.fills[0]!.price)).toBe('101');
    expect(formatAmount(amended.fills[1]!.qty)).toBe('1');
    expect(formatAmount(amended.fills[1]!.price)).toBe('102');
    expect(formatAmount(amended.resting!.remaining)).toBe('1');

    const ex = book.submit(
      order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '2', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(ex.accepted).toBe(true);
    expect(ex.fills).toHaveLength(2);
    expect(formatAmount(ex.fills[0]!.qty)).toBe('1');
    expect(formatAmount(ex.fills[0]!.price)).toBe('100');
    expect(formatAmount(ex.fills[1]!.qty)).toBe('1');
    expect(formatAmount(ex.fills[1]!.price)).toBe('100');

    const again = book.submit(
      order({ id: EXER2, account: 'holder', type: 'limit', side: 'buy', qty: '1', strike: '100', expiry: EXPIRY, exercise: true }),
    );
    expect(again.accepted).toBe(false);
    expect(again.rejected?.code).toBe('position_flat');
  });
});

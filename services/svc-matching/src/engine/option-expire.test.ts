import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import type { EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';
import { EXPIRY_MISSING, STRIKE_DISAGREES, installOption } from './option.js';

installOption(OrderBook);

/**
 * Expire a resting option at expiry. Unfilled remainder leaves the book.
 * An incoming option whose expiry is at or before now does not print.
 * A due rest is cancelled before a strike or expiry disagreement returns.
 * Refuse if expiry is missing. No invented mark.
 */

const A = parseAmount;

const OPT = '11111111-1111-4111-8111-111111111111';
const MISS = '44444444-4444-4444-8444-444444444444';
const PLAIN = '55555555-5555-4555-8555-555555555555';
const TAKE = '22222222-2222-4222-8222-222222222222';
const DUE_REST = '66666666-6666-4666-8666-666666666666';
const LIVE = '77777777-7777-4777-8777-777777777777';
const TAKER = '88888888-8888-4888-8888-888888888888';
const EXER = '99999999-9999-4999-8999-999999999999';
const GTD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPIRY = '2026-12-31T00:00:00.000Z';
const SOON = '2026-09-01T00:00:00.000Z';
const BEFORE = new Date('2026-06-01T00:00:00.000Z');
const MID = new Date('2026-10-01T00:00:00.000Z');
const AT = new Date('2026-12-31T00:00:00.000Z');
const AFTER = new Date('2027-01-01T00:00:00.000Z');
const GTD_AT = '2026-09-15T00:00:00.000Z';

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
  tif?: TimeInForce;
  expireAt?: string;
  exercise?: boolean;
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
    ...(spec.expireAt !== undefined ? { expireAt: spec.expireAt } : {}),
    ...(spec.exercise ? { exercise: true } : {}),
  };
}

describe('option — expire a rest at expiry', () => {
  it('unfilled remainder leaves the book at expiry', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }), BEFORE);
    expect(rest.accepted).toBe(true);
    expect(rest.resting).toMatchObject({ kind: 'book', orderId: OPT });
    expect(book.depth(50).bids).toEqual([['99', '2']]);

    const later = book.submit(order({ id: PLAIN, type: 'limit', side: 'sell', qty: '1', price: '101' }), AT);
    expect(later.accepted).toBe(true);
    expect(later.cancellations).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: OPT, reason: 'expired' })]));
    expect(formatAmount(later.cancellations.find((row) => row.orderId === OPT)!.remainingQty)).toBe('2');
    expect(book.depth(50).bids).toEqual([]);
    expect(book.depth(50).asks).toEqual([['101', '1']]);
  });

  it('a rest already past expiry leaves immediately', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }), AFTER);
    expect(rest.accepted).toBe(true);
    expect(rest.resting).toBeNull();
    expect(rest.cancellations).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: OPT, reason: 'expired' })]));
    expect(formatAmount(rest.cancellations.find((row) => row.orderId === OPT)!.remainingQty)).toBe('2');
    expect(book.depth(50).bids).toEqual([]);
  });

  it('partial take then expiry — remaining qty leaves', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
      BEFORE,
    );
    const take = book.submit(
      order({ id: TAKE, account: 'holder', type: 'limit', side: 'buy', qty: '1', price: '99', strike: '100', expiry: EXPIRY }),
      BEFORE,
    );
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);
    expect(book.depth(50).asks).toEqual([['99', '1']]);

    const later = book.submit(order({ id: PLAIN, type: 'limit', side: 'buy', qty: '1', price: '90' }), AT);
    expect(later.cancellations).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: OPT, reason: 'expired' })]));
    expect(formatAmount(later.cancellations.find((row) => row.orderId === OPT)!.remainingQty)).toBe('1');
    expect(book.depth(50).asks).toEqual([]);
  });

  it('refuses a missing expiry — no invented expiry from a mark', () => {
    const book = new OrderBook('BTC/USDT');
    for (const expiry of [null, '', '   '] as const) {
      const result = book.submit(
        order({
          id: MISS,
          type: 'limit',
          side: 'buy',
          qty: '2',
          price: '99',
          strike: '100',
          expiry,
          mark: '50',
        }),
        AFTER,
      );
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(EXPIRY_MISSING);
      expect(result.resting).toBeNull();
      expect(result.cancellations).toHaveLength(0);
    }
    expect(book.depth(50).bids).toEqual([]);
  });

  it('a supplied mark is not an expiry — rest stays until expiry', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(
      order({
        id: OPT,
        type: 'limit',
        side: 'buy',
        qty: '2',
        price: '99',
        strike: '100',
        expiry: EXPIRY,
        mark: '50',
      }),
      BEFORE,
    );
    expect(rest.accepted).toBe(true);
    expect(rest.resting).toMatchObject({ kind: 'book', orderId: OPT });
    expect(rest.cancellations).toHaveLength(0);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });

  it('a due option taker does not print', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: DUE_REST, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '98', strike: '100', expiry: SOON }),
      BEFORE,
    );
    book.submit(
      order({
        id: GTD,
        account: 'maker',
        type: 'limit',
        side: 'sell',
        qty: '1',
        price: '97',
        tif: 'GTD',
        expireAt: GTD_AT,
      }),
      BEFORE,
    );
    const live = book.submit(
      order({ id: LIVE, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
      BEFORE,
    );
    expect(live.accepted).toBe(true);
    expect(live.resting).toMatchObject({ kind: 'book', orderId: LIVE });

    const take = book.submit(
      order({ id: TAKER, account: 'holder', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: SOON }),
      MID,
    );
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(0);
    expect(take.resting).toBeNull();
    expect(take.cancellations.map((row) => [row.orderId, row.reason])).toEqual([
      [DUE_REST, 'expired'],
      [GTD, 'expired'],
      [TAKER, 'expired'],
    ]);
    expect(formatAmount(take.cancellations.find((row) => row.orderId === TAKER)!.remainingQty)).toBe('2');
    expect(book.depth(50).asks).toEqual([['99', '2']]);
    expect(book.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([LIVE]);
    expect(book.toState().positions ?? []).toEqual([]);

    const ex = book.submit(
      order({ id: EXER, account: 'holder', type: 'limit', side: 'buy', qty: '2', strike: '100', expiry: SOON, exercise: true }),
      MID,
    );
    expect(ex.accepted).toBe(false);
    expect(ex.rejected?.code).toBe('position_flat');
    expect(ex.fills).toHaveLength(0);
    expect(book.depth(50).asks).toEqual([['99', '2']]);

    const at = new OrderBook('BTC/USDT');
    at.submit(
      order({ id: LIVE, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '100', expiry: EXPIRY }),
      BEFORE,
    );
    const exact = at.submit(
      order({ id: TAKER, account: 'holder', type: 'limit', side: 'buy', qty: '1', price: '99', strike: '100', expiry: EXPIRY }),
      AT,
    );
    expect(exact.fills).toHaveLength(0);
    expect(exact.resting).toBeNull();
    expect(exact.cancellations.map((row) => [row.orderId, row.reason])).toEqual([
      [LIVE, 'expired'],
      [TAKER, 'expired'],
    ]);
    expect(at.depth(50).asks).toEqual([]);
    expect(at.toState().positions ?? []).toEqual([]);
  });

  it('an option that is not yet due still prints', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: OPT, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
      BEFORE,
    );
    const take = book.submit(
      order({ id: TAKE, account: 'holder', type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }),
      BEFORE,
    );
    expect(take.accepted).toBe(true);
    expect(take.fills).toHaveLength(1);
    expect(take.fills[0]).toMatchObject({ makerOrderId: OPT, takerOrderId: TAKE });
    expect(formatAmount(take.fills[0]!.qty)).toBe('2');
    expect(book.depth(50).asks).toEqual([]);

    const ex = book.submit(
      order({ id: EXER, account: 'holder', type: 'limit', side: 'sell', qty: '2', strike: '100', expiry: EXPIRY, exercise: true }),
      BEFORE,
    );
    expect(ex.accepted).toBe(true);
    expect(ex.fills).toHaveLength(1);
    expect(formatAmount(ex.fills[0]!.price)).toBe('100');
  });

  it('cancels a due rest before a strike or expiry disagreement returns', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: DUE_REST, account: 'writer', type: 'limit', side: 'sell', qty: '2', price: '98', strike: '100', expiry: SOON }),
      BEFORE,
    );
    book.submit(
      order({ id: LIVE, account: 'writer', type: 'limit', side: 'sell', qty: '1', price: '99', strike: '110', expiry: EXPIRY }),
      BEFORE,
    );

    const take = book.submit(
      order({ id: TAKER, account: 'holder', type: 'limit', side: 'buy', qty: '1', price: '99', strike: '105', expiry: EXPIRY }),
      MID,
    );
    expect(take.accepted).toBe(false);
    expect(take.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(take.fills).toHaveLength(0);
    expect(take.cancellations).toEqual([expect.objectContaining({ orderId: DUE_REST, reason: 'expired' })]);
    expect(formatAmount(take.cancellations.find((row) => row.orderId === DUE_REST)!.remainingQty)).toBe('2');
    expect(book.depth(50).asks).toEqual([['99', '1']]);
    expect(book.toState().asks.flatMap((level) => level.orders.map((row) => row.orderId))).toEqual([LIVE]);

    const later = book.submit(
      order({ id: OPT, account: 'holder', type: 'limit', side: 'buy', qty: '1', price: '98', strike: '105', expiry: EXPIRY }),
      MID,
    );
    expect(later.accepted).toBe(true);
    expect(later.fills).toHaveLength(0);
    expect(later.cancellations).toHaveLength(0);
    expect(later.resting).toMatchObject({ kind: 'book', orderId: OPT });
    expect(book.depth(50).bids).toEqual([['98', '1']]);
    expect(book.depth(50).asks).toEqual([['99', '1']]);
    expect([...book.toState().bids, ...book.toState().asks].flatMap((level) => level.orders.map((row) => row.orderId))).toEqual([
      OPT,
      LIVE,
    ]);

    const early = new OrderBook('BTC/USDT');
    early.submit(order({ id: LIVE, type: 'limit', side: 'sell', qty: '2', price: '99', strike: '100', expiry: EXPIRY }), BEFORE);
    const disagree = early.submit(
      order({ id: TAKE, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '105', expiry: EXPIRY }),
      BEFORE,
    );
    expect(disagree.accepted).toBe(false);
    expect(disagree.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(disagree.fills).toHaveLength(0);
    expect(disagree.cancellations).toHaveLength(0);
    expect(early.depth(50).asks).toEqual([['99', '2']]);
    expect(early.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([LIVE]);

    const quiet = new OrderBook('BTC/USDT');
    quiet.submit(order({ id: DUE_REST, type: 'limit', side: 'sell', qty: '2', price: '98', strike: '100', expiry: SOON }));
    const blocked = quiet.submit(order({ id: TAKER, type: 'limit', side: 'buy', qty: '1', price: '99', strike: '105', expiry: EXPIRY }));
    expect(blocked.accepted).toBe(false);
    expect(blocked.rejected?.code).toBe(STRIKE_DISAGREES);
    expect(blocked.cancellations).toHaveLength(0);
    expect(quiet.depth(50).asks).toEqual([['98', '2']]);
    expect(quiet.toState().asks[0]?.orders.map((row) => row.orderId)).toEqual([DUE_REST]);
  });

  it('omitted now does not expire — the engine does not invent a clock', () => {
    const book = new OrderBook('BTC/USDT');
    const rest = book.submit(order({ id: OPT, type: 'limit', side: 'buy', qty: '2', price: '99', strike: '100', expiry: EXPIRY }));
    expect(rest.accepted).toBe(true);
    expect(rest.resting).toMatchObject({ kind: 'book', orderId: OPT });
    const later = book.submit(order({ id: PLAIN, type: 'limit', side: 'sell', qty: '1', price: '101' }));
    expect(later.cancellations).toHaveLength(0);
    expect(book.depth(50).bids).toEqual([['99', '2']]);
  });
});

import { describe, expect, it } from 'vitest';
import { div, formatAmount, mul, parseAmount, sum, type Amount } from '@intafaced/ledger-client/money';
import './engine.js';
import { OrderBook } from './book.js';
import type { EngineOrder, EngineOrderType, OrderSide, SubmitResult, TimeInForce } from './types.js';

/**
 * The order book, adversarially (§5.1, §5.4).
 *
 * Every price and quantity in this file is a decimal string parsed into an
 * `Amount`. If a test ever needs a JS number to express a price, the test is
 * wrong before the code is.
 */

const A = parseAmount;

let ids = 0;
function nextId(prefix = 'ord'): string {
  ids += 1;
  return `${prefix}-${String(ids).padStart(4, '0')}`;
}

interface OrderSpec {
  id?: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  stopPrice?: string;
  tif?: TimeInForce;
  expireAt?: string;
  minQty?: string;
  reduceOnly?: boolean;
  ocoSiblingId?: string;
}

function order(spec: OrderSpec): EngineOrder {
  const type = spec.type ?? (spec.price === undefined ? 'market' : 'limit');
  return {
    orderId: spec.id ?? nextId(),
    accountId: spec.account ?? 'acct-default',
    type,
    side: spec.side,
    qty: A(spec.qty),
    price: spec.price === undefined ? null : A(spec.price),
    stopPrice: spec.stopPrice === undefined ? null : A(spec.stopPrice),
    tif: spec.tif ?? 'GTC',
    ...(spec.expireAt !== undefined ? { expireAt: spec.expireAt } : {}),
    ...(spec.minQty !== undefined ? { minQty: A(spec.minQty) } : {}),
    ...(spec.reduceOnly ? { reduceOnly: true } : {}),
    ...(spec.ocoSiblingId ? { ocoSiblingId: spec.ocoSiblingId } : {}),
  };
}

/** Seed resting liquidity without asserting on it — every helper submit must be accepted. */
function seed(book: OrderBook, spec: OrderSpec): SubmitResult {
  const result = book.submit(order(spec));
  expect(result.accepted, `seed order rejected: ${result.rejected?.code}`).toBe(true);
  return result;
}

const fillPrices = (result: SubmitResult): string[] => result.fills.map((f) => formatAmount(f.price));
const fillQtys = (result: SubmitResult): string[] => result.fills.map((f) => formatAmount(f.qty));

// ── Price-time priority ─────────────────────────────────────────────────────

describe('price-time priority', () => {
  it('fills the earliest order first when prices are equal', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'first', account: 'a', side: 'buy', qty: '1', price: '100' });
    seed(book, { id: 'second', account: 'b', side: 'buy', qty: '1', price: '100' });

    const result = book.submit(order({ account: 'taker', side: 'sell', qty: '1', price: '100' }));

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.makerOrderId).toBe('first');
  });

  it('fills the better price first regardless of arrival order', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'worse', account: 'a', side: 'buy', qty: '1', price: '99' });
    seed(book, { id: 'better', account: 'b', side: 'buy', qty: '1', price: '101' });

    const result = book.submit(order({ account: 'taker', side: 'sell', qty: '2', price: '99' }));

    expect(result.fills.map((f) => f.makerOrderId)).toEqual(['better', 'worse']);
    expect(fillPrices(result)).toEqual(['101', '99']);
  });

  it('ranks the ask side the other way — lowest price is best', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'a', side: 'sell', qty: '1', price: '105' });
    seed(book, { account: 'b', side: 'sell', qty: '1', price: '103' });
    seed(book, { account: 'c', side: 'sell', qty: '1', price: '104' });

    expect(formatAmount(book.bestAsk()!)).toBe('103');
    const result = book.submit(order({ account: 'taker', side: 'buy', qty: '3', price: '105' }));
    expect(fillPrices(result)).toEqual(['103', '104', '105']);
  });

  it('a resting order keeps its place in the queue after a partial fill', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'front', account: 'a', side: 'sell', qty: '5', price: '100' });
    seed(book, { id: 'back', account: 'b', side: 'sell', qty: '5', price: '100' });

    book.submit(order({ account: 'taker', side: 'buy', qty: '2', price: '100' }));
    const second = book.submit(order({ account: 'taker2', side: 'buy', qty: '4', price: '100' }));

    // 3 left on `front` before `back` gets anything.
    expect(second.fills.map((f) => f.makerOrderId)).toEqual(['front', 'back']);
    expect(fillQtys(second)).toEqual(['3', '1']);
  });
});

// ── Resting, partials, and levels ───────────────────────────────────────────

describe('resting and partial fills', () => {
  it('rests a non-crossing limit order and reports it', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: 'maker', account: 'a', side: 'buy', qty: '2.5', price: '99.5' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(0);
    expect(result.resting).toMatchObject({ kind: 'book', orderId: 'maker' });
    expect(formatAmount(result.resting!.remaining)).toBe('2.5');
    expect(formatAmount(book.bestBid()!)).toBe('99.5');
  });

  it('fills what it can and rests the exact remainder', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'a', side: 'sell', qty: '3', price: '100' });

    const result = book.submit(order({ id: 'taker', account: 'b', side: 'buy', qty: '10', price: '100' }));

    expect(fillQtys(result)).toEqual(['3']);
    expect(formatAmount(result.resting!.remaining)).toBe('7');
    expect(book.bestAsk()).toBeNull();
    expect(formatAmount(book.bestBid()!)).toBe('100');
  });

  it('removes a price level that empties exactly, and the next level becomes best', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'a', side: 'buy', qty: '2', price: '100' });
    seed(book, { account: 'a', side: 'buy', qty: '3', price: '99' });

    const result = book.submit(order({ account: 'taker', side: 'sell', qty: '2', price: '100' }));

    expect(fillQtys(result)).toEqual(['2']);
    expect(formatAmount(book.bestBid()!)).toBe('99');
    // The emptied level must not survive as a zero-quantity ghost in the depth feed.
    expect(book.depth(50).bids).toEqual([['99', '3']]);
  });

  it('empties two levels exactly in one sweep', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'a', side: 'buy', qty: '2', price: '100' });
    seed(book, { account: 'a', side: 'buy', qty: '3', price: '99' });

    const result = book.submit(order({ account: 'taker', side: 'sell', qty: '5', price: '99' }));

    expect(fillQtys(result)).toEqual(['2', '3']);
    expect(book.bestBid()).toBeNull();
    expect(book.depth(50).bids).toEqual([]);
  });

  it('carries 18 decimal places through a fill without losing a unit', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'a', side: 'sell', qty: '0.000000000000000003', price: '0.000000000000000001' });

    const result = book.submit(order({ account: 'b', side: 'buy', qty: '0.000000000000000002', price: '0.000000000000000001' }));

    expect(fillQtys(result)).toEqual(['0.000000000000000002']);
    expect(fillPrices(result)).toEqual(['0.000000000000000001']);
    expect(book.depth(50).asks).toEqual([['0.000000000000000001', '0.000000000000000001']]);
  });
});

// ── Market orders ───────────────────────────────────────────────────────────

describe('market orders', () => {
  it('into an empty book: accepted, nothing filled, whole quantity cancelled', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: 'lonely', account: 'a', side: 'buy', qty: '5' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(0);
    // It never rests — a market order with nothing to take is a cancel, not a quote.
    expect(result.resting).toBeNull();
    expect(result.cancellations).toHaveLength(1);
    expect(result.cancellations[0]!.reason).toBe('market_remainder');
    expect(formatAmount(result.cancellations[0]!.remainingQty)).toBe('5');
    expect(book.depth(50).bids).toEqual([]);
  });

  it('exhausts the book and cancels what it could not take', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '1', price: '100' });
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '101' });

    const result = book.submit(order({ account: 'taker', side: 'buy', qty: '10' }));

    expect(fillQtys(result)).toEqual(['1', '2']);
    expect(formatAmount(result.cancellations[0]!.remainingQty)).toBe('7');
    expect(book.bestAsk()).toBeNull();
  });

  it('crosses multiple levels at each level price, and the weighted average is exact', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '1', price: '100' });
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '101' });
    seed(book, { account: 'mm', side: 'sell', qty: '3', price: '102' });

    const result = book.submit(order({ account: 'taker', side: 'buy', qty: '5' }));

    expect(fillPrices(result)).toEqual(['100', '101', '102']);
    expect(fillQtys(result)).toEqual(['1', '2', '2']);

    const notional: Amount = sum(result.fills.map((f) => mul(f.price, f.qty)));
    const quantity: Amount = sum(result.fills.map((f) => f.qty));
    expect(formatAmount(notional)).toBe('506');
    expect(formatAmount(quantity)).toBe('5');
    // 506 / 5 = 101.2 exactly. A float VWAP here would read 101.19999999999999.
    expect(formatAmount(div(notional, quantity))).toBe('101.2');

    // One unit of depth survives at the top level, untouched.
    expect(book.depth(50).asks).toEqual([['102', '1']]);
  });

  it('ignores GTC on a market order — it can never rest', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ account: 'a', side: 'sell', qty: '1', tif: 'GTC' }));

    expect(result.accepted).toBe(true);
    expect(result.resting).toBeNull();
    expect(result.cancellations[0]!.reason).toBe('market_remainder');
  });
});

// ── Time in force ───────────────────────────────────────────────────────────

describe('time in force', () => {
  it('IOC fills what it can and cancels the remainder rather than resting', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });

    const result = book.submit(order({ id: 'ioc', account: 'taker', side: 'buy', qty: '5', price: '100', tif: 'IOC' }));

    expect(fillQtys(result)).toEqual(['2']);
    expect(result.resting).toBeNull();
    expect(result.cancellations).toHaveLength(1);
    expect(result.cancellations[0]!).toMatchObject({ orderId: 'ioc', reason: 'ioc_remainder' });
    expect(formatAmount(result.cancellations[0]!.remainingQty)).toBe('3');
    expect(book.bestBid()).toBeNull();
  });

  it('IOC that cannot touch the book at all cancels in full', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '105' });

    const result = book.submit(order({ account: 'taker', side: 'buy', qty: '5', price: '100', tif: 'IOC' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(0);
    expect(formatAmount(result.cancellations[0]!.remainingQty)).toBe('5');
  });

  it('FOK rejects entirely when it cannot fill completely — not one unit trades', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });
    const before = book.serialize();

    const result = book.submit(order({ account: 'taker', side: 'buy', qty: '5', price: '100', tif: 'FOK' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('fok_unfillable');
    expect(result.fills).toHaveLength(0);
    expect(result.cancellations).toHaveLength(0);
    // The rejection must be invisible in the book — including in the sequence counter.
    expect(book.serialize()).toBe(before);
  });

  it('FOK fills completely when the depth is there, across levels', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });
    seed(book, { account: 'mm', side: 'sell', qty: '3', price: '101' });

    const result = book.submit(order({ account: 'taker', side: 'buy', qty: '5', price: '101', tif: 'FOK' }));

    expect(result.accepted).toBe(true);
    expect(fillQtys(result)).toEqual(['2', '3']);
    expect(result.resting).toBeNull();
    expect(result.cancellations).toHaveLength(0);
  });

  it('FOK respects its limit price when deciding it cannot fill', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });
    seed(book, { account: 'mm', side: 'sell', qty: '3', price: '101' });

    const result = book.submit(order({ account: 'taker', side: 'buy', qty: '5', price: '100', tif: 'FOK' }));

    expect(result.rejected?.code).toBe('fok_unfillable');
  });

  it('post-only that would cross is rejected and never fills', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });
    const before = book.serialize();

    const result = book.submit(order({ account: 'taker', side: 'buy', qty: '1', price: '100', tif: 'PO' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('post_only_would_cross');
    expect(result.fills).toHaveLength(0);
    expect(result.resting).toBeNull();
    expect(book.serialize()).toBe(before);
  });

  it('post-only rests when it stays behind the spread', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });

    const result = book.submit(order({ id: 'po', account: 'taker', side: 'buy', qty: '1', price: '99.99', tif: 'PO' }));

    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ orderId: 'po', kind: 'book' });
    expect(formatAmount(book.bestBid()!)).toBe('99.99');
  });

  it('post-only on an order that cannot rest is refused rather than reinterpreted', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ account: 'a', side: 'buy', qty: '1', tif: 'PO' }));
    expect(result.rejected?.code).toBe('invalid_tif');
  });
});

// ── Self-trade prevention ───────────────────────────────────────────────────

describe('self-trade prevention', () => {
  it('never lets one account be both sides of a fill', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'own', account: 'same', side: 'buy', qty: '1', price: '100' });

    const result = book.submit(order({ id: 'aggressor', account: 'same', side: 'sell', qty: '1', price: '100' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(0);
    expect(result.cancellations[0]!.reason).toBe('self_trade_prevention');
    for (const fill of result.fills) expect(fill.makerAccountId).not.toBe(fill.takerAccountId);
  });

  it('expires the resting maker and continues the taker (cancel-resting)', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'own', account: 'same', side: 'buy', qty: '1', price: '100' });
    seed(book, { id: 'other', account: 'stranger', side: 'buy', qty: '1', price: '100' });

    const result = book.submit(order({ id: 'aggressor', account: 'same', side: 'sell', qty: '2', price: '100' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.makerOrderId).toBe('other');
    expect(result.fills[0]!.makerAccountId).toBe('stranger');
    expect(result.cancellations).toHaveLength(1);
    expect(result.cancellations[0]!.orderId).toBe('own');
    expect(result.cancellations[0]!.reason).toBe('self_trade_prevention');
    expect(result.resting?.orderId).toBe('aggressor');
    expect(formatAmount(book.bestAsk()!)).toBe('100');
    expect(book.bestBid()).toBeNull();
  });

  it('FOK that cannot fill without self liquidity is unfillable — book unchanged', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'own', account: 'same', side: 'sell', qty: '3', price: '100' });
    seed(book, { id: 'other', account: 'stranger', side: 'sell', qty: '1', price: '100' });
    const before = book.serialize();

    const result = book.submit(order({ account: 'same', side: 'buy', qty: '2', price: '100', tif: 'FOK' }));

    expect(result.rejected?.code).toBe('fok_unfillable');
    expect(book.serialize()).toBe(before);
  });

  it('FOK with enough stranger size expires own rest and fills the stranger', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'own', account: 'same', side: 'sell', qty: '1', price: '100' });
    seed(book, { id: 'other', account: 'stranger', side: 'sell', qty: '2', price: '100' });

    const result = book.submit(order({ id: 'aggressor', account: 'same', side: 'buy', qty: '2', price: '100', tif: 'FOK' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.makerOrderId).toBe('other');
    expect(formatAmount(result.fills[0]!.qty)).toBe('2');
    expect(result.cancellations.map((c) => c.orderId)).toEqual(['own']);
    expect(result.cancellations[0]!.reason).toBe('self_trade_prevention');
    expect(result.resting).toBeNull();
  });

  it('walks past own rest across price levels', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'own-100', account: 'same', side: 'buy', qty: '1', price: '100' });
    seed(book, { id: 'other-99', account: 'stranger', side: 'buy', qty: '1', price: '99' });
    seed(book, { id: 'own-98', account: 'same', side: 'buy', qty: '1', price: '98' });

    const result = book.submit(order({ account: 'same', side: 'sell', qty: '3', price: '98', tif: 'IOC' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.makerOrderId).toBe('other-99');
    expect(result.cancellations.map((c) => ({ orderId: c.orderId, reason: c.reason }))).toEqual([
      { orderId: 'own-100', reason: 'self_trade_prevention' },
      { orderId: 'own-98', reason: 'self_trade_prevention' },
      { orderId: result.cancellations[2]!.orderId, reason: 'ioc_remainder' },
    ]);
  });
});

// ── Stops ───────────────────────────────────────────────────────────────────

describe('stop orders', () => {
  /** Prime a book with resting asks and a last trade price of 100. */
  function primed(): OrderBook {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });
    seed(book, { account: 'mm', side: 'sell', qty: '10', price: '106' });
    const warmup = book.submit(order({ account: 'warmup', side: 'buy', qty: '2' }));
    expect(formatAmount(warmup.fills[0]!.price)).toBe('100');
    return book;
  }

  it('never triggers before the market has printed a price', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: 'stop', account: 'a', type: 'stop', side: 'buy', qty: '1', stopPrice: '1' }));

    expect(result.accepted).toBe(true);
    expect(result.resting).toMatchObject({ kind: 'stop', orderId: 'stop' });
    expect(result.fills).toHaveLength(0);
  });

  it('rests in the stop book until a print reaches the trigger', () => {
    const book = primed();
    const resting = book.submit(order({ id: 'stop', account: 'b', type: 'stop', side: 'buy', qty: '3', stopPrice: '105' }));

    expect(resting.resting?.kind).toBe('stop');
    expect(resting.fills).toHaveLength(0);

    const trigger = book.submit(order({ account: 'c', side: 'buy', qty: '1' }));

    expect(fillPrices(trigger)).toEqual(['106']);
    expect(trigger.triggered).toHaveLength(1);
    expect(trigger.triggered[0]!.orderId).toBe('stop');
    expect(trigger.triggered[0]!.fills.map((f) => formatAmount(f.qty))).toEqual(['3']);
    expect(formatAmount(trigger.triggered[0]!.fills[0]!.price)).toBe('106');
  });

  it('a triggered stop-limit rests its remainder as an ordinary limit order', () => {
    const book = primed();
    book.submit(order({ id: 'sl', account: 'b', type: 'stop_limit', side: 'buy', qty: '20', price: '106', stopPrice: '105' }));

    const trigger = book.submit(order({ account: 'c', side: 'buy', qty: '1' }));
    const outcome = trigger.triggered[0]!;

    expect(outcome.fills.map((f) => formatAmount(f.qty))).toEqual(['9']);
    expect(outcome.resting).toMatchObject({ kind: 'book', orderId: 'sl' });
    expect(formatAmount(outcome.resting!.remaining)).toBe('11');
    expect(formatAmount(book.bestBid()!)).toBe('106');
  });

  it('a sell stop triggers on the way down', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'buy', qty: '5', price: '100' });
    seed(book, { account: 'mm', side: 'buy', qty: '5', price: '90' });
    book.submit(order({ account: 'warmup', side: 'sell', qty: '5' })); // last = 100

    const resting = book.submit(order({ id: 'sl', account: 'b', type: 'stop', side: 'sell', qty: '2', stopPrice: '95' }));
    expect(resting.resting?.kind).toBe('stop');

    const trigger = book.submit(order({ account: 'c', side: 'sell', qty: '1' })); // prints 90
    expect(trigger.triggered.map((t) => t.orderId)).toEqual(['sl']);
  });

  it('cascades: a triggered stop prints a price that arms the next one', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });
    seed(book, { account: 'mm', side: 'sell', qty: '5', price: '110' });
    seed(book, { account: 'mm', side: 'sell', qty: '5', price: '120' });
    book.submit(order({ account: 'warmup', side: 'buy', qty: '2' })); // last = 100

    book.submit(order({ id: 'stop-a', account: 'x', type: 'stop', side: 'buy', qty: '5', stopPrice: '105' }));
    book.submit(order({ id: 'stop-b', account: 'y', type: 'stop', side: 'buy', qty: '5', stopPrice: '115' }));

    const trigger = book.submit(order({ account: 'c', side: 'buy', qty: '5' })); // prints 110

    expect(trigger.triggered.map((t) => t.orderId)).toEqual(['stop-a', 'stop-b']);
    expect(trigger.triggered[0]!.fills.map((f) => formatAmount(f.price))).toEqual(['120']);
    // stop-b arms on stop-a's print but finds an empty book.
    expect(trigger.triggered[1]!.fills).toHaveLength(0);
    expect(trigger.triggered[1]!.cancellations[0]!.reason).toBe('market_remainder');
  });

  it('fires the older stop first when two arm on the same print', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });
    seed(book, { account: 'mm', side: 'sell', qty: '10', price: '110' });
    book.submit(order({ account: 'warmup', side: 'buy', qty: '2' }));

    book.submit(order({ id: 'older', account: 'x', type: 'stop', side: 'buy', qty: '1', stopPrice: '105' }));
    book.submit(order({ id: 'newer', account: 'y', type: 'stop', side: 'buy', qty: '1', stopPrice: '104' }));

    const trigger = book.submit(order({ account: 'c', side: 'buy', qty: '1' }));
    expect(trigger.triggered.map((t) => t.orderId)).toEqual(['older', 'newer']);
  });

  it('a triggered post-only stop-limit that would cross is rejected, not filled', () => {
    const book = primed();
    book.submit(
      order({ id: 'po-stop', account: 'b', type: 'stop_limit', side: 'buy', qty: '5', price: '106', stopPrice: '105', tif: 'PO' }),
    );

    const trigger = book.submit(order({ account: 'c', side: 'buy', qty: '1' }));
    const outcome = trigger.triggered[0]!;

    expect(outcome.rejected?.code).toBe('post_only_would_cross');
    expect(outcome.fills).toHaveLength(0);
    expect(outcome.cancellations[0]!.reason).toBe('trigger_rejected');
  });

  /**
   * Sequence honesty on trigger rejection (audit M2 / README reject-counter promise).
   *
   * Normal submit checks viability BEFORE nextSequence — a pure reject burns zero.
   * Activation already removed the stop from the book, so the cancel needs one
   * sequence (same as a user cancel of a live stop). Taking an "activation"
   * sequence first and then a second for the cancel burns two for a path that
   * never filled or rested — and leaves cancel.sequence !== outcome.sequence.
   */
  it('a trigger-rejected stop burns one sequence (the cancel), not two', () => {
    const book = primed();
    book.submit(
      order({ id: 'po-stop', account: 'b', type: 'stop_limit', side: 'buy', qty: '5', price: '106', stopPrice: '105', tif: 'PO' }),
    );
    const before = book.currentSequence;

    const trigger = book.submit(order({ account: 'c', side: 'buy', qty: '1' }));
    const outcome = trigger.triggered[0]!;

    expect(outcome.rejected?.code).toBe('post_only_would_cross');
    expect(outcome.cancellations).toHaveLength(1);
    // One shared sequence for the rejected activation cancel — not activation+cancel.
    expect(outcome.cancellations[0]!.sequence).toBe(outcome.sequence);
    // Aggressor: acceptance sequence + one fill sequence = +2; trigger cancel = +1 → +3 total.
    expect(book.currentSequence).toBe(before + 3);
    // Depth memo keys on sequence; stop removal must move it (one cancel is enough).
    expect(book.depth(50).sequence).toBe(book.currentSequence);
  });
});

// ── Cancels ─────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('removes a resting order and reports its untouched remainder', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'live', account: 'a', side: 'buy', qty: '4', price: '100' });
    book.submit(order({ account: 'b', side: 'sell', qty: '1', price: '100' }));

    const result = book.cancel('live');

    expect(result.cancelled).toBe(true);
    expect(formatAmount(result.cancellation!.remainingQty)).toBe('3');
    expect(result.cancellation!.reason).toBe('requested');
    expect(book.bestBid()).toBeNull();
  });

  it('removes the price level when the last order at it is cancelled', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'only', account: 'a', side: 'sell', qty: '1', price: '100' });
    seed(book, { account: 'a', side: 'sell', qty: '1', price: '101' });

    book.cancel('only');

    expect(formatAmount(book.bestAsk()!)).toBe('101');
    expect(book.depth(50).asks).toEqual([['101', '1']]);
  });

  it('cancels a stop order that never triggered', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'stop', account: 'a', type: 'stop', side: 'buy', qty: '1', stopPrice: '1' });

    const result = book.cancel('stop');
    expect(result.cancelled).toBe(true);
    expect(formatAmount(result.cancellation!.remainingQty)).toBe('1');
  });

  it('is a no-op for an unknown id — a cancel racing a fill is not an error', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.cancel('never-existed');

    expect(result.cancelled).toBe(false);
    expect(result.sequence).toBeNull();
    expect(book.currentSequence).toBe(0);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('validation', () => {
  const cases: Array<[string, OrderSpec, string]> = [
    ['zero quantity', { side: 'buy', qty: '0', price: '100' }, 'invalid_qty'],
    ['negative price', { side: 'buy', qty: '1', price: '0' }, 'invalid_price'],
    ['limit without a price', { type: 'limit', side: 'buy', qty: '1' }, 'missing_price'],
    ['market carrying a price', { type: 'market', side: 'buy', qty: '1', price: '100' }, 'unexpected_price'],
    ['stop without a stopPrice', { type: 'stop', side: 'buy', qty: '1' }, 'missing_stop_price'],
    ['limit carrying a stopPrice', { side: 'buy', qty: '1', price: '100', stopPrice: '99' }, 'unexpected_stop_price'],
  ];

  for (const [name, spec, code] of cases) {
    it(`rejects ${name}`, () => {
      const book = new OrderBook('BTC/USDT');
      const result = book.submit(order(spec));
      expect(result.accepted).toBe(false);
      expect(result.rejected?.code).toBe(code);
    });
  }

  it('rejects a duplicate order id — a bot retry must not open a second order', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'dup', account: 'a', side: 'buy', qty: '1', price: '100' });

    const result = book.submit(order({ id: 'dup', account: 'a', side: 'buy', qty: '1', price: '100' }));

    expect(result.rejected?.code).toBe('duplicate_order_id');
    expect(book.depth(50).bids).toEqual([['100', '1']]);
  });

  it('rejects a duplicate id held by an untriggered stop', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'dup', account: 'a', type: 'stop', side: 'buy', qty: '1', stopPrice: '1' });
    expect(book.submit(order({ id: 'dup', account: 'a', side: 'buy', qty: '1', price: '100' })).rejected?.code).toBe('duplicate_order_id');
  });

  // H8c: matching 200 consumes the id. Trade death cannot be the only guard —
  // a retry of a filled or never-rested id must not print a second fill or rest.

  it('rejects a fully filled id — a 200 retry must not open a second rest', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'maker', account: 'a', side: 'sell', qty: '1', price: '100' });

    book.submit(order({ id: 'taker', account: 'b', side: 'buy', qty: '1', price: '100' }));
    expect(book.depth(50).asks).toEqual([]);

    const again = book.submit(order({ id: 'maker', account: 'a', side: 'sell', qty: '1', price: '100' }));

    expect(again.accepted).toBe(false);
    expect(again.rejected?.code).toBe('duplicate_order_id');
    expect(again.fills).toEqual([]);
    expect(book.depth(50).asks).toEqual([]);
  });

  it('rejects a never-rested id — a 200 retry must not emit a duplicate fill', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'liq1', account: 'a', side: 'sell', qty: '1', price: '100' });
    seed(book, { id: 'liq2', account: 'a', side: 'sell', qty: '1', price: '100' });

    const first = book.submit(order({ id: 'mkt', account: 'b', type: 'market', side: 'buy', qty: '1' }));
    expect(first.accepted).toBe(true);
    expect(first.fills).toHaveLength(1);

    const second = book.submit(order({ id: 'mkt', account: 'b', type: 'market', side: 'buy', qty: '1' }));

    expect(second.accepted).toBe(false);
    expect(second.rejected?.code).toBe('duplicate_order_id');
    expect(second.fills).toEqual([]);
    expect(book.depth(50).asks).toEqual([['100', '1']]);
  });

  it('snapshot restore still refuses a filled id', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'maker', account: 'a', side: 'sell', qty: '1', price: '100' });
    book.submit(order({ id: 'taker', account: 'b', side: 'buy', qty: '1', price: '100' }));

    const restored = OrderBook.fromState(book.toState());
    expect(restored.toState().acceptedOrderIds).toEqual(['maker', 'taker']);

    const again = restored.submit(order({ id: 'taker', account: 'b', side: 'buy', qty: '1', price: '100' }));
    expect(again.accepted).toBe(false);
    expect(again.rejected?.code).toBe('duplicate_order_id');
    expect(again.fills).toEqual([]);
  });
});

// ── Sequences ───────────────────────────────────────────────────────────────

describe('sequence numbers', () => {
  it('are strictly monotonic across acceptances and fills', () => {
    const book = new OrderBook('BTC/USDT');
    const a = seed(book, { account: 'mm', side: 'sell', qty: '1', price: '100' });
    const b = seed(book, { account: 'mm', side: 'sell', qty: '1', price: '101' });
    const taker = book.submit(order({ account: 'taker', side: 'buy', qty: '2' }));

    const seen = [a.sequence!, b.sequence!, taker.sequence!, ...taker.fills.map((f) => f.sequence)];
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });

  it('are not consumed by a rejected order', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '1', price: '100' });
    const before = book.currentSequence;

    book.submit(order({ account: 'taker', side: 'buy', qty: '9', price: '100', tif: 'FOK' }));
    book.submit(order({ account: 'taker', side: 'buy', qty: '1', price: '100', tif: 'PO' }));
    book.submit(order({ account: 'taker', side: 'buy', qty: '0', price: '100' }));

    expect(book.currentSequence).toBe(before);
  });

  it('gives a triggered stop its activation sequence, not its admission sequence', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { account: 'mm', side: 'sell', qty: '2', price: '100' });
    seed(book, { account: 'mm', side: 'sell', qty: '5', price: '110' });
    book.submit(order({ account: 'warmup', side: 'buy', qty: '2' }));

    const admitted = book.submit(order({ id: 'stop', account: 'x', type: 'stop', side: 'buy', qty: '1', stopPrice: '105' }));
    const trigger = book.submit(order({ account: 'c', side: 'buy', qty: '1' }));

    expect(trigger.triggered[0]!.sequence).toBeGreaterThan(admitted.sequence!);
  });
});

// ── Serialisation, replay, and the no-float guarantee (§5.4) ────────────────

describe('serialised state', () => {
  /** A book with every feature live: both sides, multiple levels, partials, and a pending stop. */
  function busyBook(): OrderBook {
    const book = new OrderBook('ETH/USDT');
    seed(book, { account: 'mm', side: 'buy', qty: '1.5', price: '1999.25' });
    seed(book, { account: 'mm', side: 'buy', qty: '2', price: '1998' });
    seed(book, { account: 'mm2', side: 'buy', qty: '3', price: '1999.25' });
    seed(book, { account: 'mm', side: 'sell', qty: '4.125', price: '2000.5' });
    seed(book, { account: 'mm', side: 'sell', qty: '0.000000000000000001', price: '2001' });
    book.submit(order({ account: 'taker', side: 'buy', qty: '1', price: '2000.5' }));
    seed(book, { account: 'x', type: 'stop_limit', side: 'sell', qty: '2.5', price: '1990', stopPrice: '1995' });
    return book;
  }

  it('round-trips through a snapshot byte for byte', () => {
    const book = busyBook();
    const serialised = book.serialize();

    const restored = OrderBook.fromState(JSON.parse(serialised) as ReturnType<OrderBook['toState']>);

    expect(restored.serialize()).toBe(serialised);
  });

  it('a restored book keeps matching exactly where the original left off', () => {
    const original = busyBook();
    const restored = OrderBook.fromState(original.toState());

    const next = { side: 'sell' as const, qty: '5', price: '1998', account: 'late' };
    const a = original.submit(order({ id: 'twin', ...next }));
    const b = restored.submit(order({ id: 'twin', ...next }));

    expect(JSON.stringify(a.fills.map((f) => [formatAmount(f.price), formatAmount(f.qty), f.sequence]))).toBe(
      JSON.stringify(b.fills.map((f) => [formatAmount(f.price), formatAmount(f.qty), f.sequence])),
    );
    expect(original.serialize()).toBe(restored.serialize());
  });

  it('contains no floating-point value anywhere — every amount is a decimal string', () => {
    const serialised = busyBook().serialize();

    // 1 · No JSON number in the whole document has a fraction or an exponent.
    //     `JSON.stringify(0.1 + 0.2)` is "0.30000000000000004"; this catches it.
    expect(serialised).not.toMatch(/:\s*-?\d+\.\d/);
    expect(serialised).not.toMatch(/:\s*-?\d+(\.\d+)?[eE][+-]?\d+/);

    // 2 · Structurally: every amount-bearing field is a decimal string, and the
    //     only numbers in the document are integer sequences.
    const decimalString = /^-?\d+(\.\d{1,18})?$/;
    const amountKeys = new Set(['price', 'remaining', 'qty', 'stopPrice', 'lastTradePrice']);
    const numberKeys = new Set(['sequence', 'version']);
    const problems: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
      if (typeof node === 'number') {
        const key = path.slice(path.lastIndexOf('.') + 1);
        if (!numberKeys.has(key)) problems.push(`${path} is a JS number`);
        else if (!Number.isSafeInteger(node)) problems.push(`${path} is not a safe integer`);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`));
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (amountKeys.has(key)) {
          if (value === null) continue;
          if (typeof value !== 'string') problems.push(`${path}.${key} is ${typeof value}, not a decimal string`);
          else if (!decimalString.test(value)) problems.push(`${path}.${key} = "${value}" is not a decimal string`);
        }
        walk(value, `${path}.${key}`);
      }
    };

    walk(JSON.parse(serialised), '$');
    expect(problems).toEqual([]);
  });

  it('depth is emitted as decimal-string tuples, never numbers', () => {
    const depth = busyBook().depth(50);
    for (const [price, qty] of [...depth.bids, ...depth.asks]) {
      expect(typeof price).toBe('string');
      expect(typeof qty).toBe('string');
      expect(price).toMatch(/^\d+(\.\d{1,18})?$/);
      expect(qty).toMatch(/^\d+(\.\d{1,18})?$/);
    }
  });

  it('aggregates a price level rather than reporting each order', () => {
    const book = busyBook();
    // 1.5 + 3 resting at 1999.25 across two accounts.
    expect(book.depth(50).bids[0]).toEqual(['1999.25', '4.5']);
  });
});

describe('native amend', () => {
  it('qty-down at the same price retains queue sequence and bumps version', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'first', account: 'a', side: 'buy', qty: '2', price: '100' });
    seed(book, { id: 'second', account: 'b', side: 'buy', qty: '1', price: '100' });

    const result = book.amend({ orderId: 'first', expectedVersion: 1, qty: A('1') });

    expect(result.accepted).toBe(true);
    expect(result.priority).toBe('retained');
    expect(result.sequence).toBe(1);
    expect(result.version).toBe(2);
    expect(formatAmount(result.resting!.remaining)).toBe('1');

    const take = book.submit(order({ account: 'taker', side: 'sell', qty: '1', price: '100' }));
    expect(take.fills[0]!.makerOrderId).toBe('first');
  });

  it('price change loses priority and receives a new sequence', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'first', account: 'a', side: 'buy', qty: '1', price: '100' });
    seed(book, { id: 'second', account: 'b', side: 'buy', qty: '1', price: '100' });

    const result = book.amend({ orderId: 'first', expectedVersion: 1, price: A('100') });
    expect(result.priority).toBe('retained');

    const moved = book.amend({ orderId: 'first', expectedVersion: 2, price: A('99') });
    expect(moved.accepted).toBe(true);
    expect(moved.priority).toBe('lost');
    expect(moved.sequence).not.toBe(1);

    const take = book.submit(order({ account: 'taker', side: 'sell', qty: '1', price: '99' }));
    expect(take.fills[0]!.makerOrderId).toBe('second');
  });

  it('qty-up loses priority', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'first', account: 'a', side: 'buy', qty: '1', price: '100' });
    seed(book, { id: 'second', account: 'b', side: 'buy', qty: '1', price: '100' });

    const result = book.amend({ orderId: 'first', expectedVersion: 1, qty: A('2') });
    expect(result.accepted).toBe(true);
    expect(result.priority).toBe('lost');

    const take = book.submit(order({ account: 'taker', side: 'sell', qty: '1', price: '100' }));
    expect(take.fills[0]!.makerOrderId).toBe('second');
  });

  it('refused amend leaves the original order unchanged', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'keep', account: 'a', side: 'buy', qty: '2', price: '100' });
    const before = book.serialize();

    const missing = book.amend({ orderId: 'keep', expectedVersion: 99, qty: A('1') });
    expect(missing.accepted).toBe(false);
    expect(missing.rejected?.code).toBe('version_mismatch');
    expect(book.serialize()).toBe(before);

    const ghost = book.amend({ orderId: 'nope', expectedVersion: 1, qty: A('1') });
    expect(ghost.accepted).toBe(false);
    expect(ghost.rejected?.code).toBe('order_not_found');
    expect(book.serialize()).toBe(before);
  });

  it('amend racing a partial fill operates on remaining quantity', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'keep', account: 'a', side: 'buy', qty: '2', price: '100' });
    book.submit(order({ account: 'taker', side: 'sell', qty: '1', price: '100' }));

    const tooMuch = book.amend({ orderId: 'keep', expectedVersion: 1, qty: A('2') });
    expect(tooMuch.accepted).toBe(true);
    expect(tooMuch.priority).toBe('lost');

    const book2 = new OrderBook('BTC/USDT');
    seed(book2, { id: 'keep', account: 'a', side: 'buy', qty: '2', price: '100' });
    book2.submit(order({ account: 'taker', side: 'sell', qty: '1', price: '100' }));
    const down = book2.amend({ orderId: 'keep', expectedVersion: 1, qty: A('1') });
    expect(down.priority).toBe('retained');
    expect(formatAmount(down.resting!.remaining)).toBe('1');
  });

  const EARLY = '2026-08-25T12:00:00.000Z';
  const LATE = '2026-08-25T18:00:00.000Z';
  const BEFORE = new Date('2026-08-25T11:00:00.000Z');
  const BETWEEN = new Date('2026-08-25T15:00:00.000Z');

  it('a retained amend stores an earlier expireAt and that deadline is the one expiry uses', () => {
    const book = new OrderBook('BTC/USDT');
    const rested = book.submit(order({ id: 'gtd', account: 'a', side: 'buy', qty: '1', price: '100', tif: 'GTD', expireAt: LATE }), BEFORE);
    expect(rested.accepted).toBe(true);

    const amended = book.amend({ orderId: 'gtd', expectedVersion: 1, expireAt: EARLY });

    expect(amended.accepted).toBe(true);
    expect(amended.priority).toBe('retained');
    expect(amended.sequence).toBe(1);
    expect(formatAmount(amended.resting!.remaining)).toBe('1');
    expect(book.toState().bids[0]!.orders[0]!.expireAt).toBe(EARLY);

    const take = book.submit(order({ id: 'taker', account: 'taker', side: 'sell', qty: '1', price: '100' }), BETWEEN);
    expect(take.fills).toHaveLength(0);
    expect(take.cancellations.map((c) => [c.orderId, c.reason])).toEqual([['gtd', 'expired']]);
    expect(book.toState().bids).toEqual([]);
  });

  it('a retained amend that omits expireAt does not invent one', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'gtc', account: 'a', side: 'buy', qty: '2', price: '100' });

    const amended = book.amend({ orderId: 'gtc', expectedVersion: 1, qty: A('1') });

    expect(amended.priority).toBe('retained');
    expect(book.toState().bids[0]!.orders[0]!.expireAt).toBeUndefined();
    expect(book.toState().bids[0]!.orders[0]!.remaining).toBe('1');
  });

  it('a retained amend that omits expireAt keeps the stored GTD deadline', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: 'gtd', account: 'a', side: 'buy', qty: '2', price: '100', tif: 'GTD', expireAt: LATE }), BEFORE);

    const amended = book.amend({ orderId: 'gtd', expectedVersion: 1, qty: A('1') });

    expect(amended.priority).toBe('retained');
    expect(book.toState().bids[0]!.orders[0]!.expireAt).toBe(LATE);
    expect(book.toState().bids[0]!.orders[0]!.remaining).toBe('1');

    const take = book.submit(order({ id: 'taker', account: 'taker', side: 'sell', qty: '1', price: '100' }), BETWEEN);
    expect(take.fills).toHaveLength(1);
    expect(take.fills[0]!.makerOrderId).toBe('gtd');
  });

  it('a retained stop amend stores an earlier expireAt and that deadline is the one expiry uses', () => {
    const book = new OrderBook('BTC/USDT');
    const rested = book.submit(
      order({ id: 'stop', account: 'a', type: 'stop', side: 'sell', qty: '2', stopPrice: '90', tif: 'GTD', expireAt: LATE }),
      BEFORE,
    );
    expect(rested.accepted).toBe(true);
    expect(rested.resting?.kind).toBe('stop');

    const amended = book.amend({ orderId: 'stop', expectedVersion: 1, expireAt: EARLY });

    expect(amended.accepted).toBe(true);
    expect(amended.priority).toBe('retained');
    expect(amended.sequence).toBe(1);
    expect(formatAmount(amended.resting!.remaining)).toBe('2');
    expect(book.toState().stops[0]!.expireAt).toBe(EARLY);
    expect(book.toState().stops[0]!.qty).toBe('2');

    const later = book.submit(order({ id: 'other', account: 'b', side: 'buy', qty: '1', price: '100' }), BETWEEN);
    expect(later.cancellations.map((c) => [c.orderId, c.reason])).toEqual([['stop', 'expired']]);
    expect(book.toState().stops).toEqual([]);
  });

  it('a retained stop amend that omits expireAt keeps the stored deadline', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({ id: 'stop', account: 'a', type: 'stop', side: 'sell', qty: '2', stopPrice: '90', tif: 'GTD', expireAt: LATE }),
      BEFORE,
    );

    const amended = book.amend({ orderId: 'stop', expectedVersion: 1, qty: A('1') });

    expect(amended.priority).toBe('retained');
    expect(book.toState().stops[0]!.expireAt).toBe(LATE);
    expect(book.toState().stops[0]!.qty).toBe('1');
  });

  it('a retained amend to PO stays post-only when a later amend omits tif', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'ask', account: 'mm', side: 'sell', qty: '1', price: '100' });
    seed(book, { id: 'bid', account: 'a', side: 'buy', qty: '2', price: '99' });

    const po = book.amend({ orderId: 'bid', expectedVersion: 1, tif: 'PO' });
    expect(po.accepted).toBe(true);
    expect(po.priority).toBe('retained');
    expect(book.toState().bids[0]!.orders[0]!.postOnly).toBe(true);

    const down = book.amend({ orderId: 'bid', expectedVersion: 2, qty: A('1') });
    expect(down.accepted).toBe(true);
    expect(down.priority).toBe('retained');
    expect(book.toState().bids[0]!.orders[0]!.postOnly).toBe(true);
    expect(book.toState().bids[0]!.orders[0]!.remaining).toBe('1');

    const cross = book.amend({ orderId: 'bid', expectedVersion: 3, price: A('100') });
    expect(cross.accepted).toBe(false);
    expect(cross.rejected?.code).toBe('post_only_would_cross');
    expect(cross.fills).toHaveLength(0);
    expect(book.toState().asks[0]!.orders[0]!.remaining).toBe('1');
    expect(book.toState().bids[0]!.orders[0]!.postOnly).toBe(true);
    expect(formatAmount(book.bestBid()!)).toBe('99');
  });

  it('a retained amend below the stored minQty is refused and does not rest a broken maker', () => {
    const book = new OrderBook('BTC/USDT');
    const rested = book.submit(order({ id: 'maker', account: 'mm', side: 'sell', qty: '10', price: '100', minQty: '5' }));
    expect(rested.accepted).toBe(true);

    const shrunk = book.amend({ orderId: 'maker', expectedVersion: 1, qty: A('4') });

    expect(shrunk.accepted).toBe(false);
    expect(shrunk.rejected?.code).toBe('min_qty_exceeds_qty');
    expect(shrunk.fills).toHaveLength(0);
    expect(book.toState().asks[0]!.orders[0]!.remaining).toBe('10');
    expect(book.toState().asks[0]!.orders[0]!.minQty).toBe('5');
    expect(book.toState().asks[0]!.orders[0]!.version).toBe(1);

    const take = book.submit(order({ id: 'taker', account: 'taker', side: 'buy', qty: '5', price: '100' }));
    expect(take.fills).toHaveLength(1);
    expect(take.fills[0]!.makerOrderId).toBe('maker');
    expect(formatAmount(take.fills[0]!.qty)).toBe('5');
    expect(take.resting).toBeNull();
    expect(book.toState().asks[0]!.orders[0]!.remaining).toBe('5');
  });

  it('a retained amend down to the stored minQty keeps priority and can still fill', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: 'maker', account: 'mm', side: 'sell', qty: '10', price: '100', minQty: '5' }));
    seed(book, { id: 'behind', account: 'b', side: 'sell', qty: '1', price: '100' });

    const shrunk = book.amend({ orderId: 'maker', expectedVersion: 1, qty: A('5') });

    expect(shrunk.accepted).toBe(true);
    expect(shrunk.priority).toBe('retained');
    expect(shrunk.sequence).toBe(1);
    expect(book.toState().asks[0]!.orders[0]!.orderId).toBe('maker');
    expect(book.toState().asks[0]!.orders[0]!.remaining).toBe('5');

    const take = book.submit(order({ id: 'taker', account: 'taker', side: 'buy', qty: '5', price: '100' }));
    expect(take.fills).toHaveLength(1);
    expect(take.fills[0]!.makerOrderId).toBe('maker');
    expect(formatAmount(take.fills[0]!.qty)).toBe('5');
    expect(book.toState().asks[0]!.orders[0]!.orderId).toBe('behind');
  });

  /** Desk buys 2 from mm at 100. Position is the fill, long 2. */
  function longTwo(book: OrderBook): void {
    seed(book, { id: 'liq', account: 'mm', side: 'sell', qty: '2', price: '100' });
    const open = book.submit(order({ id: 'open', account: 'desk', side: 'buy', qty: '2', price: '100' }));
    expect(open.fills).toHaveLength(1);
    expect(book.toState().positions).toEqual([
      { accountId: 'desk', qty: '2' },
      { accountId: 'mm', qty: '-2' },
    ]);
  }

  it('refuses a reduce-only stop amend whose qty would increase the position, and does not park it', () => {
    const book = new OrderBook('BTC/USDT');
    longTwo(book);
    const rested = book.submit(
      order({ id: 'stop', account: 'desk', type: 'stop', side: 'sell', qty: '1', stopPrice: '90', reduceOnly: true }),
    );
    expect(rested.accepted).toBe(true);
    expect(book.toState().stops[0]).toMatchObject({ orderId: 'stop', qty: '1', stopPrice: '90', version: 1 });

    const amended = book.amend({ orderId: 'stop', expectedVersion: 1, qty: A('3') });

    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe('would_increase_position');
    expect(amended.fills).toHaveLength(0);
    expect(amended.triggered).toEqual([]);
    expect(book.toState().stops[0]).toMatchObject({ orderId: 'stop', qty: '1', stopPrice: '90', version: 1, reduceOnly: true });
    expect(book.toState().positions).toEqual([
      { accountId: 'desk', qty: '2' },
      { accountId: 'mm', qty: '-2' },
    ]);
  });

  it('refuses a triggered reduce-only stop amend whose qty would increase the position, and does not fill or flip it', () => {
    const book = new OrderBook('BTC/USDT');
    longTwo(book);
    seed(book, { id: 'bid', account: 'bid', side: 'buy', qty: '3', price: '100' });
    book.submit(order({ id: 'stop', account: 'desk', type: 'stop', side: 'sell', qty: '1', stopPrice: '90', reduceOnly: true }));

    const amended = book.amend({ orderId: 'stop', expectedVersion: 1, qty: A('3'), stopPrice: A('100') });

    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe('would_increase_position');
    expect(amended.fills).toHaveLength(0);
    expect(amended.triggered).toEqual([]);
    expect(book.toState().stops[0]).toMatchObject({ orderId: 'stop', qty: '1', stopPrice: '90', version: 1, reduceOnly: true });
    expect(book.toState().bids[0]!.orders[0]).toMatchObject({ orderId: 'bid', remaining: '3' });
    expect(book.toState().positions).toEqual([
      { accountId: 'desk', qty: '2' },
      { accountId: 'mm', qty: '-2' },
    ]);
  });

  it('amends a reduce-only stop to a qty that still reduces the position', () => {
    const book = new OrderBook('BTC/USDT');
    longTwo(book);
    book.submit(order({ id: 'stop', account: 'desk', type: 'stop', side: 'sell', qty: '2', stopPrice: '90', reduceOnly: true }));

    const amended = book.amend({ orderId: 'stop', expectedVersion: 1, qty: A('1') });

    expect(amended.accepted).toBe(true);
    expect(amended.priority).toBe('retained');
    expect(amended.fills).toHaveLength(0);
    expect(book.toState().stops[0]).toMatchObject({ orderId: 'stop', qty: '1', stopPrice: '90', version: 2, reduceOnly: true });
    expect(book.toState().positions).toEqual([
      { accountId: 'desk', qty: '2' },
      { accountId: 'mm', qty: '-2' },
    ]);
  });

  it('amends a reduce-only stop up to the net without parking a flip or filling', () => {
    const book = new OrderBook('BTC/USDT');
    longTwo(book);
    book.submit(order({ id: 'stop', account: 'desk', type: 'stop', side: 'sell', qty: '1', stopPrice: '90', reduceOnly: true }));

    const amended = book.amend({ orderId: 'stop', expectedVersion: 1, qty: A('2') });

    expect(amended.accepted).toBe(true);
    expect(amended.priority).toBe('lost');
    expect(amended.fills).toHaveLength(0);
    expect(book.toState().stops).toHaveLength(1);
    expect(book.toState().stops[0]).toMatchObject({ orderId: 'stop', qty: '2', stopPrice: '90', reduceOnly: true });
    expect(book.toState().positions).toEqual([
      { accountId: 'desk', qty: '2' },
      { accountId: 'mm', qty: '-2' },
    ]);
  });

  it('amends a reduce-only stop onto a trigger that reduces the position and does not flip it', () => {
    const book = new OrderBook('BTC/USDT');
    longTwo(book);
    seed(book, { id: 'bid', account: 'bid', side: 'buy', qty: '1', price: '100' });
    book.submit(order({ id: 'stop', account: 'desk', type: 'stop', side: 'sell', qty: '1', stopPrice: '90', reduceOnly: true }));

    const amended = book.amend({ orderId: 'stop', expectedVersion: 1, stopPrice: A('100') });

    expect(amended.accepted).toBe(true);
    expect(amended.fills).toHaveLength(1);
    expect(formatAmount(amended.fills[0]!.qty)).toBe('1');
    expect(book.toState().stops).toEqual([]);
    expect(book.toState().positions).toEqual([
      { accountId: 'bid', qty: '1' },
      { accountId: 'desk', qty: '1' },
      { accountId: 'mm', qty: '-2' },
    ]);
  });
});

describe('OCO sibling cancel', () => {
  const TP = 'oco-tp';
  const SL = 'oco-sl';

  function liveIds(book: OrderBook): string[] {
    const state = book.toState();
    return [
      ...state.bids.flatMap((level) => level.orders.map((o) => o.orderId)),
      ...state.asks.flatMap((level) => level.orders.map((o) => o.orderId)),
      ...state.stops.map((s) => s.orderId),
    ].sort();
  }

  it('a stop_limit that triggers and rests with zero fills cancels its OCO sibling', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'bid-print', account: 'mm', side: 'buy', qty: '1', price: '100' });
    const printed = book.submit(order({ id: 'print', account: 'taker', side: 'sell', qty: '1', price: '100' }));
    expect(formatAmount(printed.fills[0]!.price)).toBe('100');

    seed(book, { id: 'bid-90', account: 'mm', side: 'buy', qty: '2', price: '90' });
    const tp = book.submit(order({ id: TP, account: 'desk', side: 'sell', qty: '1', price: '110', ocoSiblingId: SL }));
    expect(tp.accepted).toBe(true);
    expect(tp.fills).toHaveLength(0);

    const parked = book.submit(
      order({
        id: SL,
        account: 'desk',
        type: 'stop_limit',
        side: 'sell',
        qty: '1',
        price: '100',
        stopPrice: '95',
        ocoSiblingId: TP,
      }),
    );
    expect(parked.accepted).toBe(true);
    expect(parked.fills).toHaveLength(0);
    expect(parked.resting?.kind).toBe('stop');

    const crash = book.submit(order({ id: 'crash', account: 'taker', side: 'sell', qty: '1', price: '90' }));

    expect(crash.fills).toHaveLength(1);
    expect(crash.fills[0]!.makerOrderId).toBe('bid-90');
    expect(formatAmount(crash.fills[0]!.price)).toBe('90');
    expect(formatAmount(crash.fills[0]!.qty)).toBe('1');
    expect(crash.triggered.map((t) => t.orderId)).toEqual([SL]);

    const triggered = crash.triggered[0]!;
    expect(triggered.fills).toHaveLength(0);
    expect(triggered.resting).toMatchObject({ kind: 'book', orderId: SL });
    expect(formatAmount(triggered.resting!.remaining)).toBe('1');
    expect(formatAmount(triggered.resting!.price)).toBe('100');
    expect(triggered.cancellations.map((c) => [c.orderId, c.reason])).toContainEqual([TP, 'oco_sibling_filled']);
    const pulled = triggered.cancellations.find((c) => c.orderId === TP);
    expect(formatAmount(pulled!.remainingQty)).toBe('1');
    expect(liveIds(book)).toEqual(['bid-90', SL].sort());
    expect(book.depth(50).asks).toEqual([['100', '1']]);
  });

  it('a sweep that trades one linked order pulls the sibling before the other leg trades', () => {
    const book = new OrderBook('BTC/USDT');
    const near = book.submit(order({ id: 'oco-near', account: 'desk', side: 'sell', qty: '1', price: '100', ocoSiblingId: 'oco-far' }));
    const mid = book.submit(order({ id: 'mid', account: 'mm', side: 'sell', qty: '1', price: '101' }));
    const far = book.submit(order({ id: 'oco-far', account: 'desk', side: 'sell', qty: '1', price: '102', ocoSiblingId: 'oco-near' }));
    expect(near.fills).toHaveLength(0);
    expect(mid.fills).toHaveLength(0);
    expect(far.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual(['mid', 'oco-far', 'oco-near']);

    const sweep = book.submit(order({ id: 'buy', account: 'taker', side: 'buy', qty: '3', price: '102' }));

    expect(sweep.fills.map((f) => f.makerOrderId)).toEqual(['oco-near', 'mid']);
    expect(fillPrices(sweep)).toEqual(['100', '101']);
    expect(fillQtys(sweep)).toEqual(['1', '1']);
    expect(sweep.fills.map((f) => f.makerOrderId)).not.toContain('oco-far');
    expect(sweep.cancellations.map((c) => [c.orderId, c.reason])).toContainEqual(['oco-far', 'oco_sibling_filled']);
    const pulled = sweep.cancellations.find((c) => c.orderId === 'oco-far');
    expect(formatAmount(pulled!.remainingQty)).toBe('1');
    expect(formatAmount(sweep.resting!.remaining)).toBe('1');
    expect(liveIds(book)).toEqual(['buy']);
    expect(book.depth(50).asks).toEqual([]);
  });

  it('a leg that fills still cancels its OCO sibling', () => {
    const book = new OrderBook('BTC/USDT');
    seed(book, { id: 'bid', account: 'mm', side: 'buy', qty: '1', price: '110' });
    book.submit(order({ id: SL, account: 'desk', type: 'stop', side: 'sell', qty: '1', stopPrice: '90', ocoSiblingId: TP }));
    const tp = book.submit(order({ id: TP, account: 'desk', side: 'sell', qty: '1', price: '110', ocoSiblingId: SL }));

    expect(tp.fills).toHaveLength(1);
    expect(tp.fills[0]!.makerOrderId).toBe('bid');
    expect(formatAmount(tp.fills[0]!.qty)).toBe('1');
    expect(formatAmount(tp.fills[0]!.price)).toBe('110');
    expect(tp.cancellations.map((c) => [c.orderId, c.reason])).toEqual([[SL, 'oco_sibling_filled']]);
    expect(formatAmount(tp.cancellations[0]!.remainingQty)).toBe('1');
    expect(liveIds(book)).toEqual([]);
  });

  it('resting a limit leg leaves its live OCO sibling on the book', () => {
    const book = new OrderBook('BTC/USDT');
    const sl = book.submit(order({ id: SL, account: 'desk', type: 'stop', side: 'sell', qty: '1', stopPrice: '90', ocoSiblingId: TP }));
    const tp = book.submit(order({ id: TP, account: 'desk', side: 'sell', qty: '1', price: '110', ocoSiblingId: SL }));

    expect(sl.accepted).toBe(true);
    expect(tp.accepted).toBe(true);
    expect(tp.fills).toHaveLength(0);
    expect(tp.cancellations.filter((c) => c.reason === 'oco_sibling_filled')).toEqual([]);
    expect(liveIds(book)).toEqual([SL, TP].sort());
  });
});

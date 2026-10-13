import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, sum } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { entryRefuse, installBracket, readEntry, stopLossRefuse, takeProfitRefuse, wantsBracket } from './bracket.js';
import type { EngineOrder, EngineOrderType, Fill, OrderSide, TimeInForce } from './types.js';

/**
 * Linked bracket: rest entry, then rest take-profit and stop-loss on entry fill.
 * Refuse if any leg is missing. The engine does not invent a trigger.
 */

installBracket(OrderBook);

const A = parseAmount;
const ENTRY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TP = '22222222-2222-4222-8222-222222222222';
const SL = '33333333-3333-4333-8333-333333333333';
const LIQ = '11111111-1111-4111-8111-111111111111';
const ENTRY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TP_B = '44444444-4444-4444-8444-444444444444';
const SL_B = '55555555-5555-4555-8555-555555555555';

function order(spec: {
  id: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  stopPrice?: string;
  tif?: TimeInForce;
  bracket?: boolean;
  takeProfit?: string | null;
  stopLoss?: string | null;
  takeProfitOrderId?: string;
  stopLossOrderId?: string;
}): EngineOrder {
  const type = spec.type ?? (spec.price === undefined ? 'market' : 'limit');
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type,
    side: spec.side,
    qty: A(spec.qty),
    price: spec.price === undefined ? null : A(spec.price),
    stopPrice: spec.stopPrice === undefined ? null : A(spec.stopPrice),
    tif: spec.tif ?? 'GTC',
    ...(spec.bracket !== undefined ? { bracket: spec.bracket } : {}),
    ...(spec.takeProfit !== undefined ? { takeProfit: spec.takeProfit == null ? null : A(spec.takeProfit) } : {}),
    ...(spec.stopLoss !== undefined ? { stopLoss: spec.stopLoss == null ? null : A(spec.stopLoss) } : {}),
    ...(spec.takeProfitOrderId ? { takeProfitOrderId: spec.takeProfitOrderId } : {}),
    ...(spec.stopLossOrderId ? { stopLossOrderId: spec.stopLossOrderId } : {}),
  } as EngineOrder;
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

function filledQty(fills: readonly Fill[], orderId: string): string {
  return formatAmount(sum(fills.filter((fill) => fill.makerOrderId === orderId || fill.takerOrderId === orderId).map((fill) => fill.qty)));
}

function tradedQty(
  result: { readonly fills: readonly Fill[]; readonly triggered: readonly { readonly fills: readonly Fill[] }[] },
  orderId: string,
): string {
  return filledQty([...result.fills, ...result.triggered.flatMap((row) => row.fills)], orderId);
}

describe('bracket — rest entry, take-profit, and stop-loss', () => {
  it('rests the entry without resting the exits', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '1',
        price: '100',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([ENTRY]);
    expect(book.lastPrice).toBeNull();
  });

  it('entry fill rests the exits — no invented trigger', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '1',
        price: '100',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    const result = book.submit(order({ id: LIQ, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
    expect(result.fills.length).toBeGreaterThan(0);
    expect(formatAmount(result.fills[0]!.qty)).toBe('1');
    expect(liveIds(book)).toEqual([SL, TP].sort());
    expect(liveIds(book)).not.toContain(ENTRY);
    const state = book.toState();
    const stop = state.stops.find((row) => row.orderId === SL);
    const takeProfit = state.asks.flatMap((level) => level.orders).find((row) => row.orderId === TP);
    expect(stop?.ocoSiblingId).toBe(TP);
    expect(takeProfit?.ocoSiblingId).toBe(SL);
  });

  it('a stop already at the fill price does not leave the take-profit live', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: 'ask', account: 'mm', side: 'sell', qty: '1', price: '100' }));
    book.submit(order({ id: 'bid', account: 'mm', side: 'buy', qty: '1', price: '99' }));
    const result = book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '1',
        price: '100',
        bracket: true,
        takeProfit: '110',
        stopLoss: '100',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );

    expect(result.accepted).toBe(true);
    expect(result.rejected).toBeUndefined();
    const stopFill = result.fills.find((fill) => fill.takerOrderId === SL);
    expect(stopFill).toBeDefined();
    expect(formatAmount(stopFill!.qty)).toBe('1');
    expect(formatAmount(stopFill!.price)).toBe('99');
    expect(result.cancellations.map((row) => [row.orderId, row.reason])).toContainEqual([TP, 'oco_sibling_filled']);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);
    expect(book.toState().positions?.some((row) => row.accountId === 'desk')).toBeFalsy();

    const again = book.submit(order({ id: 'lift-tp', account: 'mm', side: 'buy', qty: '1', price: '110' }));
    expect(again.fills.filter((fill) => fill.makerOrderId === TP || fill.takerOrderId === TP)).toHaveLength(0);
  });

  it('a partial take-profit does not let the stop sell that size again', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '2',
        price: '100',
        bracket: true,
        takeProfit: '100',
        stopLoss: '100',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    book.submit(order({ id: 'behind', account: 'buyer', side: 'buy', qty: '1', price: '100' }));
    book.submit(order({ id: 'below', account: 'buyer', side: 'buy', qty: '2', price: '99' }));
    const result = book.submit(order({ id: 'hit', account: 'mm', side: 'sell', qty: '2', price: '100' }));

    expect(result.accepted).toBe(true);
    expect(filledQty(result.fills, TP)).toBe('1');
    expect(filledQty(result.fills, SL)).toBe('1');
    const stopFill = result.fills.find((fill) => fill.takerOrderId === SL);
    expect(formatAmount(stopFill!.price)).toBe('99');
    expect(result.cancellations.map((row) => [row.orderId, row.reason])).toContainEqual([TP, 'oco_sibling_filled']);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);
    expect(book.toState().positions?.find((row) => row.accountId === 'desk')).toBeUndefined();

    const again = book.submit(order({ id: 'lift-tp', account: 'mm', side: 'buy', qty: '1', price: '100' }));
    expect(again.fills.filter((fill) => fill.makerOrderId === TP || fill.takerOrderId === TP)).toHaveLength(0);
  });

  it('an immediate entry with a partial take-profit does not let the stop sell that size again', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: 'ask', account: 'mm', side: 'sell', qty: '2', price: '100' }));
    book.submit(order({ id: 'bid-99', account: 'buyer', side: 'buy', qty: '1', price: '99' }));
    book.submit(order({ id: 'bid-98', account: 'buyer', side: 'buy', qty: '2', price: '98' }));
    const result = book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '2',
        price: '100',
        bracket: true,
        takeProfit: '99',
        stopLoss: '99',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );

    expect(result.accepted).toBe(true);
    expect(filledQty(result.fills, ENTRY)).toBe('2');
    expect(filledQty(result.fills, TP)).toBe('1');
    expect(filledQty(result.fills, SL)).toBe('1');
    const stopFill = result.fills.find((fill) => fill.takerOrderId === SL);
    expect(formatAmount(stopFill!.price)).toBe('98');
    expect(result.cancellations.map((row) => [row.orderId, row.reason])).toContainEqual([TP, 'oco_sibling_filled']);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);
    expect(book.toState().positions?.find((row) => row.accountId === 'desk')).toBeUndefined();
  });

  it('a later fill of the resting take-profit pulls the stop', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '2',
        price: '100',
        bracket: true,
        takeProfit: '100',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    book.submit(order({ id: 'bid-100', account: 'buyer', side: 'buy', qty: '1', price: '100' }));
    book.submit(order({ id: 'bid-80', account: 'buyer', side: 'buy', qty: '5', price: '80' }));
    const opened = book.submit(order({ id: 'hit', account: 'mm', side: 'sell', qty: '2', price: '100' }));

    expect(opened.accepted).toBe(true);
    expect(filledQty(opened.fills, TP)).toBe('1');
    expect(filledQty(opened.fills, SL)).toBe('0');
    expect(book.toState().stops.find((row) => row.orderId === SL)?.qty).toBe('1');
    expect(
      book
        .toState()
        .asks.flatMap((level) => level.orders)
        .find((row) => row.orderId === TP)?.remaining,
    ).toBe('1');

    const later = book.submit(order({ id: 'lift', account: 'mm', side: 'buy', qty: '1', price: '100' }));
    expect(filledQty(later.fills, TP)).toBe('1');
    expect(later.cancellations.map((row) => [row.orderId, row.reason])).toContainEqual([SL, 'oco_sibling_filled']);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);

    const print = book.submit(order({ id: 'print-80', account: 'mm', side: 'sell', qty: '1', price: '80' }));
    expect(tradedQty(print, SL)).toBe('0');
    expect(book.toState().positions?.find((row) => row.accountId === 'desk')).toBeUndefined();
  });

  it('a take-profit fill on the triggered outcome sizes the stop from every sale', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: 'buy-stop-limit',
        account: 'chase',
        type: 'stop_limit',
        side: 'buy',
        qty: '1',
        price: '110',
        stopPrice: '100',
      }),
    );
    book.submit(order({ id: 'buy-stop-105', account: 'chase', type: 'stop', side: 'buy', qty: '1', stopPrice: '105' }));
    book.submit(order({ id: 'bid-99', account: 'buyer', side: 'buy', qty: '5', price: '99' }));
    book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '3',
        price: '100',
        bracket: true,
        takeProfit: '100',
        stopLoss: '110',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    const result = book.submit(order({ id: 'hit', account: 'mm', side: 'sell', qty: '3', price: '100' }));

    expect(result.accepted).toBe(true);
    const at110 = [...result.fills, ...result.triggered.flatMap((row) => row.fills)].find(
      (fill) => (fill.makerOrderId === TP || fill.takerOrderId === TP) && formatAmount(fill.price) === '110',
    );
    expect(at110).toBeDefined();
    expect(formatAmount(at110!.qty)).toBe('1');
    expect(tradedQty(result, TP)).toBe('2');
    expect(tradedQty(result, SL)).toBe('1');
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);
    expect(book.toState().positions?.find((row) => row.accountId === 'desk')).toBeUndefined();
  });

  it('a full-size marketable take-profit flattens and does not fill the stop', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '1',
        price: '100',
        bracket: true,
        takeProfit: '100',
        stopLoss: '100',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    book.submit(order({ id: 'behind', account: 'buyer', side: 'buy', qty: '1', price: '100' }));
    const result = book.submit(order({ id: 'hit', account: 'mm', side: 'sell', qty: '1', price: '100' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('oco_sibling_terminal');
    expect(filledQty(result.fills, SL)).toBe('0');
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);
    expect(book.toState().positions?.find((row) => row.accountId === 'desk')).toBeUndefined();
  });

  it('a rejected stop does not rest the take-profit', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: SL, account: 'other', side: 'buy', qty: '1', price: '50' }));
    book.submit(order({ id: 'ask', account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const result = book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '1',
        price: '100',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(result.accepted).toBe(false);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).toContain(SL);
  });

  it('an immediate entry fill rests the exits in the same submit', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const result = book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '1',
        price: '100',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.fills.length).toBeGreaterThan(0);
    expect(liveIds(book)).toEqual([SL, TP].sort());
    expect(liveIds(book)).not.toContain(ENTRY);
  });

  it('a partial market entry arms the exits for the size it traded', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const result = book.submit(
      order({
        id: ENTRY,
        type: 'market',
        side: 'buy',
        qty: '2',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );

    expect(result.accepted).toBe(true);
    expect(filledQty(result.fills, ENTRY)).toBe('1');
    expect(result.cancellations.map((row) => [row.orderId, row.reason])).toContainEqual([ENTRY, 'market_remainder']);
    expect(liveIds(book)).not.toContain(ENTRY);
    const stop = book.toState().stops.find((row) => row.orderId === SL);
    const takeProfit = book
      .toState()
      .asks.flatMap((level) => level.orders)
      .find((row) => row.orderId === TP);
    expect(stop?.qty).toBe('1');
    expect(takeProfit?.remaining).toBe('1');
  });

  it('a resting entry that fills across submits arms both children for the size it traded', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '4',
        price: '100',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );

    const first = book.submit(order({ id: 'hit-1', account: 'mm', side: 'sell', qty: '1', price: '100' }));
    expect(filledQty(first.fills, ENTRY)).toBe('1');
    expect(liveIds(book)).toContain(ENTRY);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);

    // One unit never trades. The original order is 4; the book now holds 2.
    const cut = book.amend({ orderId: ENTRY, expectedVersion: 1, qty: A('2') });
    expect(cut.accepted).toBe(true);
    expect(cut.fills).toHaveLength(0);
    expect(liveIds(book)).toContain(ENTRY);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);

    const rest = book.submit(order({ id: 'hit-2', account: 'mm', side: 'sell', qty: '2', price: '100' }));
    expect(rest.accepted).toBe(true);
    expect(filledQty(rest.fills, ENTRY)).toBe('2');
    expect(liveIds(book)).not.toContain(ENTRY);
    const stop = book.toState().stops.find((row) => row.orderId === SL);
    const takeProfit = book
      .toState()
      .asks.flatMap((level) => level.orders)
      .find((row) => row.orderId === TP);
    // Traded 1 then 2. Not the original 4, and not the last slice of 2.
    expect(stop?.qty).toBe('3');
    expect(takeProfit?.remaining).toBe('3');
  });

  it('a partial IOC entry arms both children for the size it traded', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'sell', qty: '1.5', price: '100' }));
    const result = book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '4',
        price: '100',
        tif: 'IOC',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );

    expect(result.accepted).toBe(true);
    expect(result.rejected).toBeUndefined();
    expect(filledQty(result.fills, ENTRY)).toBe('1.5');
    expect(result.cancellations.map((row) => [row.orderId, row.reason, formatAmount(row.remainingQty)])).toContainEqual([
      ENTRY,
      'ioc_remainder',
      '2.5',
    ]);
    expect(liveIds(book)).not.toContain(ENTRY);
    expect(book.toState().positions?.find((row) => row.accountId === 'desk')?.qty).toBe('1.5');
    const stop = book.toState().stops.find((row) => row.orderId === SL);
    const takeProfit = book
      .toState()
      .asks.flatMap((level) => level.orders)
      .find((row) => row.orderId === TP);
    expect(stop?.qty).toBe('1.5');
    expect(takeProfit?.remaining).toBe('1.5');
  });

  it('an amend fill counts in the size both children arm for', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: ENTRY,
        side: 'buy',
        qty: '4',
        price: '100',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );

    const first = book.submit(order({ id: 'hit-1', account: 'mm', side: 'sell', qty: '1', price: '100' }));
    expect(filledQty(first.fills, ENTRY)).toBe('1');
    expect(liveIds(book)).toContain(ENTRY);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);

    book.submit(order({ id: 'ask-101', account: 'mm', side: 'sell', qty: '1', price: '101' }));
    const amended = book.amend({ orderId: ENTRY, expectedVersion: 1, price: A('101') });
    expect(amended.accepted).toBe(true);
    expect(filledQty(amended.fills, ENTRY)).toBe('1');
    expect(liveIds(book)).toContain(ENTRY);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);

    const rest = book.submit(order({ id: 'hit-2', account: 'mm', side: 'sell', qty: '2', price: '101' }));
    expect(rest.accepted).toBe(true);
    expect(filledQty(rest.fills, ENTRY)).toBe('2');
    expect(liveIds(book)).not.toContain(ENTRY);
    expect(book.toState().positions?.find((row) => row.accountId === 'desk')?.qty).toBe('4');
    const stop = book.toState().stops.find((row) => row.orderId === SL);
    const takeProfit = book
      .toState()
      .asks.flatMap((level) => level.orders)
      .find((row) => row.orderId === TP);
    expect(stop?.qty).toBe('4');
    expect(takeProfit?.remaining).toBe('4');
  });

  it('a fill from another bracket exit arms the resting entry for the size it traded', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(
      order({
        id: ENTRY,
        account: 'alpha',
        side: 'buy',
        qty: '2',
        price: '100',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );

    const first = book.submit(order({ id: 'hit-a', account: 'mm', side: 'sell', qty: '1', price: '100' }));
    expect(filledQty(first.fills, ENTRY)).toBe('1');
    expect(liveIds(book)).toContain(ENTRY);
    expect(liveIds(book)).not.toContain(TP);
    expect(liveIds(book)).not.toContain(SL);

    book.submit(order({ id: 'ask-105', account: 'mm', side: 'sell', qty: '1', price: '105' }));
    book.submit(
      order({
        id: ENTRY_B,
        account: 'beta',
        side: 'buy',
        qty: '1',
        price: '105',
        bracket: true,
        takeProfit: '100',
        stopLoss: '80',
        takeProfitOrderId: TP_B,
        stopLossOrderId: SL_B,
      }),
    );

    expect(liveIds(book)).not.toContain(ENTRY);
    expect(book.toState().positions?.find((row) => row.accountId === 'alpha')?.qty).toBe('2');
    const stop = book.toState().stops.find((row) => row.orderId === SL);
    const takeProfit = book
      .toState()
      .asks.flatMap((level) => level.orders)
      .find((row) => row.orderId === TP);
    expect(stop?.qty).toBe('2');
    expect(takeProfit?.remaining).toBe('2');

    book.submit(order({ id: 'later', account: 'gamma', side: 'buy', qty: '1', price: '50' }));
    const stopAfter = book.toState().stops.find((row) => row.orderId === SL);
    const takeProfitAfter = book
      .toState()
      .asks.flatMap((level) => level.orders)
      .find((row) => row.orderId === TP);
    expect(stopAfter?.qty).toBe('2');
    expect(takeProfitAfter?.remaining).toBe('2');
    expect(book.toState().positions?.find((row) => row.accountId === 'alpha')?.qty).toBe('2');
  });

  it('refuses a missing take-profit — last on the book is not a trigger', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const result = book.submit(order({ id: ENTRY, side: 'buy', qty: '1', price: '100', bracket: true, stopLoss: '90' }));
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('missing_stop_price');
    expect(result.rejected?.message).toContain('take-profit');
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([LIQ]);
  });

  it('refuses a missing stop-loss — last on the book is not a trigger', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: ENTRY, side: 'buy', qty: '1', price: '100', bracket: true, takeProfit: '110' }));
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('missing_stop_price');
    expect(result.rejected?.message).toContain('stop-loss');
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([]);
  });

  it('refuses a missing entry — last on the book is not a trigger', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const result = book.submit(
      order({
        id: ENTRY,
        type: 'limit',
        side: 'buy',
        qty: '1',
        bracket: true,
        takeProfit: '110',
        stopLoss: '90',
      }),
    );
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('missing_price');
    expect(result.rejected?.message).toContain('entry');
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([LIQ]);
  });

  it('plain GTC does not rest a bracket', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: ENTRY, side: 'buy', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
    expect(liveIds(book)).toEqual([ENTRY]);
  });

  it('read helpers treat missing and zero as not set', () => {
    expect(wantsBracket({})).toBe(false);
    expect(wantsBracket({ bracket: true })).toBe(true);
    expect(readEntry({})).toBeNull();
    expect(readEntry({ price: null })).toBeNull();
    expect(readEntry({ price: A('0') })).toBeNull();
    expect(readEntry({ price: A('100') })).toBe(A('100'));
    expect(readEntry({ type: 'market' })).toBeNull();
    expect(entryRefuse({ type: 'limit' })?.message).toContain('invent a trigger');
    expect(entryRefuse({ type: 'market' })).toBeNull();
    expect(takeProfitRefuse(null)?.message).toContain('invent a trigger');
    expect(stopLossRefuse(null)?.message).toContain('invent a trigger');
    expect(takeProfitRefuse(A('110'))).toBeNull();
    expect(stopLossRefuse(A('90'))).toBeNull();
  });
});

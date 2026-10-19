import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { installOcoCancel } from './oco-cancel.js';
import { installOcoLink, readStopLoss, readTakeProfit, stopLossRefuse, takeProfitRefuse, wantsOco } from './oco-link.js';
import type { EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';

/**
 * Linked OCO: rest take-profit and stop-loss together.
 * First fill cancels the sibling. Refuse if either sibling is missing.
 * The engine does not invent a trigger.
 */

// oco-cancel installs while oco-link loads, then oco-link wraps it. Link stays the outer submit hook.
installOcoCancel(OrderBook);
installOcoLink(OrderBook);

const A = parseAmount;
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TP = '22222222-2222-4222-8222-222222222222';
const SL = '33333333-3333-4333-8333-333333333333';
const LIQ = '11111111-1111-4111-8111-111111111111';
const PRINT = '44444444-4444-4444-8444-444444444444';
const BID = '55555555-5555-4555-8555-555555555555';

function order(spec: {
  id: string;
  account?: string;
  type?: EngineOrderType;
  side: OrderSide;
  qty: string;
  price?: string;
  stopPrice?: string;
  tif?: TimeInForce;
  oco?: boolean;
  cancel?: boolean;
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
    ...(spec.oco !== undefined ? { oco: spec.oco } : {}),
    ...(spec.cancel === true ? { cancel: true } : {}),
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

describe('OCO — rest linked take-profit and stop-loss', () => {
  it('rests both siblings without inventing a trigger', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '1',
        oco: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([SL, TP].sort());
    expect(book.lastPrice).toBeNull();
  });

  it('first fill of the take-profit cancels the stop-loss sibling', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'buy', qty: '1', price: '110' }));
    const result = book.submit(
      order({
        id: PARENT,
        account: 'desk',
        side: 'sell',
        qty: '1',
        oco: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(result.accepted).toBe(true);
    expect(result.fills.length).toBeGreaterThan(0);
    expect(formatAmount(result.fills[0]!.qty)).toBe('1');
    expect(result.cancellations.map((c) => [c.orderId, c.reason])).toContainEqual([SL, 'oco_sibling_filled']);
    expect(liveIds(book)).not.toContain(SL);
  });

  it('a rejected take-profit leaves the book untouched: no stop fills, no stop leg, no cancellation', () => {
    const filled = new OrderBook('BTC/USDT');
    filled.submit(order({ id: LIQ, account: 'mm', side: 'buy', qty: '1', price: '100' }));
    filled.submit(order({ id: PRINT, account: 'taker', side: 'sell', qty: '1', price: '100' }));
    filled.submit(order({ id: BID, account: 'mm', side: 'buy', qty: '1', price: '95' }));
    const rejectedTp = filled.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '1',
        oco: true,
        takeProfit: '110',
        stopLoss: '100',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(rejectedTp.accepted).toBe(false);
    expect(rejectedTp.rejected?.code).toBe('oco_sibling_terminal');
    // A rejected submit means the book was never touched: svc-trade releases the whole hold on it and settles no fills.
    expect(rejectedTp.fills).toEqual([]);
    expect(rejectedTp.triggered).toEqual([]);
    expect(liveIds(filled)).not.toContain(SL);
    expect(liveIds(filled)).toContain(BID);
    expect(rejectedTp.resting).toBeNull();
    expect(formatAmount(filled.lastPrice!)).toBe('100');

    const book = new OrderBook('BTC/USDT');
    const removed = book.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '1',
        tif: 'FOK',
        oco: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(removed.accepted).toBe(false);
    expect(removed.rejected?.code).toBe('fok_unfillable');
    expect(removed.resting).toBeNull();
    expect(liveIds(book)).not.toContain(SL);
    expect(liveIds(book)).not.toContain(TP);
    expect(removed.cancellations).toEqual([]);

    const crossed = new OrderBook('BTC/USDT');
    crossed.submit(order({ id: LIQ, account: 'mm', side: 'buy', qty: '1', price: '110' }));
    const filledTp = crossed.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '1',
        oco: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(filledTp.accepted).toBe(true);
    expect(filledTp.fills.length).toBeGreaterThan(0);
    expect(filledTp.resting).toBeNull();
    expect(liveIds(crossed)).not.toContain(SL);
  });

  it('refuses a missing take-profit — last on the book is not a trigger', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'buy', qty: '1', price: '100' }));
    const result = book.submit(order({ id: PARENT, side: 'sell', qty: '1', oco: true, stopLoss: '90' }));
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('missing_stop_price');
    expect(result.rejected?.message).toContain('take-profit');
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([LIQ]);
  });

  it('cancels both live siblings when the outer link hook omits take-profit', () => {
    const book = new OrderBook('BTC/USDT');
    const rested = book.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '1',
        oco: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(rested.accepted).toBe(true);
    expect(liveIds(book)).toEqual([SL, TP].sort());

    const pulled = book.submit(
      order({
        id: TP,
        side: 'sell',
        qty: '1',
        price: '110',
        oco: true,
        cancel: true,
      }),
    );
    expect(pulled.accepted).toBe(true);
    expect(pulled.rejected?.code).not.toBe('missing_stop_price');
    expect(pulled.fills).toHaveLength(0);
    expect(pulled.resting).toBeNull();
    expect(pulled.cancellations.map((c) => [c.orderId, c.reason]).sort()).toEqual(
      [
        [SL, 'requested'],
        [TP, 'requested'],
      ].sort(),
    );
    expect(liveIds(book)).toEqual([]);
    expect(book.lastPrice).toBeNull();
  });

  it('refuses a missing stop-loss — last on the book is not a trigger', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: PARENT, side: 'sell', qty: '1', oco: true, takeProfit: '110' }));
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('missing_stop_price');
    expect(result.rejected?.message).toContain('stop-loss');
    expect(result.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([]);
  });

  it('plain GTC does not rest an OCO', () => {
    const book = new OrderBook('BTC/USDT');
    const result = book.submit(order({ id: PARENT, side: 'sell', qty: '1', price: '110' }));
    expect(result.accepted).toBe(true);
    expect(liveIds(book)).toEqual([PARENT]);
  });

  it('read helpers treat missing and zero as not set', () => {
    expect(wantsOco({})).toBe(false);
    expect(wantsOco({ oco: true })).toBe(true);
    expect(readTakeProfit({})).toBeNull();
    expect(readTakeProfit({ takeProfit: null })).toBeNull();
    expect(readTakeProfit({ takeProfit: A('0') })).toBeNull();
    expect(readTakeProfit({ takeProfit: A('110') })).toBe(A('110'));
    expect(readStopLoss({})).toBeNull();
    expect(readStopLoss({ stopLoss: null })).toBeNull();
    expect(readStopLoss({ stopLoss: A('0') })).toBeNull();
    expect(readStopLoss({ stopLoss: A('90') })).toBe(A('90'));
    expect(takeProfitRefuse(null)?.message).toContain('invent a trigger');
    expect(stopLossRefuse(null)?.message).toContain('invent a trigger');
    expect(takeProfitRefuse(A('110'))).toBeNull();
    expect(stopLossRefuse(A('90'))).toBeNull();
  });
});

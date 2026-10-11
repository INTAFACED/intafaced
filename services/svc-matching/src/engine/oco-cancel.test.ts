import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { installOcoLink } from './oco-link.js';
import { installOcoCancel, ocoCancelRefuse, readOcoPair, wantsOcoCancel } from './oco-cancel.js';
import type { EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';

/**
 * Cancel both siblings of a linked OCO.
 * Refuse if either sibling is already terminal.
 * The engine does not invent a trigger.
 */

installOcoLink(OrderBook);
installOcoCancel(OrderBook);

const A = parseAmount;
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TP = '22222222-2222-4222-8222-222222222222';
const SL = '33333333-3333-4333-8333-333333333333';
const LIQ = '11111111-1111-4111-8111-111111111111';

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
  ocoSiblingId?: string;
  mark?: string;
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
    ...(spec.ocoSiblingId ? { ocoSiblingId: spec.ocoSiblingId } : {}),
    ...(spec.mark !== undefined ? { mark: A(spec.mark) } : {}),
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

function restPair(book: OrderBook): void {
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
}

describe('OCO — cancel both siblings', () => {
  it('cancels both live siblings without inventing a trigger', () => {
    const book = new OrderBook('BTC/USDT');
    restPair(book);
    const pulled = book.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '1',
        oco: true,
        cancel: true,
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
        mark: '50',
      }),
    );
    expect(pulled.accepted).toBe(true);
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

  it('cancels both when the caller names one live sibling', () => {
    const book = new OrderBook('BTC/USDT');
    restPair(book);
    const pulled = book.submit(order({ id: TP, side: 'sell', qty: '1', price: '110', oco: true, cancel: true }));
    expect(pulled.accepted).toBe(true);
    expect(pulled.cancellations.map((c) => c.orderId).sort()).toEqual([SL, TP].sort());
    expect(liveIds(book)).toEqual([]);
  });

  it('refuses when the stop-loss sibling is already terminal — remaining take-profit stays', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'buy', qty: '1', price: '110' }));
    const rest = book.submit(
      order({
        id: PARENT,
        account: 'desk',
        side: 'sell',
        qty: '3',
        oco: true,
        takeProfit: '110',
        stopLoss: '90',
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
      }),
    );
    expect(rest.accepted).toBe(true);
    expect(formatAmount(rest.fills[0]!.qty)).toBe('1');
    expect(rest.cancellations.map((c) => c.orderId)).toContain(SL);
    expect(liveIds(book)).toEqual([TP]);

    const pulled = book.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '2',
        oco: true,
        cancel: true,
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
        mark: '50',
      }),
    );
    expect(pulled.accepted).toBe(false);
    expect(pulled.rejected?.code).toBe('oco_sibling_terminal');
    expect(pulled.rejected?.message).toContain('invent a trigger');
    expect(pulled.cancellations).toHaveLength(0);
    expect(liveIds(book)).toEqual([TP]);
  });

  it('refuses when neither sibling is live — last on the book is not a trigger', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: LIQ, account: 'mm', side: 'buy', qty: '1', price: '100' }));
    const pulled = book.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '1',
        oco: true,
        cancel: true,
        takeProfitOrderId: TP,
        stopLossOrderId: SL,
        mark: '50',
      }),
    );
    expect(pulled.accepted).toBe(false);
    expect(pulled.rejected?.code).toBe('order_not_found');
    expect(pulled.rejected?.message).toContain('invent a trigger');
    expect(pulled.fills).toHaveLength(0);
    expect(liveIds(book)).toEqual([LIQ]);
  });

  it('plain GTC cancel flag without OCO does not pull an unrelated rest', () => {
    const book = new OrderBook('BTC/USDT');
    book.submit(order({ id: PARENT, side: 'sell', qty: '1', price: '110' }));
    const pulled = book.submit(order({ id: PARENT, side: 'sell', qty: '1', price: '110', cancel: true }));
    expect(pulled.accepted).toBe(false);
    expect(liveIds(book)).toEqual([PARENT]);
  });

  it('does not invent a sibling id when only one side is named', () => {
    const book = new OrderBook('BTC/USDT');
    const coincidental = `${PARENT}:tp`;
    book.submit(order({ id: coincidental, side: 'sell', qty: '1', price: '110' }));
    book.submit(order({ id: SL, side: 'buy', qty: '1', price: '90' }));

    const oneSide = order({
      id: PARENT,
      side: 'sell',
      qty: '1',
      oco: true,
      cancel: true,
      stopLossOrderId: SL,
    });
    expect(readOcoPair(book, oneSide)).toBeNull();

    const pulled = book.submit(oneSide);
    expect(pulled.accepted).toBe(false);
    expect(pulled.rejected?.code).toBe('order_not_found');
    expect(pulled.cancellations).toHaveLength(0);
    expect(liveIds(book)).toEqual([SL, coincidental].sort());

    const linked = book.submit(
      order({
        id: PARENT,
        side: 'sell',
        qty: '1',
        oco: true,
        cancel: true,
        takeProfitOrderId: coincidental,
        stopLossOrderId: SL,
      }),
    );
    expect(linked.accepted).toBe(true);
    expect(linked.cancellations.map((c) => c.orderId).sort()).toEqual([SL, coincidental].sort());
    expect(liveIds(book)).toEqual([]);
  });

  it('read helpers treat a missing pair as not set', () => {
    const book = new OrderBook('BTC/USDT');
    expect(wantsOcoCancel({ cancel: true } as EngineOrder & { cancel?: boolean })).toBe(false);
    expect(wantsOcoCancel(order({ id: PARENT, side: 'sell', qty: '1', oco: true, cancel: true }))).toBe(true);
    expect(
      wantsOcoCancel(
        order({
          id: PARENT,
          side: 'sell',
          qty: '1',
          oco: true,
          cancel: true,
          type: 'option' as unknown as EngineOrderType,
        }),
      ),
    ).toBe(false);
    expect(readOcoPair(book, order({ id: PARENT, side: 'sell', qty: '1', cancel: true }))).toBeNull();
    expect(ocoCancelRefuse(2)).toBeNull();
    expect(ocoCancelRefuse(1)?.code).toBe('oco_sibling_terminal');
    expect(ocoCancelRefuse(0)?.code).toBe('order_not_found');
  });
});

import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { OrderBook } from './book.js';
import { MatchingEngine } from './engine.js';
import { MARKET_HALTED } from './halt.js';
import { MARKET_MAINTENANCE } from './maintenance.js';
import { MemoryJournal } from './journal.js';
import type { EngineOrder, OrderSide } from './types.js';

/**
 * S20 acceptance. Given / When / Then from the trade rows, at the engine seam.
 * TRD-0248 TRD-0255 TRD-0325 TRD-0329 TRD-0332 TRD-0333 TRD-0337 TRD-0492 TRD-0516.
 */

const A = parseAmount;
const MARKET = 'BTC/USDT';

const REST = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const RO = '44444444-4444-4444-8444-444444444444';
const RO2 = '55555555-5555-4555-8555-555555555555';
const TP = '66666666-6666-4666-8666-666666666666';
const SL = '77777777-7777-4777-8777-777777777777';
const GTD = '88888888-8888-4888-8888-888888888888';

function limit(spec: {
  id: string;
  account?: string;
  side: OrderSide;
  qty: string;
  price: string;
  reduceOnly?: boolean;
  positionQty?: string;
}): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: A(spec.qty),
    price: A(spec.price),
    stopPrice: null,
    tif: 'GTC',
    ...(spec.reduceOnly ? { reduceOnly: true } : {}),
    ...(spec.positionQty !== undefined ? { positionQty: A(spec.positionQty) } : {}),
  };
}

function build(clock?: () => Date) {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0, ...(clock ? { clock } : {}) });
  return { journal, bus, engine };
}

describe('TRD-0248 maintenance refuses cancel and the order stays', () => {
  it('refuses a customer cancel during maintenance and still allows cancel in halt and venue halt', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, limit({ id: REST, side: 'sell', qty: '1', price: '100' }));
    const entered = await engine.enterMaintenance(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    expect(entered.accepted).toBe(true);
    expect(entered.maintenance).toBe(true);
    expect(engine.isMaintenance(MARKET)).toBe(true);
    expect(engine.isHalted(MARKET)).toBe(false);

    const before = journal.length;
    const refused = await engine.cancel(MARKET, REST);
    expect(refused.cancelled).toBe(false);
    expect(refused.rejected?.code).toBe(MARKET_MAINTENANCE);
    expect(refused.cancellation).toBeNull();
    expect(journal.length).toBe(before);
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.orderId).toBe(REST);

    const crossing = await engine.submit(MARKET, limit({ id: TAKER, account: 'mm', side: 'buy', qty: '1', price: '100' }));
    expect(crossing.accepted).toBe(false);
    expect(crossing.rejected?.code).toBe(MARKET_MAINTENANCE);
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.orderId).toBe(REST);

    const ended = await engine.endMaintenance(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-3' });
    expect(ended.accepted).toBe(true);
    expect(engine.isMaintenance(MARKET)).toBe(false);
    const released = await engine.cancel(MARKET, REST);
    expect(released.cancelled).toBe(true);
    expect(released.cancellation?.remainingQty).toBe(A('1'));
  });

  it('cancel-only halt and venue halt still cancel', async () => {
    const halted = build();
    await halted.engine.submit(MARKET, limit({ id: REST, side: 'sell', qty: '2', price: '100' }));
    await halted.engine.submit(MARKET, limit({ id: TAKER, account: 'mm', side: 'buy', qty: '1', price: '100' }));
    await halted.engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    expect(halted.engine.isMaintenance(MARKET)).toBe(false);

    const remainder = await halted.engine.cancel(MARKET, REST);
    expect(remainder.cancelled).toBe(true);
    expect(formatAmount(remainder.cancellation!.remainingQty)).toBe('1');
    const again = await halted.engine.cancel(MARKET, REST);
    expect(again.cancelled).toBe(false);
    expect(again.cancellation).toBeNull();
    expect(halted.bus.emitted('orderCancelled')).toHaveLength(1);

    const venue = build();
    await venue.engine.submit(MARKET, limit({ id: OTHER, side: 'sell', qty: '1', price: '100' }));
    await venue.engine.haltAll({ operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const pulled = await venue.engine.cancel(MARKET, OTHER);
    expect(pulled.cancelled).toBe(true);
    expect(venue.engine.isMaintenance(MARKET)).toBe(false);
  });
});

describe('TRD-0492 cancel-only still cancels and refuses a new order', () => {
  it('cancels an open order in cancel-only and refuses a new order', async () => {
    const { engine } = build();
    await engine.submit(MARKET, limit({ id: REST, side: 'sell', qty: '1', price: '100' }));
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    expect(engine.isMaintenance(MARKET)).toBe(false);

    const cancelled = await engine.cancel(MARKET, REST);
    expect(cancelled.cancelled).toBe(true);
    const second = await engine.cancel(MARKET, REST);
    expect(second.cancelled).toBe(false);
    expect(second.cancellation).toBeNull();

    const fresh = await engine.submit(MARKET, limit({ id: TAKER, side: 'buy', qty: '1', price: '100' }));
    expect(fresh.accepted).toBe(false);
    expect(fresh.rejected?.code).toBe(MARKET_HALTED);
    expect(engine.isHalted(MARKET)).toBe(true);
    expect(engine.isMaintenance(MARKET)).toBe(false);
  });
});

describe('TRD-0255 reduce-only uses the futures position, not the book net', () => {
  it('preview and place refuse a reduce-only buy on a flat futures position', () => {
    const book = new OrderBook(MARKET);
    book.submit(limit({ id: OTHER, account: 'mm', side: 'buy', qty: '2', price: '100' }));
    book.submit(limit({ id: TAKER, side: 'sell', qty: '2', price: '100' }));
    expect(book.toState().positions).toEqual([
      { accountId: 'desk', qty: '-2' },
      { accountId: 'mm', qty: '2' },
    ]);

    const reduceBuy = limit({ id: RO, side: 'buy', qty: '1', price: '100', reduceOnly: true, positionQty: '0' });
    const preview = book.preview(reduceBuy);
    const placed = book.submit(reduceBuy);
    const again = book.submit(limit({ id: RO2, side: 'buy', qty: '1', price: '100', reduceOnly: true, positionQty: '0' }));

    expect(preview.accepted).toBe(false);
    expect(preview.rejected?.code).toBe('would_increase_position');
    expect(placed.accepted).toBe(false);
    expect(placed.rejected?.code).toBe('would_increase_position');
    expect(placed.resting).toBeNull();
    expect(again.accepted).toBe(false);
    expect(again.rejected?.code).toBe('would_increase_position');
    expect(book.toState().positions).toEqual([
      { accountId: 'desk', qty: '-2' },
      { accountId: 'mm', qty: '2' },
    ]);
    expect(book.toState().bids.map((level) => level.orders.map((order) => order.orderId))).toEqual([]);
  });

  it('does not clip a reduce-only sell larger than the futures position', () => {
    const book = new OrderBook(MARKET);
    book.noteFuturesPosition('desk', A('1'));
    const placed = book.submit(limit({ id: RO, side: 'sell', qty: '2', price: '100', reduceOnly: true }));
    expect(placed.accepted).toBe(false);
    expect(placed.rejected?.code).toBe('would_increase_position');
    expect(placed.resting).toBeNull();
    expect(book.toState().asks).toEqual([]);
  });
});

describe('TRD-0325 a more aggressive reduce-only cancels the less aggressive one', () => {
  it('cancels the resting 50 and does not open a short with the new 60', () => {
    const book = new OrderBook(MARKET);
    book.noteFuturesPosition('desk', A('100'));
    const resting = book.submit(limit({ id: RO, side: 'sell', qty: '50', price: '1000', reduceOnly: true }));
    expect(resting.accepted).toBe(true);

    const next = book.submit(limit({ id: RO2, side: 'sell', qty: '60', price: '999', reduceOnly: true }));
    expect(next.accepted).toBe(true);
    expect(next.fills).toEqual([]);
    expect(next.cancellations.map((row) => [row.orderId, row.reason])).toEqual([[RO, 'reduce_only_displaced']]);
    expect(next.resting?.orderId).toBe(RO2);
    expect(formatAmount(next.resting!.remaining)).toBe('60');
    expect(book.toState().asks.map((level) => level.orders.map((order) => order.orderId))).toEqual([[RO2]]);
    expect(book.toState().positions).toBeUndefined();
  });
});

describe('TRD-0329 take-profit arms only on the profit side', () => {
  it('rejects a take-profit sell below the market and stores a valid one as take-profit', () => {
    const book = new OrderBook(MARKET);
    book.submit(limit({ id: OTHER, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    book.submit(limit({ id: TAKER, account: 'warm', side: 'buy', qty: '1', price: '100' }));
    expect(formatAmount(book.lastPrice!)).toBe('100');

    const wrong = book.submit({
      orderId: TP,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('90'),
      tif: 'GTC',
      triggerRole: 'take_profit',
    });
    expect(wrong.accepted).toBe(false);
    expect(wrong.rejected?.code).toBe('trigger_wrong_side');
    expect(wrong.resting).toBeNull();
    expect(book.toState().stops).toEqual([]);

    const valid = book.submit({
      orderId: RO,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('110'),
      tif: 'GTC',
      triggerRole: 'take_profit',
    });
    expect(valid.accepted).toBe(true);
    expect(valid.resting?.kind).toBe('stop');
    expect(book.toState().stops[0]).toMatchObject({ orderId: RO, triggerRole: 'take_profit' });
  });
});

describe('TRD-0332 a rising print fires a take-profit sell and not a stop-loss sell', () => {
  it('activates the take-profit at 110 and leaves the stop-loss armed', () => {
    const book = new OrderBook(MARKET);
    book.submit(limit({ id: OTHER, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    book.submit(limit({ id: TAKER, account: 'warm', side: 'buy', qty: '1', price: '100' }));

    book.submit({
      orderId: TP,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('110'),
      tif: 'GTC',
      triggerRole: 'take_profit',
    });
    book.submit({
      orderId: SL,
      accountId: 'desk-sl',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('110'),
      tif: 'GTC',
      triggerRole: 'stop_loss',
    });

    book.submit(limit({ id: RO, account: 'mm', side: 'sell', qty: '1', price: '110' }));
    const print = book.submit(limit({ id: RO2, account: 'lift', side: 'buy', qty: '1', price: '110' }));

    expect(formatAmount(print.fills[0]!.price)).toBe('110');
    expect(print.triggered.map((row) => row.orderId)).toEqual([TP]);
    expect(book.toState().stops.map((stop) => stop.orderId)).toEqual([SL]);
    expect(book.toState().stops[0]!.triggerRole).toBe('stop_loss');
  });

  it('does not trigger a stop when the book has no last trade', () => {
    const book = new OrderBook(MARKET);
    const parked = book.submit({
      orderId: SL,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('90'),
      tif: 'GTC',
    });
    expect(parked.accepted).toBe(true);
    expect(parked.triggered).toEqual([]);
    expect(parked.fills).toEqual([]);
    expect(book.lastPrice).toBeNull();
    expect(book.toState().stops.map((stop) => stop.orderId)).toEqual([SL]);
  });
});

describe('TRD-0333 option trigger types and a trigger without a price', () => {
  it('rejects stop_market on an option and does not change a position', () => {
    const book = new OrderBook(MARKET);
    const result = book.submit({
      orderId: SL,
      accountId: 'desk',
      type: 'stop_market' as unknown as EngineOrder['type'],
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('90'),
      tif: 'GTC',
      instrument: 'option',
    });
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('option_trigger_unsupported');
    expect(result.fills).toEqual([]);
    expect(book.currentSequence).toBe(0);
    expect(book.toState().positions).toBeUndefined();
    expect(book.toState().stops).toEqual([]);
  });

  it('rejects a stop that does not name a trigger price', () => {
    const book = new OrderBook(MARKET);
    const result = book.submit({
      orderId: SL,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: null,
      tif: 'GTC',
    });
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('missing_stop_price');
    expect(book.currentSequence).toBe(0);
  });
});

describe('TRD-0337 a mark stop does not fire on a last print', () => {
  it('leaves the stop untriggered when last prints through and the mark is away', () => {
    const book = new OrderBook(MARKET);
    book.submit({
      orderId: SL,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('90'),
      tif: 'GTC',
      triggerBy: 'mark',
    });
    expect(book.applyTriggerReference('mark', A('95'))).toEqual([]);

    book.submit(limit({ id: OTHER, account: 'mm', side: 'buy', qty: '1', price: '90' }));
    const print = book.submit(limit({ id: TAKER, account: 'warm', side: 'sell', qty: '1', price: '90' }));

    expect(formatAmount(book.lastPrice!)).toBe('90');
    expect(print.triggered).toEqual([]);
    expect(print.fills.map((fill) => fill.makerOrderId)).not.toContain(SL);
    expect(book.toState().stops.map((stop) => stop.orderId)).toEqual([SL]);
  });

  it('does not retarget an index stop onto last when the index feed is down', () => {
    const book = new OrderBook(MARKET);
    book.submit({
      orderId: SL,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('90'),
      tif: 'GTC',
      triggerBy: 'index',
    });
    expect(book.applyTriggerReference('index', null)).toEqual([]);
    book.submit(limit({ id: OTHER, account: 'mm', side: 'buy', qty: '1', price: '90' }));
    const print = book.submit(limit({ id: TAKER, account: 'warm', side: 'sell', qty: '1', price: '90' }));
    expect(print.triggered).toEqual([]);
    expect(book.toState().stops.map((stop) => stop.orderId)).toEqual([SL]);
  });

  it('does not fall back to last when the mark is missing', () => {
    const book = new OrderBook(MARKET);
    book.submit({
      orderId: SL,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('90'),
      tif: 'GTC',
      triggerBy: 'mark',
    });
    expect(book.applyTriggerReference('mark', null)).toEqual([]);
    book.submit(limit({ id: OTHER, account: 'mm', side: 'buy', qty: '1', price: '90' }));
    const print = book.submit(limit({ id: TAKER, account: 'warm', side: 'sell', qty: '1', price: '90' }));
    expect(print.triggered).toEqual([]);
    expect(book.toState().stops.map((stop) => stop.orderId)).toEqual([SL]);
  });
});

describe('TRD-0516 a scheduled expiry pass cancels a quiet GTD', () => {
  it('cancels a GTD that is already past expireAt when no other order arrives', async () => {
    let now = new Date('2026-08-25T11:00:00.000Z');
    const { engine } = build(() => now);
    const rested = await engine.submit(MARKET, {
      orderId: GTD,
      accountId: 'desk',
      type: 'limit',
      side: 'sell',
      qty: A('1'),
      price: A('100'),
      stopPrice: null,
      tif: 'GTD',
      expireAt: '2026-08-25T12:00:00.000Z',
    });
    expect(rested.accepted).toBe(true);

    now = new Date('2026-08-25T12:01:00.000Z');
    const swept = await engine.sweepExpiry();
    expect(swept.accepted).toBe(true);
    expect(swept.cancelled.map((row) => [row.orderId, row.reason])).toEqual([[GTD, 'expired']]);
    expect(engine.book(MARKET).toState().asks).toEqual([]);

    const later = await engine.submit(MARKET, limit({ id: TAKER, account: 'mm', side: 'buy', qty: '1', price: '100' }));
    expect(later.accepted).toBe(true);
    expect(later.fills).toEqual([]);
    expect(later.resting?.orderId).toBe(TAKER);
  });

  it('refuses a GTD submit when the expiry clock is missing', async () => {
    const { engine, journal } = build();
    const before = journal.length;
    const result = await engine.submit(MARKET, {
      orderId: GTD,
      accountId: 'desk',
      type: 'limit',
      side: 'sell',
      qty: A('1'),
      price: A('100'),
      stopPrice: null,
      tif: 'GTD',
      expireAt: '2026-08-25T12:00:00.000Z',
    });
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('engine_clock_missing');
    expect(journal.length).toBe(before);
  });

  it('leaves the order and records a miss when the pass cannot read the book', async () => {
    let now = new Date('2026-08-25T11:00:00.000Z');
    const { engine } = build(() => now);
    await engine.submit(MARKET, {
      orderId: GTD,
      accountId: 'desk',
      type: 'limit',
      side: 'sell',
      qty: A('1'),
      price: A('100'),
      stopPrice: null,
      tif: 'GTD',
      expireAt: '2026-08-25T12:00:00.000Z',
    });
    now = new Date('2026-08-25T12:01:00.000Z');
    engine.noteBookUnreadable(MARKET, 'book unreadable');
    const swept = await engine.sweepExpiry();
    expect(swept.accepted).toBe(true);
    expect(swept.cancelled).toEqual([]);
    expect(swept.misses).toEqual([{ marketId: MARKET, code: 'book_unreadable', reason: 'book unreadable' }]);
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.orderId).toBe(GTD);
  });
});

function orderId(n: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
}

describe('legacy stops fire the way main does', () => {
  it('fires every legacy stop in a 70-deep cascade and prints down to 29', () => {
    const book = new OrderBook(MARKET);
    book.submit(limit({ id: orderId(1), account: 'seed-ask', side: 'sell', qty: '1', price: '100' }));
    book.submit(limit({ id: orderId(2), account: 'seed-bid', side: 'buy', qty: '1', price: '100' }));
    expect(formatAmount(book.lastPrice!)).toBe('100');

    for (let price = 99; price >= 29; price -= 1) {
      const rested = book.submit(
        limit({ id: orderId(1_000 + price), account: `bid-${price}`, side: 'buy', qty: '1', price: String(price) }),
      );
      expect(rested.accepted).toBe(true);
    }

    const stopIds: string[] = [];
    for (let price = 99; price >= 30; price -= 1) {
      const id = orderId(2_000 + price);
      stopIds.push(id);
      const parked = book.submit({
        orderId: id,
        accountId: `stop-${price}`,
        type: 'stop',
        side: 'sell',
        qty: A('1'),
        price: null,
        stopPrice: A(String(price)),
        tif: 'GTC',
      });
      expect(parked.accepted).toBe(true);
      expect(parked.resting?.kind).toBe('stop');
    }

    const print = book.submit(limit({ id: orderId(3), account: 'taker', side: 'sell', qty: '1', price: '99' }));
    expect(print.accepted).toBe(true);
    expect(book.toState().stops.map((stop) => stop.stopPrice)).toEqual([]);
    expect(print.triggered.map((row) => row.orderId)).toEqual(stopIds);
    expect(formatAmount(book.lastPrice!)).toBe('29');
  });

  it('triggers legacy stops in insertion order across a cascade', () => {
    const book = new OrderBook(MARKET);
    book.submit(limit({ id: orderId(1), account: 'seed-ask', side: 'sell', qty: '1', price: '100' }));
    book.submit(limit({ id: orderId(2), account: 'seed-bid', side: 'buy', qty: '1', price: '100' }));

    book.submit(limit({ id: orderId(95), account: 'bid-95', side: 'buy', qty: '1', price: '95' }));
    book.submit(limit({ id: orderId(89), account: 'bid-89', side: 'buy', qty: '1', price: '89' }));
    book.submit(limit({ id: orderId(88), account: 'bid-88', side: 'buy', qty: '1', price: '88' }));
    book.submit(limit({ id: orderId(87), account: 'bid-87', side: 'buy', qty: '1', price: '87' }));

    const s1 = orderId(11);
    const s2 = orderId(12);
    const s3 = orderId(13);
    for (const [id, account, stopPrice] of [
      [s1, 'stop-s1', '95'],
      [s2, 'stop-s2', '90'],
      [s3, 'stop-s3', '96'],
    ] as const) {
      const parked = book.submit({
        orderId: id,
        accountId: account,
        type: 'stop',
        side: 'sell',
        qty: A('1'),
        price: null,
        stopPrice: A(stopPrice),
        tif: 'GTC',
      });
      expect(parked.accepted).toBe(true);
    }

    const print = book.submit(limit({ id: orderId(3), account: 'taker', side: 'sell', qty: '1', price: '95' }));
    expect(print.triggered.map((row) => row.orderId)).toEqual([s1, s2, s3]);
  });
});

describe('a priceless reduce-only order does not cancel a protective stop', () => {
  it('refuses a reduce-only market sell and leaves the stop armed when the bid side is empty', () => {
    const book = new OrderBook(MARKET);
    book.submit(limit({ id: OTHER, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    book.submit(limit({ id: TAKER, account: 'desk', side: 'buy', qty: '1', price: '100' }));
    const stop = book.submit({
      orderId: SL,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('90'),
      tif: 'GTC',
      reduceOnly: true,
    });
    expect(stop.accepted).toBe(true);
    expect(book.toState().bids).toEqual([]);

    const close = book.submit({
      orderId: RO,
      accountId: 'desk',
      type: 'market',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: null,
      tif: 'IOC',
      reduceOnly: true,
    });
    expect(close.rejected?.code).toBe('would_increase_position');
    expect(close.cancellations.some((row) => row.reason === 'reduce_only_displaced')).toBe(false);
    expect(book.toState().stops.map((row) => row.orderId)).toEqual([SL]);
  });

  it('closePosition leaves the protective stop when the close cannot fill', async () => {
    const { engine } = build();
    await engine.submit(MARKET, limit({ id: OTHER, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    await engine.submit(MARKET, limit({ id: TAKER, account: 'desk', side: 'buy', qty: '1', price: '100' }));
    const stop = await engine.submit(MARKET, {
      orderId: SL,
      accountId: 'desk',
      type: 'stop',
      side: 'sell',
      qty: A('1'),
      price: null,
      stopPrice: A('90'),
      tif: 'GTC',
      reduceOnly: true,
    });
    expect(stop.accepted).toBe(true);

    const closed = await engine.closePosition(MARKET, { orderId: RO, accountId: 'desk' });
    expect(closed.rejected?.code).toBe('would_increase_position');
    expect(closed.cancellations.some((row) => row.reason === 'reduce_only_displaced')).toBe(false);
    expect(
      engine
        .existingBook(MARKET)!
        .toState()
        .stops.map((row) => row.orderId),
    ).toEqual([SL]);
  });
});

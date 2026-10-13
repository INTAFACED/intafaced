import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal, replayJournal, type EngineJournal, type JournalCommand, type JournalRecord } from './journal.js';
import type { BulkCommandResult, EngineOrder, OrderSide } from './types.js';
import {
  BULK_ATOMIC_PARTIAL,
  installBulkItems,
  type BulkAmendCommand,
  type BulkCancelCommand,
  type BulkPlaceCommand,
} from './bulk-items.js';

installBulkItems();

/**
 * CARD D-bulk hitch. Bulk place/amend/cancel is per-item.
 * Atomic vs non-atomic is stamped. Partial bulk cannot hide rejects.
 */

const MARKET = 'BTC/USDT';
const REST = '11111111-1111-4111-8111-111111111111';
const GOOD = '22222222-2222-4222-8222-222222222222';
const MID = '33333333-3333-4333-8333-333333333333';
const TAIL = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const OPT = '66666666-6666-4666-8666-666666666666';
const UNKNOWN = '77777777-7777-4777-8777-777777777777';
const MAKER = '88888888-8888-4888-8888-888888888888';
const TAKER = '99999999-9999-4999-8999-999999999999';

type BulkEngine = MatchingEngine & {
  bulkPlace(cmd: BulkPlaceCommand): Promise<BulkCommandResult>;
  bulkAmend(cmd: BulkAmendCommand): Promise<BulkCommandResult>;
  bulkCancel(cmd: BulkCancelCommand): Promise<BulkCommandResult>;
};

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price: string | null }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: spec.price === null ? null : parseAmount(spec.price),
    stopPrice: null,
    tif: 'GTC',
  };
}

function build() {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 }) as BulkEngine;
  return { journal, bus, engine };
}

function liveIds(engine: MatchingEngine): string[] {
  return engine.restingOrders(MARKET).map((row) => row.orderId);
}

function statuses(result: BulkCommandResult): string[] {
  return result.results.map((row) => row.status);
}

function tradesFor(
  journal: { read(): readonly JournalRecord[] },
  orderId: string,
): { price: string; qty: string; makerOrderId: string; takerOrderId: string }[] {
  return replayJournal(journal.read())
    .fills.filter((row) => row.fill.makerOrderId === orderId || row.fill.takerOrderId === orderId)
    .map((row) => ({
      price: formatAmount(row.fill.price),
      qty: formatAmount(row.fill.qty),
      makerOrderId: row.fill.makerOrderId,
      takerOrderId: row.fill.takerOrderId,
    }));
}

function submitCount(journal: { read(): readonly JournalRecord[] }, orderId: string): number {
  return journal.read().filter((record) => record.kind === 'submit' && record.order.orderId === orderId).length;
}

/** Cancel append throws. A live rest stays live because the book cancel never runs. */
class CancelAppendBoom implements EngineJournal {
  private readonly inner = new MemoryJournal();

  append(command: JournalCommand): JournalRecord {
    if (command.kind === 'cancel') throw new Error('cancel append failed');
    return this.inner.append(command);
  }

  read(): readonly JournalRecord[] {
    return this.inner.read();
  }

  get length(): number {
    return this.inner.length;
  }

  close(): void {}
}

describe('bulk items — per-item results, explicit atomic, commandId idempotency', () => {
  it('non-atomic mixed place: one rest + one refuse; results length 2; refuse visible; good rest still live', async () => {
    const { engine } = build();
    const result = await engine.bulkPlace({
      commandId: 'place-mixed',
      items: [
        { marketId: MARKET, order: order({ id: REST, side: 'sell', qty: '1', price: '100' }) },
        { marketId: MARKET, order: order({ id: GOOD, side: 'sell', qty: '1', price: null }) },
      ],
    });

    expect(result.atomic).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(statuses(result)).toEqual(['APPLIED', 'REFUSED']);
    expect(result.results[1]!.rejected?.code).toBe('missing_price');
    expect(liveIds(engine)).toEqual([REST]);
  });

  it('atomic true: one good + one refuse ⇒ neither rests; result.atomic === true', async () => {
    const { engine } = build();
    const result = await engine.bulkPlace({
      commandId: 'place-atomic',
      atomic: true,
      items: [
        { marketId: MARKET, order: order({ id: REST, side: 'sell', qty: '1', price: '100' }) },
        { marketId: MARKET, order: order({ id: GOOD, side: 'sell', qty: '1', price: null }) },
      ],
    });

    expect(result.atomic).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.some((row) => row.status === 'REFUSED')).toBe(true);
    expect(result.results[0]!.status).not.toBe('APPLIED');
    expect(result.results[0]!.rejected?.code).toBe(BULK_ATOMIC_PARTIAL);
    expect(result.results[1]!.rejected?.code).toBe('missing_price');
    expect(liveIds(engine)).toEqual([]);
  });

  it('atomic missing/false ⇒ result.atomic === false explicitly', async () => {
    const { engine } = build();
    const missing = await engine.bulkPlace({
      commandId: 'place-atomic-missing',
      items: [{ marketId: MARKET, order: order({ id: REST, side: 'sell', qty: '1', price: '100' }) }],
    });
    const explicitFalse = await engine.bulkPlace({
      commandId: 'place-atomic-false',
      atomic: false,
      items: [{ marketId: MARKET, order: order({ id: GOOD, side: 'sell', qty: '1', price: '101' }) }],
    });

    expect(missing.atomic).toBe(false);
    expect(explicitFalse.atomic).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(missing, 'atomic')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(explicitFalse, 'atomic')).toBe(true);
  });

  it('bulk amend: per-item APPLIED/REFUSED; refuse not hidden', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '2', price: '100' }));
    await engine.submit(MARKET, order({ id: OTHER, side: 'sell', qty: '2', price: '101' }));
    const version = engine.restingOrders(MARKET).find((row) => row.orderId === REST)!.version;

    const result = await engine.bulkAmend({
      commandId: 'amend-mixed',
      items: [
        { marketId: MARKET, amend: { orderId: REST, expectedVersion: version, qty: parseAmount('1') } },
        { marketId: MARKET, amend: { orderId: UNKNOWN, expectedVersion: 1, qty: parseAmount('1') } },
      ],
    });

    expect(result.results).toHaveLength(2);
    expect(statuses(result)).toEqual(['APPLIED', 'REFUSED']);
    expect(result.results[1]!.status).toBe('REFUSED');
    expect(result.results[1]!.rejected?.code).toBe('order_not_found');
    expect(liveIds(engine)).toContain(REST);
    expect(parseAmount(engine.restingOrders(MARKET).find((row) => row.orderId === REST)!.remaining)).toEqual(parseAmount('1'));
  });

  it('bulk cancel: per-item; unknown id is REFUSED not swallowed', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100' }));

    const result = await engine.bulkCancel({
      commandId: 'cancel-mixed',
      items: [
        { marketId: MARKET, orderId: REST },
        { marketId: MARKET, orderId: UNKNOWN },
      ],
    });

    expect(result.results).toHaveLength(2);
    expect(statuses(result)).toEqual(['APPLIED', 'REFUSED']);
    expect(result.results[1]!.rejected?.code).toBe('order_not_found');
    expect(liveIds(engine)).not.toContain(REST);
  });

  it('idempotent commandId: second identical bulkPlace returns same statuses without a second rest', async () => {
    const { journal, engine } = build();
    const cmd: BulkPlaceCommand = {
      commandId: 'place-once',
      items: [{ marketId: MARKET, order: order({ id: REST, side: 'sell', qty: '1', price: '100' }) }],
    };
    const first = await engine.bulkPlace(cmd);
    const submitsAfterFirst = journal.read().filter((record) => record.kind === 'submit').length;
    const second = await engine.bulkPlace(cmd);

    expect(statuses(first)).toEqual(['APPLIED']);
    expect(statuses(second)).toEqual(['APPLIED']);
    expect(second.results[0]!.status).toBe(first.results[0]!.status);
    expect(liveIds(engine).filter((id) => id === REST)).toHaveLength(1);
    expect(journal.read().filter((record) => record.kind === 'submit')).toHaveLength(submitsAfterFirst);
  });

  it('partial cannot hide: 3 items, middle refuses, statuses [APPLIED, REFUSED, APPLIED]', async () => {
    const { engine } = build();
    const result = await engine.bulkPlace({
      commandId: 'place-partial',
      items: [
        { marketId: MARKET, order: order({ id: REST, side: 'sell', qty: '1', price: '100' }) },
        { marketId: MARKET, order: order({ id: MID, side: 'sell', qty: '1', price: null }) },
        { marketId: MARKET, order: order({ id: TAIL, side: 'sell', qty: '1', price: '102' }) },
      ],
    });

    expect(result.results).toHaveLength(3);
    expect(statuses(result)).toEqual(['APPLIED', 'REFUSED', 'APPLIED']);
    expect(result.results[1]!.rejected?.code).toBe('missing_price');
    expect(liveIds(engine)).toEqual([REST, TAIL]);
  });

  it('atomic full fill is not reported unwound; the fill stays; commandId does not replay that refusal', async () => {
    const { journal, engine } = build();
    const cmd: BulkPlaceCommand = {
      commandId: 'place-atomic-full-fill',
      atomic: true,
      items: [
        { marketId: MARKET, order: order({ id: MAKER, account: 'mm', side: 'sell', qty: '1', price: '100' }) },
        { marketId: MARKET, order: order({ id: TAKER, account: 'taker', side: 'buy', qty: '1', price: '100' }) },
        { marketId: MARKET, order: order({ id: GOOD, side: 'sell', qty: '1', price: null }) },
      ],
    };

    const first = await engine.bulkPlace(cmd);
    const submitsAfterFirst = journal.read().filter((record) => record.kind === 'submit').length;
    const second = await engine.bulkPlace(cmd);

    expect(first.results[0]).toMatchObject({ index: 0, status: 'APPLIED', orderId: MAKER });
    expect(first.results[0]!.rejected).toBeUndefined();
    expect(first.results[1]).toMatchObject({ index: 1, status: 'APPLIED', orderId: TAKER });
    expect(first.results[1]!.rejected).toBeUndefined();
    expect(first.results[2]!.status).toBe('REFUSED');
    expect(first.results[2]!.rejected?.code).toBe('missing_price');
    expect(first.results.some((row) => row.rejected?.code === BULK_ATOMIC_PARTIAL)).toBe(false);
    expect(second.results).toEqual(first.results);
    expect(liveIds(engine)).toEqual([]);
    expect(engine.book(MARKET).toState().lastTradePrice).toBe('100');
    expect(tradesFor(journal, TAKER)).toEqual([{ price: '100', qty: '1', makerOrderId: MAKER, takerOrderId: TAKER }]);
    expect(submitCount(journal, MAKER)).toBe(1);
    expect(submitCount(journal, TAKER)).toBe(1);
    expect(journal.read().filter((record) => record.kind === 'submit')).toHaveLength(submitsAfterFirst);
  });

  it('atomic partial fill whose remainder was cancelled is not reported unwound; the fill stays', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: MAKER, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const cmd: BulkPlaceCommand = {
      commandId: 'place-atomic-partial-fill',
      atomic: true,
      items: [
        { marketId: MARKET, order: order({ id: TAKER, account: 'taker', side: 'buy', qty: '2', price: '100' }) },
        { marketId: MARKET, order: order({ id: GOOD, side: 'sell', qty: '1', price: null }) },
      ],
    };

    const first = await engine.bulkPlace(cmd);
    const fillCount = tradesFor(journal, TAKER).length;
    const second = await engine.bulkPlace(cmd);

    expect(first.results[0]).toMatchObject({ index: 0, status: 'APPLIED', orderId: TAKER });
    expect(first.results[0]!.rejected?.code).not.toBe(BULK_ATOMIC_PARTIAL);
    expect(first.results[1]!.rejected?.code).toBe('missing_price');
    expect(second.results).toEqual(first.results);
    expect(second.results[0]!.rejected?.code).not.toBe(BULK_ATOMIC_PARTIAL);
    expect(liveIds(engine)).not.toContain(TAKER);
    expect(liveIds(engine)).not.toContain(MAKER);
    expect(tradesFor(journal, TAKER)).toEqual([{ price: '100', qty: '1', makerOrderId: MAKER, takerOrderId: TAKER }]);
    expect(tradesFor(journal, TAKER)).toHaveLength(fillCount);
    expect(submitCount(journal, TAKER)).toBe(1);
    expect(engine.book(MARKET).toState().lastTradePrice).toBe('100');
  });

  it('atomic amend is all-or-none: a later refusal leaves the earlier order unamended and commandId does not replay a hidden apply', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '2', price: '100' }));
    await engine.submit(MARKET, order({ id: OTHER, side: 'sell', qty: '2', price: '101' }));
    const rest = engine.restingOrders(MARKET).find((row) => row.orderId === REST)!;
    const other = engine.restingOrders(MARKET).find((row) => row.orderId === OTHER)!;
    const cmd: BulkAmendCommand = {
      commandId: 'amend-atomic-later-refuse',
      atomic: true,
      items: [
        { marketId: MARKET, amend: { orderId: REST, expectedVersion: rest.version, qty: parseAmount('1') } },
        { marketId: MARKET, amend: { orderId: OTHER, expectedVersion: other.version + 1, qty: parseAmount('1') } },
      ],
    };
    const amendsBefore = journal.read().filter((record) => record.kind === 'amend').length;

    const first = await engine.bulkAmend(cmd);
    const second = await engine.bulkAmend(cmd);
    const live = engine.restingOrders(MARKET).find((row) => row.orderId === REST)!;
    const otherLive = engine.restingOrders(MARKET).find((row) => row.orderId === OTHER)!;

    expect(first.atomic).toBe(true);
    expect(first.results).toHaveLength(2);
    expect(first.results[0]).toMatchObject({ index: 0, status: 'REFUSED', orderId: REST });
    expect(first.results[0]!.status).not.toBe('OUTCOME_UNKNOWN');
    expect(first.results[0]!.rejected?.code).toBe(BULK_ATOMIC_PARTIAL);
    expect(first.results[1]).toMatchObject({ index: 1, status: 'REFUSED', orderId: OTHER });
    expect(first.results[1]!.rejected?.code).toBe('version_mismatch');
    expect(first.results.every((row) => row.status !== 'OUTCOME_UNKNOWN')).toBe(true);
    expect(second.results).toEqual(first.results);
    expect(live.remaining).toBe(rest.remaining);
    expect(live.price).toBe(rest.price);
    expect(live.version).toBe(rest.version);
    expect(live.sequence).toBe(rest.sequence);
    expect(otherLive.remaining).toBe(other.remaining);
    expect(otherLive.price).toBe(other.price);
    expect(otherLive.version).toBe(other.version);
    expect(engine.book(MARKET).toState().lastTradePrice).toBeNull();
    expect(tradesFor(journal, REST)).toEqual([]);
    expect(tradesFor(journal, OTHER)).toEqual([]);
    expect(journal.read().filter((record) => record.kind === 'amend')).toHaveLength(amendsBefore);
  });

  it('atomic amend replay does not keep an earlier amend when a later option amend is missing strike', async () => {
    const { journal, engine } = build();
    const placed = await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '2', price: '100' }));
    const optionPlaced = await engine.submit(MARKET, {
      ...order({ id: OPT, side: 'sell', qty: '2', price: '101' }),
      strike: parseAmount('100'),
      expiry: '2026-12-31',
    });
    expect(placed.accepted).toBe(true);
    expect(optionPlaced.accepted).toBe(true);
    const rest = engine.restingOrders(MARKET).find((row) => row.orderId === REST)!;
    const opt = engine.restingOrders(MARKET).find((row) => row.orderId === OPT)!;
    const cmd: BulkAmendCommand = {
      commandId: 'amend-atomic-option-missing-strike',
      atomic: true,
      items: [
        { marketId: MARKET, amend: { orderId: REST, expectedVersion: rest.version, qty: parseAmount('1') } },
        { marketId: MARKET, amend: { orderId: OPT, expectedVersion: opt.version, qty: parseAmount('1') } },
      ],
    };
    const amendsBefore = journal.read().filter((record) => record.kind === 'amend').length;

    const first = await engine.bulkAmend(cmd);
    const second = await engine.bulkAmend(cmd);
    const live = engine.restingOrders(MARKET).find((row) => row.orderId === REST)!;
    const optLive = engine.restingOrders(MARKET).find((row) => row.orderId === OPT)!;

    expect(first.atomic).toBe(true);
    expect(first.results).toHaveLength(2);
    expect(first.results[0]).toMatchObject({ index: 0, status: 'REFUSED', orderId: REST });
    expect(first.results[0]!.rejected?.code).toBe(BULK_ATOMIC_PARTIAL);
    expect(first.results[1]).toMatchObject({ index: 1, status: 'REFUSED', orderId: OPT });
    expect(first.results[1]!.rejected?.code).toBe('missing_strike');
    expect(first.results.every((row) => row.status !== 'OUTCOME_UNKNOWN')).toBe(true);
    expect(second.results).toEqual(first.results);
    expect(live.remaining).toBe(rest.remaining);
    expect(live.price).toBe(rest.price);
    expect(live.version).toBe(rest.version);
    expect(live.sequence).toBe(rest.sequence);
    expect(optLive.remaining).toBe(opt.remaining);
    expect(optLive.price).toBe(opt.price);
    expect(optLive.version).toBe(opt.version);
    expect(optLive.sequence).toBe(opt.sequence);
    expect(engine.book(MARKET).toState().lastTradePrice).toBeNull();
    expect(tradesFor(journal, REST)).toEqual([]);
    expect(tradesFor(journal, OPT)).toEqual([]);
    expect(journal.read().filter((record) => record.kind === 'amend')).toHaveLength(amendsBefore);
  });

  it('atomic amend applies every item when every item is accepted', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '2', price: '100' }));
    await engine.submit(MARKET, order({ id: OTHER, side: 'sell', qty: '2', price: '101' }));
    const rest = engine.restingOrders(MARKET).find((row) => row.orderId === REST)!;
    const other = engine.restingOrders(MARKET).find((row) => row.orderId === OTHER)!;

    const result = await engine.bulkAmend({
      commandId: 'amend-atomic-all',
      atomic: true,
      items: [
        { marketId: MARKET, amend: { orderId: REST, expectedVersion: rest.version, qty: parseAmount('1') } },
        { marketId: MARKET, amend: { orderId: OTHER, expectedVersion: other.version, qty: parseAmount('1') } },
      ],
    });

    expect(result.atomic).toBe(true);
    expect(statuses(result)).toEqual(['APPLIED', 'APPLIED']);
    expect(parseAmount(engine.restingOrders(MARKET).find((row) => row.orderId === REST)!.remaining)).toEqual(parseAmount('1'));
    expect(parseAmount(engine.restingOrders(MARKET).find((row) => row.orderId === OTHER)!.remaining)).toEqual(parseAmount('1'));
    expect(engine.book(MARKET).toState().lastTradePrice).toBeNull();
  });

  it('a resting order that is still live after a failed cancel stays an unknown outcome', async () => {
    const journal = new CancelAppendBoom();
    const bus = new MemoryEventBus('svc-matching');
    const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 }) as BulkEngine;
    const cmd: BulkPlaceCommand = {
      commandId: 'place-atomic-cancel-still-live',
      atomic: true,
      items: [
        { marketId: MARKET, order: order({ id: REST, side: 'sell', qty: '1', price: '100' }) },
        { marketId: MARKET, order: order({ id: GOOD, side: 'sell', qty: '1', price: null }) },
      ],
    };

    const first = await engine.bulkPlace(cmd);
    const second = await engine.bulkPlace(cmd);

    expect(first.results[0]).toMatchObject({ index: 0, status: 'OUTCOME_UNKNOWN', orderId: REST });
    expect(first.results[0]!.rejected).toBeUndefined();
    expect(first.results[1]!.rejected?.code).toBe('missing_price');
    expect(second.results).toEqual(first.results);
    expect(liveIds(engine)).toEqual([REST]);
    expect(tradesFor(journal, REST)).toEqual([]);
  });
});

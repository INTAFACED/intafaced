import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryEventBus, type EventBus, type EventName, type Payload, type PublishOptions } from '@intafaced/events';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { MatchingEngine, type SnapshotSink } from './engine.js';
import {
  FileJournal,
  MemoryJournal,
  replay,
  replayFrom,
  serializeBooks,
  type EngineJournal,
  type EngineSnapshot,
  type JournalCommand,
  type JournalRecord,
} from './journal.js';
import type { EngineOrder, EngineOrderType, OrderSide, TimeInForce } from './types.js';

/**
 * The engine: journal-first ordering, the event contract, and §5.4's
 * determinism requirement.
 *
 * Order ids are UUIDs here because the event catalog says so — the engine
 * validates every payload against `packages/events` on publish, so a test that
 * used readable ids would be testing a bus that production does not have.
 */

const MARKET = 'BTC/USDT';
const OTHER_MARKET = 'ETH/USDT';

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
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
}

function order(spec: OrderSpec): EngineOrder {
  return {
    orderId: spec.id ?? uuid(),
    accountId: spec.account ?? 'acct-default',
    type: spec.type ?? (spec.price === undefined ? 'market' : 'limit'),
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: spec.price === undefined ? null : parseAmount(spec.price),
    stopPrice: spec.stopPrice === undefined ? null : parseAmount(spec.stopPrice),
    tif: spec.tif ?? 'GTC',
  };
}

/** A clock that advances one second per read — deterministic, so replays compare. */
function fixedClock(): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1) + tick * 1000);
  };
}

function build(overrides: Partial<ConstructorParameters<typeof MatchingEngine>[0]> = {}) {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, clock: fixedClock(), snapshotEvery: 0, ...overrides });
  return { journal, bus, engine };
}

/** Journal fsync happened; orderFilled never left the process. */
class FailFilledBus implements EventBus {
  private readonly inner = new MemoryEventBus('svc-matching-dead');

  async publish<K extends EventName>(name: K, payload: Payload<K>, opts: PublishOptions = {}) {
    if (name === 'orderFilled') throw new Error('nats down after journal fsync');
    return this.inner.publish(name, payload, opts);
  }

  subscribe: EventBus['subscribe'] = (name, handler, opts) => this.inner.subscribe(name, handler, opts);
  close: EventBus['close'] = () => this.inner.close();
}

// ── Journal-first ordering (§5.1 recovery guarantee) ────────────────────────

describe('the journal comes first', () => {
  it('records the input before the book moves', async () => {
    const { journal, engine } = build();

    await engine.submit(MARKET, order({ id: 'aaaaaaaa-0000-4000-8000-000000000001', side: 'buy', qty: '1', price: '100' }));

    const records = journal.read();
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec?.kind).toBe('submit');
    if (rec?.kind !== 'submit') throw new Error('expected submit journal row');
    expect(rec.marketId).toBe(MARKET);
  });

  it('leaves the book untouched when the journal write fails', async () => {
    class ExplodingJournal implements EngineJournal {
      readonly length = 0;
      append(_command: JournalCommand): JournalRecord {
        throw new Error('disk full');
      }
      read(): readonly JournalRecord[] {
        return [];
      }
      close(): void {}
    }

    const bus = new MemoryEventBus('svc-matching');
    const engine = new MatchingEngine({ journal: new ExplodingJournal(), bus, clock: fixedClock(), snapshotEvery: 0 });

    await expect(engine.submit(MARKET, order({ side: 'buy', qty: '1', price: '100' }))).rejects.toThrow('disk full');

    // An input the journal never took must not exist in the book either —
    // otherwise a replay would rebuild a book missing an order that filled.
    expect(engine.book(MARKET).currentSequence).toBe(0);
    expect(bus.published).toHaveLength(0);
  });

  it('journals cancels too, so replay sees the same input stream', async () => {
    const { journal, engine } = build();
    const id = uuid();

    await engine.submit(MARKET, order({ id, side: 'buy', qty: '1', price: '100' }));
    await engine.cancel(MARKET, id);

    expect(journal.read().map((r) => r.kind)).toEqual(['submit', 'in_flight', 'cancel']);
  });

  it('journals native amend and replay restores retained remaining', async () => {
    const { journal, engine } = build();
    const id = uuid();
    await engine.submit(MARKET, order({ id, side: 'buy', qty: '2', price: '100' }));
    const amended = await engine.amend(MARKET, { orderId: id, expectedVersion: 1, qty: parseAmount('1') });
    expect(amended.priority).toBe('retained');
    expect(journal.read().map((r) => r.kind)).toEqual(['submit', 'in_flight', 'amend']);

    const recovered = serializeBooks(replay(journal.read()));
    expect(recovered).toBe(engine.serialize());
  });

  it('amend on an unknown market does not create a book or journal entry', async () => {
    const { journal, engine } = build();
    const result = await engine.amend('NEVER-TRADED', { orderId: uuid(), expectedVersion: 1, qty: parseAmount('1') });
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('order_not_found');
    expect(journal.length).toBe(0);
    expect(engine.markets).toEqual([]);
  });

  /**
   * W5/W7 — cancel of a never-traded market must not create a phantom book.
   * Depth already used existingBook; cancel used book() and stored empties that
   * then appeared in GET /markets and survived journal replay.
   */
  it('cancel on an unknown market does not create a book or journal entry', async () => {
    const { journal, engine } = build();
    const ghost = 'NEVER-TRADED-MARKET';

    const result = await engine.cancel(ghost, uuid());

    expect(result.cancelled).toBe(false);
    expect(engine.hasMarket(ghost)).toBe(false);
    expect(engine.markets).not.toContain(ghost);
    expect(journal.length).toBe(0);
  });

  /**
   * Legacy journals may still hold cancel-only lines written by the old
   * inventing cancel. Replay must not re-open those phantoms on boot.
   */
  it('replaying a cancel-only journal line does not invent a market', () => {
    const ghost = 'LEGACY-CANCEL-PHANTOM';
    const books = replay([
      {
        kind: 'cancel',
        marketId: ghost,
        at: '2026-01-01T00:00:00.000Z',
        orderId: '00000000-0000-4000-8000-cafebabe0001',
        seq: 1,
      },
    ]);

    expect(books.has(ghost)).toBe(false);
    expect([...books.keys()]).toEqual([]);
  });

  it('replayFrom also refuses to invent a market from a cancel-only tail', () => {
    const ghost = 'LEGACY-TAIL-PHANTOM';
    const books = replayFrom({ journalSeq: 0, books: [] }, [
      {
        kind: 'cancel',
        marketId: ghost,
        at: '2026-01-01T00:00:00.000Z',
        orderId: '00000000-0000-4000-8000-cafebabe0002',
        seq: 1,
      },
    ]);

    expect(books.has(ghost)).toBe(false);
  });

  /**
   * W8 — a rejected first submit used book() and left a never-traded market
   * in the map (depth empty instead of null; GET /markets grew). Cancel and
   * depth already refuse invent; reject must match.
   */
  it('FOK into a virgin market does not leave the market listed', async () => {
    const { journal, engine } = build();
    const ghost = 'NEVER-TRADED-FOK-MKT';

    const result = await engine.submit(ghost, order({ side: 'buy', qty: '1', price: '100', tif: 'FOK' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('fok_unfillable');
    expect(engine.hasMarket(ghost)).toBe(false);
    expect(engine.markets).not.toContain(ghost);
    expect(engine.depth(ghost, 50)).toBeNull();
    // Input still journalled — recovery replays rejects as no-ops, not phantoms.
    expect(journal.read().map((r) => r.kind)).toEqual(['submit']);
  });

  it('IOC into a virgin market does not leave the market listed', async () => {
    const { journal, engine } = build();
    const ghost = 'NEVER-TRADED-IOC-MKT';

    const result = await engine.submit(ghost, order({ side: 'buy', qty: '1', price: '100', tif: 'IOC' }));

    expect(result.accepted).toBe(true);
    expect(result.resting).toBeNull();
    expect(result.fills).toEqual([]);
    expect(result.cancellations).toHaveLength(1);
    expect(engine.hasMarket(ghost)).toBe(false);
    expect(engine.markets).not.toContain(ghost);
    expect(engine.depth(ghost, 50)).toBeNull();
    expect(journal.read().map((r) => r.kind)).toEqual(['submit']);
  });

  it('replaying an IOC-only journal line does not invent a market', () => {
    const ghost = 'LEGACY-IOC-PHANTOM';
    const books = replay([
      {
        kind: 'submit',
        marketId: ghost,
        at: '2026-01-01T00:00:00.000Z',
        seq: 1,
        order: {
          orderId: '00000000-0000-4000-8000-cafebabe0004',
          accountId: 'a',
          type: 'limit',
          side: 'buy',
          qty: '1',
          price: '100',
          stopPrice: null,
          tif: 'IOC',
        },
      },
    ]);

    expect(books.has(ghost)).toBe(false);
  });

  it('structural reject into a virgin market does not invent a market', async () => {
    const { engine } = build();
    const ghost = 'NEVER-TRADED-BAD-QTY';

    const result = await engine.submit(ghost, order({ side: 'buy', qty: '0', price: '100' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('invalid_qty');
    expect(engine.hasMarket(ghost)).toBe(false);
    expect(engine.depth(ghost, 50)).toBeNull();
  });

  it('replaying a reject-only journal line does not invent a market', () => {
    const ghost = 'LEGACY-REJECT-PHANTOM';
    const books = replay([
      {
        kind: 'submit',
        marketId: ghost,
        at: '2026-01-01T00:00:00.000Z',
        seq: 1,
        order: {
          orderId: '00000000-0000-4000-8000-cafebabe0003',
          accountId: 'a',
          type: 'limit',
          side: 'buy',
          qty: '1',
          price: '100',
          stopPrice: null,
          tif: 'FOK',
        },
      },
    ]);

    expect(books.has(ghost)).toBe(false);
  });

  it('reject on a real market leaves that market listed', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ account: 'maker', side: 'sell', qty: '1', price: '100' }));

    const result = await engine.submit(MARKET, order({ account: 'taker', side: 'buy', qty: '9', price: '100', tif: 'FOK' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('fok_unfillable');
    expect(engine.hasMarket(MARKET)).toBe(true);
    expect(engine.depth(MARKET, 50)).not.toBeNull();
  });

  it('does not journal an input the kill-switch refused', async () => {
    const { journal, bus, engine } = build({ enabled: false });

    const result = await engine.submit(MARKET, order({ side: 'buy', qty: '1', price: '100' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('engine_disabled');
    expect(journal.length).toBe(0);
    expect(bus.published).toHaveLength(0);
  });

  it('resumes accepting once the operator flips the switch back', async () => {
    const { engine } = build({ enabled: false });
    engine.setEnabled(true);

    const result = await engine.submit(MARKET, order({ side: 'buy', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });
});

// ── Events (§10 — the bus is a contract) ────────────────────────────────────

describe('events', () => {
  it('publishes orderAccepted for an order that rests', async () => {
    const { bus, engine } = build();
    const id = uuid();

    const result = await engine.submit(MARKET, order({ id, side: 'buy', qty: '1', price: '100' }));

    const accepted = bus.emitted('orderAccepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload).toEqual({ orderId: id, marketId: MARKET, sequence: result.sequence });
    expect(accepted[0]!.subject).toBe('intafaced.matching.order.accepted');
  });

  it('publishes orderFilled with decimal-string amounts and the engine sequence', async () => {
    const { bus, engine } = build();
    const maker = uuid();
    const taker = uuid();

    await engine.submit(MARKET, order({ id: maker, account: 'mm', side: 'sell', qty: '2', price: '100.25' }));
    const result = await engine.submit(MARKET, order({ id: taker, account: 'tk', side: 'buy', qty: '1.5', price: '100.25' }));

    const filled = bus.emitted('orderFilled');
    expect(filled).toHaveLength(1);
    expect(filled[0]!.payload).toMatchObject({
      marketId: MARKET,
      makerOrderId: maker,
      takerOrderId: taker,
      price: '100.25',
      qty: '1.5',
      sequence: result.fills[0]!.sequence,
      makerAccountId: 'mm',
      takerAccountId: 'tk',
    });
  });

  it('publishes orderCancelled for an IOC remainder', async () => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'sell', qty: '1', price: '100' }));

    const id = uuid();
    await engine.submit(MARKET, order({ id, account: 'tk', side: 'buy', qty: '3', price: '100', tif: 'IOC' }));

    const cancelled = bus.emitted('orderCancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.payload).toMatchObject({ orderId: id, marketId: MARKET, remainingQty: '2' });
  });

  it('publishes orderCancelled when a self-rest is expired', async () => {
    const { bus, engine } = build();
    const own = uuid();
    const stranger = uuid();

    await engine.submit(MARKET, order({ id: own, account: 'same', side: 'buy', qty: '1', price: '100' }));
    await engine.submit(MARKET, order({ id: stranger, account: 'other', side: 'buy', qty: '2', price: '100' }));
    bus.reset();
    const result = await engine.submit(MARKET, order({ account: 'same', side: 'sell', qty: '1', price: '100', tif: 'IOC' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.makerOrderId).toBe(stranger);
    expect(result.cancellations[0]!.orderId).toBe(own);
    expect(result.cancellations[0]!.reason).toBe('self_trade_prevention');
    const cancelled = bus.emitted('orderCancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.payload).toMatchObject({ orderId: own, marketId: MARKET, remainingQty: '1', reason: 'self_trade_prevention' });
    expect(engine.book(MARKET).toState().bids[0]?.orders[0]?.orderId).toBe(stranger);
    expect(result.surveillanceCases).toEqual([{ accountId: 'same', marketId: MARKET, reason: 'self_trade', status: 'open' }]);
    expect(engine.openSurveillanceCases()).toEqual(result.surveillanceCases);
    expect(result.surveillanceCases![0]).not.toHaveProperty('fine');
    expect(result.surveillanceCases![0]).not.toHaveProperty('amount');
  });

  it('publishes orderTriggered when a trade reaches a resting stop, before the fills it then makes', async () => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'b1', side: 'buy', qty: '1', price: '99' }));
    await engine.submit(MARKET, order({ account: 'b2', side: 'buy', qty: '5', price: '98' }));
    const stop = uuid();
    await engine.submit(MARKET, order({ id: stop, account: 'st', type: 'stop', side: 'sell', qty: '1', stopPrice: '99' }));
    expect(bus.emitted('orderTriggered')).toHaveLength(0);

    await engine.submit(MARKET, order({ account: 'tk', side: 'sell', qty: '1', price: '99' }));

    const triggered = bus.emitted('orderTriggered');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.payload).toMatchObject({
      orderId: stop,
      marketId: MARKET,
      triggerBy: 'last',
      stopPrice: '99',
      referencePrice: '99',
    });
    const at = (triggered[0]!.payload as { sequence: number }).sequence;
    const fill = bus.emitted('orderFilled').find((e) => (e.payload as { takerOrderId: string }).takerOrderId === stop);
    expect(fill!.payload).toMatchObject({ price: '98', qty: '1' });
    expect((fill!.payload as { sequence: number }).sequence).toBeGreaterThan(at);
    // Published in sequence order: the trigger comes before the fill it led to.
    const published = bus.published.map((e) => e.payload);
    expect(published.indexOf(triggered[0]!.payload)).toBeLessThan(published.indexOf(fill!.payload));
  });

  it('publishes orderTriggered for a stop already through its price on arrival, with the last price it met', async () => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'buy', qty: '5', price: '100' }));
    await engine.submit(MARKET, order({ account: 'tk', side: 'sell', qty: '1', price: '100' }));
    bus.reset();

    const stop = uuid();
    const result = await engine.submit(MARKET, order({ id: stop, account: 'st', type: 'stop', side: 'sell', qty: '1', stopPrice: '101' }));

    expect(result.fills).toHaveLength(1);
    const triggered = bus.emitted('orderTriggered');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.payload).toMatchObject({
      orderId: stop,
      sequence: result.sequence,
      triggerBy: 'last',
      stopPrice: '101',
      referencePrice: '100',
    });
  });

  it('publishes orderTriggered when an amend moves a stop through the last price', async () => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'buy', qty: '5', price: '100' }));
    await engine.submit(MARKET, order({ account: 'tk', side: 'sell', qty: '1', price: '100' }));
    const stop = uuid();
    await engine.submit(MARKET, order({ id: stop, account: 'st', type: 'stop', side: 'sell', qty: '1', stopPrice: '90' }));
    bus.reset();

    await engine.amend(MARKET, { orderId: stop, expectedVersion: 1, stopPrice: parseAmount('100') });

    // The fill the fired stop made is published once, though the amend reports it on the result and on the trigger.
    expect(bus.emitted('orderFilled')).toHaveLength(1);
    const triggered = bus.emitted('orderTriggered');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.payload).toMatchObject({ orderId: stop, stopPrice: '100', referencePrice: '100' });
  });

  it.each([
    ['a plain stop', {}],
    ['a stop-loss', { triggerRole: 'stop_loss' as const }],
  ])('publishes the price that reached %s when a sweep goes through it, not the stop price', async (_name, role) => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'b1', side: 'buy', qty: '1', price: '99' }));
    await engine.submit(MARKET, order({ account: 'b2', side: 'buy', qty: '1', price: '97' }));
    await engine.submit(MARKET, order({ account: 'b3', side: 'buy', qty: '5', price: '95' }));
    const stop = uuid();
    await engine.submit(MARKET, { ...order({ id: stop, account: 'st', type: 'stop', side: 'sell', qty: '1', stopPrice: '98' }), ...role });
    bus.reset();

    // One sell sweeps 99 then 97: no trade prints at 98, and the last price passes the stop on its way to 97.
    await engine.submit(MARKET, order({ account: 'tk', side: 'sell', qty: '2', price: '97' }));

    const triggered = bus.emitted('orderTriggered');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.payload).toMatchObject({ orderId: stop, triggerBy: 'last', stopPrice: '98', referencePrice: '97' });
  });

  it("records a mark stop's trigger with the mark that reached it", () => {
    const book = new OrderBook(MARKET);
    const stop = uuid();
    book.submit({ ...order({ id: stop, account: 'st', type: 'stop', side: 'sell', qty: '1', stopPrice: '90' }), triggerBy: 'mark' });
    expect(book.applyTriggerReference('mark', parseAmount('95'))).toEqual([]);

    const fired = book.applyTriggerReference('mark', parseAmount('88.5'));

    expect(fired).toHaveLength(1);
    expect(fired[0]!.orderId).toBe(stop);
    expect(fired[0]!.trigger).toEqual({ by: 'mark', stopPrice: parseAmount('90'), reference: parseAmount('88.5') });
  });

  it("republishes an amend-fired stop's fill once on recovery, under the key it had live", async () => {
    const { journal, bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'buy', qty: '5', price: '100' }));
    await engine.submit(MARKET, order({ account: 'tk', side: 'sell', qty: '1', price: '100' }));
    const stop = uuid();
    await engine.submit(MARKET, order({ id: stop, account: 'st', type: 'stop', side: 'sell', qty: '1', stopPrice: '90' }));
    await engine.amend(MARKET, { orderId: stop, expectedVersion: 1, stopPrice: parseAmount('100') });
    const live = bus.emitted('orderFilled');
    expect(live.filter((e) => (e.payload as { takerOrderId: string }).takerOrderId === stop)).toHaveLength(1);

    const recoveryBus = new MemoryEventBus('svc-matching');
    const recovered = new MatchingEngine({ journal, bus: recoveryBus, clock: fixedClock(), snapshotEvery: 0 });
    await recovered.recover();

    const again = recoveryBus.emitted('orderFilled');
    expect(again.map((e) => e.idempotencyKey)).toEqual(live.map((e) => e.idempotencyKey));
    expect(recoveryBus.emitted('orderTriggered').map((e) => e.idempotencyKey)).toEqual(
      bus.emitted('orderTriggered').map((e) => e.idempotencyKey),
    );
  });

  it('publishes nothing at all for a rejected order', async () => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'sell', qty: '1', price: '100' }));
    bus.reset();

    const result = await engine.submit(MARKET, order({ account: 'tk', side: 'buy', qty: '9', price: '100', tif: 'FOK' }));

    expect(result.accepted).toBe(false);
    expect(bus.published).toHaveLength(0);
  });

  it('emits in engine-sequence order, so a consumer replaying the subject sees the book order', async () => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'sell', qty: '1', price: '100' }));
    await engine.submit(MARKET, order({ account: 'mm', side: 'sell', qty: '1', price: '101' }));
    bus.reset();

    await engine.submit(MARKET, order({ account: 'tk', side: 'buy', qty: '5', tif: 'IOC' }));

    const sequences = bus.published.map((e) => (e.payload as { sequence: number }).sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('uses the engine sequence as the fill idempotency key — a redelivery finds the original', async () => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const result = await engine.submit(MARKET, order({ account: 'tk', side: 'buy', qty: '1', price: '100' }));

    const filled = bus.emitted('orderFilled')[0]!;
    expect(filled.idempotencyKey).toBe(`matching.order.filled:${MARKET}:${result.fills[0]!.sequence}`);
  });

  it('never puts a JS number where an amount belongs', async () => {
    const { bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'sell', qty: '2', price: '100.125' }));
    await engine.submit(MARKET, order({ account: 'tk', side: 'buy', qty: '5', price: '100.125', tif: 'IOC' }));

    const decimal = /^-?\d+(\.\d{1,18})?$/;
    const amountFields = ['price', 'qty', 'remainingQty'];
    for (const envelope of bus.published) {
      for (const field of amountFields) {
        const value = (envelope.payload as Record<string, unknown>)[field];
        if (value === undefined) continue;
        expect(typeof value, `${envelope.subject}.${field}`).toBe('string');
        expect(value as string).toMatch(decimal);
      }
    }
  });

  it('keeps markets independent', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const result = await engine.submit(OTHER_MARKET, order({ account: 'tk', side: 'buy', qty: '1', price: '100' }));

    expect(result.fills).toHaveLength(0);
    expect(engine.markets).toEqual([MARKET, OTHER_MARKET].sort());
  });
});

// ── Recovery and snapshots (§5.1) ───────────────────────────────────────────

describe('recovery', () => {
  it('rebuilds the books from the journal and republishes fills with the original keys', async () => {
    const { journal, bus, engine } = build();

    await engine.submit(MARKET, order({ account: 'mm', side: 'sell', qty: '5', price: '100' }));
    await engine.submit(MARKET, order({ account: 'mm', side: 'buy', qty: '3', price: '99' }));
    await engine.submit(OTHER_MARKET, order({ account: 'mm', side: 'sell', qty: '2', price: '2000' }));
    const cancelMe = uuid();
    await engine.submit(MARKET, order({ id: cancelMe, account: 'mm', side: 'buy', qty: '1', price: '98' }));
    await engine.cancel(MARKET, cancelMe);
    await engine.submit(MARKET, order({ account: 'tk', side: 'buy', qty: '2', price: '100' }));

    const live = engine.serialize();
    const liveFills = bus.emitted('orderFilled');
    expect(liveFills.length).toBeGreaterThan(0);

    const recoveryBus = new MemoryEventBus('svc-matching');
    const recovered = new MatchingEngine({ journal, bus: recoveryBus, clock: fixedClock(), snapshotEvery: 0 });
    const report = await recovered.recover();

    expect(report.records).toBe(journal.length);
    expect(report.markets).toBe(2);
    expect(recovered.serialize()).toBe(live);
    const recoveredFills = recoveryBus.emitted('orderFilled');
    expect(recoveredFills.map((e) => e.idempotencyKey)).toEqual(liveFills.map((e) => e.idempotencyKey));
    expect(recoveredFills.map((e) => e.payload.sequence)).toEqual(liveFills.map((e) => e.payload.sequence));
    expect(recoveryBus.emitted('orderAccepted')).toHaveLength(0);
  });

  it('republishes a stop trigger on recovery with its original key and price', async () => {
    const { journal, bus, engine } = build();
    await engine.submit(MARKET, order({ account: 'b1', side: 'buy', qty: '1', price: '99' }));
    await engine.submit(MARKET, order({ account: 'b2', side: 'buy', qty: '5', price: '98' }));
    await engine.submit(MARKET, order({ account: 'st', type: 'stop', side: 'sell', qty: '1', stopPrice: '99' }));
    await engine.submit(MARKET, order({ account: 'tk', side: 'sell', qty: '1', price: '99' }));
    const live = bus.emitted('orderTriggered');
    expect(live).toHaveLength(1);

    const recoveryBus = new MemoryEventBus('svc-matching');
    const recovered = new MatchingEngine({ journal, bus: recoveryBus, clock: fixedClock(), snapshotEvery: 0 });
    await recovered.recover();
    const again = recoveryBus.emitted('orderTriggered');
    expect(again.map((e) => e.idempotencyKey)).toEqual(live.map((e) => e.idempotencyKey));
    expect(again.map((e) => e.payload)).toEqual(live.map((e) => e.payload));
  });

  it('recover after journal fsync without emit republishes the same fill, not a new one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'matching-recover-fill-'));
    const path = join(dir, 'engine.ndjson');
    const journal = new FileJournal(path);
    const dead = new FailFilledBus();
    const live = new MatchingEngine({ journal, bus: dead, clock: fixedClock(), snapshotEvery: 0 });
    const maker = uuid();
    const taker = uuid();

    await live.submit(MARKET, order({ id: maker, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    await expect(live.submit(MARKET, order({ id: taker, account: 'tk', side: 'buy', qty: '1', price: '100' }))).rejects.toThrow(
      'nats down after journal fsync',
    );
    expect(journal.read()).toHaveLength(2);
    journal.close();

    const recoveredJournal = new FileJournal(path);
    const recoveryBus = new MemoryEventBus('svc-matching');
    const recovered = new MatchingEngine({
      journal: recoveredJournal,
      bus: recoveryBus,
      clock: fixedClock(),
      snapshotEvery: 0,
    });
    await recovered.recover();

    const fills = recoveryBus.emitted('orderFilled');
    expect(fills).toHaveLength(1);
    const fill = fills[0]!;
    expect(fill.payload.makerOrderId).toBe(maker);
    expect(fill.payload.takerOrderId).toBe(taker);
    expect(fill.idempotencyKey).toBe(`matching.order.filled:${MARKET}:${fill.payload.sequence}`);

    const againBus = new MemoryEventBus('svc-matching');
    const again = new MatchingEngine({ journal: recoveredJournal, bus: againBus, clock: fixedClock(), snapshotEvery: 0 });
    await again.recover();
    const againFills = againBus.emitted('orderFilled');
    expect(againFills).toHaveLength(1);
    expect(againFills[0]!.idempotencyKey).toBe(fill.idempotencyKey);
    expect(againFills[0]!.payload.sequence).toBe(fill.payload.sequence);
    expect(againFills[0]!.payload.makerOrderId).toBe(maker);
    expect(againFills[0]!.payload.takerOrderId).toBe(taker);
    expect(againFills[0]!.payload.qty).toBe(fill.payload.qty);
    expect(againFills[0]!.payload.price).toBe(fill.payload.price);
    recoveredJournal.close();
  });

  it('writes a snapshot every N journal records and no more often', async () => {
    const writes: EngineSnapshot[] = [];
    const sink: SnapshotSink = { write: (s) => void writes.push(s) };
    const { engine } = build({ snapshotEvery: 3, snapshotSink: sink });

    for (let i = 0; i < 7; i++) await engine.submit(MARKET, order({ account: 'mm', side: 'buy', qty: '1', price: '100' }));

    expect(writes).toHaveLength(2);
    expect(writes.map((w) => w.journalSeq)).toEqual([3, 6]);
  });

  it('replays forward from a snapshot to the same state as a full replay', async () => {
    const { journal, engine } = build();

    for (let i = 0; i < 12; i++) {
      await engine.submit(
        MARKET,
        order({ account: `acct-${i % 3}`, side: i % 2 === 0 ? 'buy' : 'sell', qty: '1', price: i % 2 === 0 ? '99' : '101' }),
      );
    }
    const snapshot = engine.snapshot();
    for (let i = 0; i < 8; i++) {
      await engine.submit(
        MARKET,
        order({ account: 'late', side: i % 2 === 0 ? 'sell' : 'buy', qty: '2', price: i % 2 === 0 ? '99' : '101' }),
      );
    }

    const full = serializeBooks(replay(journal.read()));
    const incremental = serializeBooks(replayFrom(snapshot, journal.read()));

    expect(incremental).toBe(full);
    expect(incremental).toBe(engine.serialize());
  });
});

// ── §5.4 DETERMINISM ────────────────────────────────────────────────────────

/**
 * Deterministic PRNG. `Math.random()` in a determinism test would be a joke at
 * its own expense — the sequence has to be reproducible from a seed so a
 * failing run can be replayed by a human.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRICES = ['95', '96', '97', '97.5', '98', '99', '99.5', '100', '100.5', '101', '102', '103', '105'] as const;
const QTYS = ['0.5', '1', '1.5', '2', '3', '5', '0.000000000000000001'] as const;
const MARKETS = [MARKET, OTHER_MARKET] as const;
const ACCOUNTS = ['acct-0', 'acct-1', 'acct-2', 'acct-3', 'acct-4', 'acct-5'] as const;

interface Workload {
  journal: MemoryJournal;
  liveState: string;
  fills: number;
  accepted: number;
  rejected: number;
}

/** ~1000 mixed operations across two markets, driven through the real engine. */
async function runWorkload(seed: number, operations = 1000): Promise<Workload> {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, clock: fixedClock(), snapshotEvery: 0 });

  const submitted: Array<{ marketId: string; orderId: string }> = [];
  let fills = 0;
  let accepted = 0;
  let rejected = 0;
  let n = 0;

  for (let i = 0; i < operations; i++) {
    const marketId = pick(MARKETS);

    if (rand() < 0.12 && submitted.length > 0) {
      const target = submitted[Math.floor(rand() * submitted.length)] as { marketId: string; orderId: string };
      await engine.cancel(target.marketId, target.orderId);
      continue;
    }

    const roll = rand();
    const type: EngineOrderType = roll < 0.62 ? 'limit' : roll < 0.8 ? 'market' : roll < 0.92 ? 'stop' : 'stop_limit';
    const side: OrderSide = rand() < 0.5 ? 'buy' : 'sell';
    const needsPrice = type === 'limit' || type === 'stop_limit';
    const tif: TimeInForce = needsPrice
      ? pick(['GTC', 'GTC', 'GTC', 'GTC', 'IOC', 'FOK', 'PO'] as const)
      : pick(['IOC', 'FOK', 'GTC'] as const);

    n += 1;
    const orderId = `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
    const result = await engine.submit(marketId, {
      orderId,
      accountId: pick(ACCOUNTS),
      type,
      side,
      qty: parseAmount(pick(QTYS)),
      price: needsPrice ? parseAmount(pick(PRICES)) : null,
      stopPrice: type === 'stop' || type === 'stop_limit' ? parseAmount(pick(PRICES)) : null,
      tif,
    });

    submitted.push({ marketId, orderId });
    fills += result.fills.length;
    for (const t of result.triggered) fills += t.fills.length;
    if (result.accepted) accepted += 1;
    else rejected += 1;
  }

  return { journal, liveState: engine.serialize(), fills, accepted, rejected };
}

describe('§5.4 determinism — replay the journal twice, get byte-identical state', () => {
  it('produces identical state on two independent replays of ~1000 mixed operations', async () => {
    const workload = await runWorkload(0xc0ffee);
    const records = workload.journal.read();

    expect(records.length).toBeGreaterThan(900);

    const first = serializeBooks(replay(records));
    const second = serializeBooks(replay(records));

    // Byte-identical, not deep-equal: two different Map iteration orders would
    // pass a deep-equal and still stream different depth to every client.
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(200);
  });

  it('replay reconstructs exactly the state the live engine reached', async () => {
    const workload = await runWorkload(0xc0ffee);

    expect(serializeBooks(replay(workload.journal.read()))).toBe(workload.liveState);
  });

  it('the workload is worth asserting on — it fills, rests, and rejects', async () => {
    const workload = await runWorkload(0xc0ffee);

    // Guards against the whole suite passing on two identically empty books.
    expect(workload.fills).toBeGreaterThan(100);
    expect(workload.accepted).toBeGreaterThan(500);
    expect(workload.rejected).toBeGreaterThan(0);
    expect(workload.liveState).toContain('"orders"');
  });

  it('is reproducible across processes-worth of engines: same journal, same books', async () => {
    const a = await runWorkload(0x5eed);
    const b = await runWorkload(0x5eed);

    // Same seed → same inputs → same journal → same books, all the way down.
    expect(JSON.stringify(b.journal.read())).toBe(JSON.stringify(a.journal.read()));
    expect(b.liveState).toBe(a.liveState);
  });

  it('a different seed produces a different book — the test can actually fail', async () => {
    const a = await runWorkload(0xc0ffee);
    const b = await runWorkload(0x1234);

    expect(b.liveState).not.toBe(a.liveState);
  });

  it('carries no floating-point value into the replayed state', async () => {
    const workload = await runWorkload(0xc0ffee);
    const state = serializeBooks(replay(workload.journal.read()));

    expect(state).not.toMatch(/:\s*-?\d+\.\d/);
    expect(state).not.toMatch(/[eE][+-]\d/);
    // And every quantity that did survive is still a well-formed decimal string.
    for (const match of state.matchAll(/"(?:price|remaining|qty|stopPrice|lastTradePrice)":"([^"]+)"/g)) {
      expect(match[1]!).toMatch(/^-?\d+(\.\d{1,18})?$/);
    }
  });

  it('the journal itself is a decimal-string document', async () => {
    const workload = await runWorkload(0xc0ffee);
    const encoded = JSON.stringify(workload.journal.read());

    expect(encoded).not.toMatch(/"(?:qty|price|stopPrice)":\s*-?\d/);
    expect(formatAmount(parseAmount('0.000000000000000001'))).toBe('0.000000000000000001');
  });
});

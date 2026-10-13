import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { OrderBook } from './book.js';
import { MatchingEngine } from './engine.js';
import { MemoryJournal, replay, replayFrom, serializeBooks, toWire } from './journal.js';
import { SESSION_UNSUPPORTED } from './mass-cancel.js';
import { MISSING_SESSION, SESSION_GONE, replayDeadSessions, sessionOrderIds } from './session.js';
import { installCodFence } from './cod-fence.js';
import type { EngineOrder, OrderSide } from './types.js';

installCodFence();

/**
 * Cancel-on-disconnect. Session-dead pulls tagged rests. New tagged submits refuse.
 * Untagged rests stay. Missing session refuses. Not mass-cancel.
 */

const MARKET = 'BTC/USDT';
const OTHER = 'ETH/USDT';
const REST = '11111111-1111-4111-8111-111111111111';
const KEEP = '22222222-2222-4222-8222-222222222222';
const TAKER = '33333333-3333-4333-8333-333333333333';
const OTHER_REST = '44444444-4444-4444-8444-444444444444';
const STOP = '55555555-5555-4555-8555-555555555555';
const AFTER = '66666666-6666-4666-8666-666666666666';

function order(spec: {
  id: string;
  account?: string;
  side: OrderSide;
  qty: string;
  price?: string;
  type?: EngineOrder['type'];
  stopPrice?: string;
  sessionId?: string;
}): EngineOrder {
  const type = spec.type ?? (spec.price === undefined ? 'market' : 'limit');
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type,
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: spec.price === undefined ? null : parseAmount(spec.price),
    stopPrice: spec.stopPrice === undefined ? null : parseAmount(spec.stopPrice),
    tif: 'GTC',
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
  };
}

function liveIds(engine: MatchingEngine, marketId: string): string[] {
  const book = engine.existingBook(marketId);
  if (!book) return [];
  const state = book.toState();
  return [
    ...state.bids.flatMap((l) => l.orders.map((o) => o.orderId)),
    ...state.asks.flatMap((l) => l.orders.map((o) => o.orderId)),
    ...state.stops.map((s) => s.orderId),
  ].sort();
}

function restingIds(books: ReadonlyMap<string, OrderBook>, marketId: string): string[] {
  const book = books.get(marketId);
  if (!book) return [];
  const state = book.toState();
  return [
    ...state.bids.flatMap((l) => l.orders.map((o) => o.orderId)),
    ...state.asks.flatMap((l) => l.orders.map((o) => o.orderId)),
    ...state.stops.map((s) => s.orderId),
  ].sort();
}

function build() {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 });
  return { journal, bus, engine };
}

describe('session-dead — cancel-on-disconnect', () => {
  it('cancels tagged rests on every market and reports session_dead so the hold can release', async () => {
    const { engine, bus } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', sessionId: 'sess-1' }));
    await engine.submit(OTHER, order({ id: OTHER_REST, side: 'sell', qty: '2', price: '200', sessionId: 'sess-1' }));
    await engine.submit(MARKET, order({ id: KEEP, account: 'mm', side: 'sell', qty: '3', price: '101', sessionId: 'sess-2' }));

    const dead = await engine.sessionDead({ sessionId: 'sess-1' });

    expect(dead.accepted).toBe(true);
    expect(dead.sessionId).toBe('sess-1');
    expect(dead.cancellations.map((c) => [c.orderId, c.reason])).toEqual([
      [REST, 'session_dead'],
      [OTHER_REST, 'session_dead'],
    ]);
    expect(liveIds(engine, MARKET)).toEqual([KEEP]);
    expect(liveIds(engine, OTHER)).toEqual([]);
    expect(engine.isSessionDead('sess-1')).toBe(true);
    expect(engine.isSessionDead('sess-2')).toBe(false);

    expect(
      bus
        .emitted('orderCancelled')
        .map((e) => e.payload.orderId)
        .sort(),
    ).toEqual([OTHER_REST, REST].sort());
  });

  it('does not fill a tagged rest after session-dead — a later cross misses it', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', sessionId: 'sess-1' }));
    await engine.sessionDead({ sessionId: 'sess-1' });

    const take = await engine.submit(MARKET, order({ id: TAKER, account: 'mm', side: 'buy', qty: '1', price: '100' }));

    expect(take.accepted).toBe(true);
    expect(take.fills).toEqual([]);
    expect(take.resting?.orderId).toBe(TAKER);
    expect(liveIds(engine, MARKET)).toEqual([TAKER]);
  });

  it('leaves an untagged rest — the engine does not invent a session', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: KEEP, side: 'sell', qty: '1', price: '100' }));
    const dead = await engine.sessionDead({ sessionId: 'sess-1' });

    expect(dead.accepted).toBe(true);
    expect(dead.cancellations).toEqual([]);
    expect(liveIds(engine, MARKET)).toEqual([KEEP]);
  });

  it('pulls a tagged stop and leaves a stranger stop', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: STOP, side: 'buy', qty: '1', type: 'stop', stopPrice: '110', sessionId: 'sess-1' }));
    await engine.submit(MARKET, order({ id: KEEP, account: 'mm', side: 'sell', qty: '1', type: 'stop', stopPrice: '90' }));

    const dead = await engine.sessionDead({ sessionId: 'sess-1' });

    expect(dead.cancellations.map((c) => c.orderId)).toEqual([STOP]);
    expect(liveIds(engine, MARKET)).toEqual([KEEP]);
  });

  it('refuses a new submit tagged with the dead session and journals nothing for that submit', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', sessionId: 'sess-1' }));
    await engine.sessionDead({ sessionId: 'sess-1' });
    const before = journal.length;

    const result = await engine.submit(MARKET, order({ id: AFTER, side: 'buy', qty: '1', price: '99', sessionId: 'sess-1' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(SESSION_GONE);
    expect(result.sequence).toBeNull();
    expect(result.fills).toEqual([]);
    expect(journal.length).toBe(before);
  });

  it('still accepts a submit with a live session or no session', async () => {
    const { engine } = build();
    await engine.sessionDead({ sessionId: 'sess-1' });

    const live = await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', sessionId: 'sess-2' }));
    const plain = await engine.submit(MARKET, order({ id: KEEP, account: 'mm', side: 'sell', qty: '1', price: '101' }));

    expect(live.accepted).toBe(true);
    expect(plain.accepted).toBe(true);
  });

  it('refuses session-dead without a session — does not invent one', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: KEEP, side: 'sell', qty: '1', price: '100' }));

    const missing = await engine.sessionDead({});
    expect(missing.accepted).toBe(false);
    expect(missing.rejected?.code).toBe(MISSING_SESSION);
    expect(engine.isSessionDead('sess-1')).toBe(false);
    expect(journal.length).toBe(1);

    const blank = await engine.sessionDead({ sessionId: '   ' });
    expect(blank.accepted).toBe(false);
    expect(blank.rejected?.code).toBe(MISSING_SESSION);
    expect(liveIds(engine, MARKET)).toEqual([KEEP]);
  });

  it('mass-cancel with a session id still refuses — session-dead is the door', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', sessionId: 'sess-1' }));

    const result = await engine.massCancel(MARKET, { accountId: 'desk', sessionId: 'sess-1' });

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(SESSION_UNSUPPORTED);
    expect(liveIds(engine, MARKET)).toEqual([REST]);
  });

  it('replays session-dead so a recovered engine still has no tagged rest and still refuses', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', sessionId: 'sess-1' }));
    await engine.sessionDead({ sessionId: 'sess-1' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    recovered.recover();

    expect(recovered.isSessionDead('sess-1')).toBe(true);
    expect(replayDeadSessions(journal.read()).has('sess-1')).toBe(true);
    expect(liveIds(recovered, MARKET)).toEqual([]);

    const restored = replay(journal.read()).get(MARKET);
    expect(restored).toBeUndefined();

    const blocked = await recovered.submit(MARKET, order({ id: AFTER, side: 'buy', qty: '1', price: '99', sessionId: 'sess-1' }));
    expect(blocked.accepted).toBe(false);
    expect(blocked.rejected?.code).toBe(SESSION_GONE);
  });

  it('a snapshot taken after session_dead does not rest a later submit for that session', async () => {
    const { journal, engine } = build();
    await engine.sessionDead({ sessionId: 'sess-1' });
    const snapshot = engine.snapshot();
    expect(snapshot.deadSessions).toEqual(['sess-1']);
    expect(snapshot.journalSeq).toBe(journal.length);

    journal.append({
      kind: 'submit',
      marketId: MARKET,
      at: '2026-10-08T00:00:00.000Z',
      order: toWire(order({ id: AFTER, side: 'buy', qty: '1', price: '99', sessionId: 'sess-1' })),
    });
    journal.append({ kind: 'session_dead', at: '2026-10-08T00:00:01.000Z', sessionId: 'sess-3' });
    journal.append({
      kind: 'submit',
      marketId: MARKET,
      at: '2026-10-08T00:00:02.000Z',
      order: toWire(order({ id: TAKER, account: 'mm', side: 'buy', qty: '1', price: '98', sessionId: 'sess-3' })),
    });
    journal.append({
      kind: 'submit',
      marketId: MARKET,
      at: '2026-10-08T00:00:03.000Z',
      order: toWire(order({ id: KEEP, account: 'mm', side: 'sell', qty: '1', price: '101', sessionId: 'sess-2' })),
    });

    const records = journal.read();
    expect(records.filter((row) => row.seq > snapshot.journalSeq).map((row) => row.kind)).toEqual([
      'submit',
      'session_dead',
      'submit',
      'submit',
    ]);

    const full = replay(records);
    const fromSnapshot = replayFrom(snapshot, records);
    expect(serializeBooks(fromSnapshot)).toBe(serializeBooks(full));
    expect(restingIds(fromSnapshot, MARKET)).toEqual([KEEP]);
    expect(restingIds(full, MARKET)).toEqual([KEEP]);
  });

  it('snapshot restore keeps the session tag so a later session-dead still pulls it', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', sessionId: 'sess-1' }));
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.sessionId).toBe('sess-1');

    const dead = await engine.sessionDead({ sessionId: 'sess-1' });
    expect(dead.cancellations).toHaveLength(1);
  });

  it('sessionOrderIds is oldest sequence first; missing session matches nothing', () => {
    expect(
      sessionOrderIds('sess-1', [
        { orderId: 'b', sessionId: 'sess-1', sequence: 2 },
        { orderId: 'a', sessionId: 'sess-1', sequence: 1 },
        { orderId: 'c', sessionId: 'sess-2', sequence: 3 },
        { orderId: 'd', sessionId: null, sequence: 0 },
      ]),
    ).toEqual(['a', 'b']);
    expect(sessionOrderIds('', [{ orderId: 'a', sessionId: 'sess-1', sequence: 1 }])).toEqual([]);
  });

  it('does not invent a fill qty as a JS number', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1.5', price: '100', sessionId: 'sess-1' }));
    const dead = await engine.sessionDead({ sessionId: 'sess-1' });
    expect(formatAmount(dead.cancellations[0]!.remainingQty)).toBe('1.5');
  });
});

it('still records the session dead if a book.cancel throws — other ids continue', async () => {
  const { journal, engine } = build();
  await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100', sessionId: 'sess-1' }));
  await engine.submit(OTHER, order({ id: OTHER_REST, side: 'sell', qty: '2', price: '200', sessionId: 'sess-1' }));
  await engine.submit(MARKET, order({ id: KEEP, account: 'mm', side: 'sell', qty: '3', price: '101', sessionId: 'sess-2' }));

  const book = engine.book(MARKET);
  const orig = book.cancel.bind(book);
  book.cancel = ((orderId: string, reason?: Parameters<typeof orig>[1]) => {
    if (orderId === REST) throw new Error('book failed');
    return orig(orderId, reason);
  }) as typeof book.cancel;

  const dead = await engine.sessionDead({ sessionId: 'sess-1' });
  expect(dead.accepted).toBe(true);
  expect(engine.isSessionDead('sess-1')).toBe(true);
  expect(dead.failed).toEqual([{ orderId: REST, reason: 'book failed' }]);
  expect(dead.cancellations.map((c) => c.orderId)).toEqual([OTHER_REST]);
  expect(liveIds(engine, MARKET).sort()).toEqual([KEEP, REST].sort());
  expect(liveIds(engine, OTHER)).toEqual([]);
  expect(journal.read().some((r) => r.kind === 'session_dead')).toBe(true);

  const blocked = await engine.submit(MARKET, order({ id: AFTER, side: 'buy', qty: '1', price: '99', sessionId: 'sess-1' }));
  expect(blocked.accepted).toBe(false);
  expect(blocked.rejected?.code).toBe(SESSION_GONE);
});

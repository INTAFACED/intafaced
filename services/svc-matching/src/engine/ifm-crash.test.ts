import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { FileJournal, replay } from './journal.js';
import type { EngineOrder, OrderSide } from './types.js';
import { IN_FLIGHT_UNKNOWN, persistInFlight } from './ifm.js';
import { installIfmCrash } from './ifm-crash.js';

installIfmCrash();

/**
 * CARD B3 hitch. Crash after in_flight journal, before apply → in_flight_unknown.
 * No second rest. No duplicate fill. Replay must not invent a cancel.
 * FileJournal encode includes inFlight: true.
 */

const MARKET = 'BTC/USDT';
const REST = '11111111-1111-4111-8111-111111111111';

const A = parseAmount;

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price: string }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: A(spec.qty),
    price: A(spec.price),
    stopPrice: null,
    tif: 'GTC',
  };
}

function liveIds(engine: MatchingEngine, marketId: string): string[] {
  return engine
    .restingOrders(marketId)
    .map((row) => row.orderId)
    .sort();
}

function tmpJournal(): string {
  return join(mkdtempSync(join(tmpdir(), 'matching-ifm-crash-')), 'engine.ndjson');
}

describe('IFM crash window — in_flight_unknown, no invented cancel', () => {
  it('FileJournal encode of in_flight includes inFlight true and decimal qty', () => {
    const path = tmpJournal();
    const qty = formatAmount(A('1.5'));
    const journal = new FileJournal(path);
    journal.append({
      kind: 'in_flight',
      marketId: MARKET,
      at: '2026-09-03T00:00:00.000Z',
      orderId: REST,
      mutation: 'cancel',
      inFlight: true,
      qty,
    });
    journal.close();

    const onDisk = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; inFlight?: boolean; qty?: string | null });
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.kind).toBe('in_flight');
    expect(onDisk[0]!.inFlight).toBe(true);
    expect(onDisk[0]!.qty).toBe('1.5');
    expect(persistInFlight(onDisk[0]!)).toBe(true);
  });

  it('crash window recover leaves rest live, no invented cancel, mutations in_flight_unknown', async () => {
    const path = tmpJournal();
    const j1 = new FileJournal(path);
    const live = new MatchingEngine({ journal: j1, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    await live.submit(MARKET, order({ id: REST, side: 'sell', qty: '2', price: '100' }));
    j1.append({
      kind: 'in_flight',
      marketId: MARKET,
      at: '2026-09-03T00:00:01.000Z',
      orderId: REST,
      mutation: 'cancel',
      inFlight: true,
      qty: formatAmount(A('2')),
    });
    expect(j1.read().some((record) => record.kind === 'cancel')).toBe(false);
    j1.close();

    const j2 = new FileJournal(path);
    const recovered = new MatchingEngine({ journal: j2, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    const lengthBefore = j2.length;
    recovered.recover();
    expect(j2.length).toBe(lengthBefore);
    expect(j2.read().some((record) => record.kind === 'cancel')).toBe(false);
    expect(liveIds(recovered, MARKET)).toEqual([REST]);
    expect(recovered.restingOrders(MARKET)).toHaveLength(1);

    const cancel = await recovered.cancel(MARKET, REST);
    expect(cancel.cancelled).toBe(false);
    expect(cancel.rejected?.code).toBe(IN_FLIGHT_UNKNOWN);
    expect(cancel.cancellation).toBeNull();

    const amend = await recovered.amend(MARKET, { orderId: REST, expectedVersion: 1, qty: A('1') });
    expect(amend.accepted).toBe(false);
    expect(amend.rejected?.code).toBe(IN_FLIGHT_UNKNOWN);
    expect(amend.fills).toEqual([]);

    const second = await recovered.submit(MARKET, order({ id: REST, account: 'other', side: 'sell', qty: '9', price: '50' }));
    expect(second.accepted).toBe(false);
    expect(second.rejected?.code).toBe(IN_FLIGHT_UNKNOWN);
    expect(second.fills).toEqual([]);
    expect(second.resting).toBeNull();
    expect(liveIds(recovered, MARKET)).toEqual([REST]);
    expect(recovered.restingOrders(MARKET)).toHaveLength(1);
    expect(j2.read().some((record) => record.kind === 'cancel')).toBe(false);

    const books = replay(j2.read());
    expect(
      books
        .get(MARKET)
        ?.toState()
        .asks[0]!.orders.map((o) => o.orderId),
    ).toEqual([REST]);
    expect(books.get(MARKET)?.toState().asks[0]!.orders).toHaveLength(1);
    j2.close();
  });

  it('replay of crash-window journal does not drop the rest and does not emit a cancel', async () => {
    const path = tmpJournal();
    const j1 = new FileJournal(path);
    const live = new MatchingEngine({ journal: j1, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    await live.submit(MARKET, order({ id: REST, side: 'buy', qty: '1', price: '100' }));
    j1.append({
      kind: 'in_flight',
      marketId: MARKET,
      at: '2026-09-03T00:00:01.000Z',
      orderId: REST,
      mutation: 'amend',
      inFlight: true,
      qty: formatAmount(A('1')),
    });
    j1.close();

    const j2 = new FileJournal(path);
    const records = j2.read();
    expect(records.some((record) => record.kind === 'cancel')).toBe(false);
    const books = replay(records);
    expect(
      books
        .get(MARKET)
        ?.toState()
        .bids[0]!.orders.map((o) => o.orderId),
    ).toEqual([REST]);
    expect(books.get(MARKET)?.toState().bids[0]!.orders).toHaveLength(1);
    j2.close();
  });

  it('confirmed cancel after a clean path still clears so a later submit of that id can rest once', async () => {
    const path = tmpJournal();
    const journal = new FileJournal(path);
    const engine = new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100' }));
    const cancelled = await engine.cancel(MARKET, REST);
    expect(cancelled.cancelled).toBe(true);
    expect(liveIds(engine, MARKET)).toEqual([]);

    const again = await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '101' }));
    expect(again.accepted).toBe(true);
    expect(again.rejected).toBeUndefined();
    expect(again.fills).toEqual([]);
    expect(liveIds(engine, MARKET)).toEqual([REST]);
    expect(engine.restingOrders(MARKET)).toHaveLength(1);
    journal.close();
  });
});

import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal } from './journal.js';
import type { EngineOrder, OrderSide, TimeInForce } from './types.js';

/**
 * A GTD/GTT with no injected clock is refused before the journal.
 * When a clock is injected, the journalled instant is the expiry instant:
 * recover must not rest or take an order the live submit refused.
 */

const MARKET = 'BTC/USDT';
const GTC = '11111111-1111-4111-8111-111111111111';
const GTD = '44444444-4444-4444-8444-444444444444';
const GTT = '55555555-5555-4555-8555-555555555555';
const ASK = '66666666-6666-4666-8666-666666666666';

/** Caller expireAt, after any wall-clock journal `at`, so a replayed row can still rest or take. */
const OPEN_EXPIRE = '2099-01-01T00:00:00.000Z';
const EXPIRE = '2026-08-25T12:00:00.000Z';
const BEFORE = new Date('2026-08-25T11:00:00.000Z');
const AFTER = new Date('2026-08-25T12:00:00.000Z');

function order(spec: {
  id: string;
  account: string;
  side: OrderSide;
  qty: string;
  price: string;
  tif: TimeInForce;
  expireAt?: string;
}): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account,
    type: 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: parseAmount(spec.price),
    stopPrice: null,
    tif: spec.tif,
    ...(spec.expireAt ? { expireAt: spec.expireAt } : {}),
  };
}

function engine(journal: MemoryJournal, clock?: () => Date) {
  const bus = new MemoryEventBus('svc-matching');
  return {
    bus,
    engine: new MatchingEngine({ journal, bus, snapshotEvery: 0, ...(clock ? { clock } : {}) }),
  };
}

function restingIds(book: MatchingEngine): string[] {
  return book
    .restingOrders(MARKET)
    .map((row) => row.orderId)
    .sort();
}

describe('GTD/GTT journal clock', () => {
  it('refuses a clockless GTD/GTT before the journal, and recover does not match a second clock read', async () => {
    const journal = new MemoryJournal();
    const live = engine(journal);
    const ask = await live.engine.submit(MARKET, order({ id: GTC, account: 'mm', side: 'sell', qty: '1', price: '100', tif: 'GTC' }));
    const gtd = await live.engine.submit(
      MARKET,
      order({ id: GTD, account: 'desk', side: 'buy', qty: '1', price: '100', tif: 'GTD', expireAt: OPEN_EXPIRE }),
    );
    const gtt = await live.engine.submit(
      MARKET,
      order({ id: GTT, account: 'gtt', side: 'buy', qty: '1', price: '99', tif: 'GTT', expireAt: OPEN_EXPIRE }),
    );

    expect(ask.accepted).toBe(true);
    expect(gtd.accepted).toBe(false);
    expect(gtd.rejected?.code).toBe('engine_clock_missing');
    expect(gtd.fills).toHaveLength(0);
    expect(gtd.resting).toBeNull();
    expect(gtt.accepted).toBe(false);
    expect(gtt.rejected?.code).toBe('engine_clock_missing');
    expect(journal.read().flatMap((row) => (row.kind === 'submit' ? [row.order.orderId] : []))).toEqual([GTC]);
    expect(restingIds(live.engine)).toEqual([GTC]);

    const recovered = engine(journal);
    await recovered.engine.recover();
    expect(restingIds(recovered.engine)).toEqual([GTC]);
    expect(recovered.bus.emitted('orderFilled')).toHaveLength(0);

    const reads = [BEFORE, BEFORE, BEFORE, AFTER];
    let step = 0;
    const clock = (): Date => reads[step++] ?? AFTER;
    const stepped = new MemoryJournal();
    const crossed = engine(stepped, clock);
    await crossed.engine.submit(MARKET, order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100', tif: 'GTC' }));
    const taking = await crossed.engine.submit(
      MARKET,
      order({ id: GTT, account: 'desk', side: 'buy', qty: '1', price: '100', tif: 'GTT', expireAt: EXPIRE }),
    );
    const replay = engine(stepped);
    await replay.engine.recover();

    expect(replay.engine.serialize()).toBe(crossed.engine.serialize());
    expect(replay.bus.emitted('orderFilled').map((row) => row.payload.takerOrderId)).toEqual(taking.fills.map((fill) => fill.takerOrderId));
  });
});

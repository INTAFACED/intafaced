import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal } from './journal.js';
import type { EngineOrder, OrderSide, TimeInForce } from './types.js';

/**
 * An amend carries the same expiry clock as submit. A resting GTD or GTT
 * already past expireAt must not print against that amend, and must not stay.
 */

const MARKET = 'BTC/USDT';
const MAKER = '44444444-4444-4444-8444-444444444444';
const BID = '66666666-6666-4666-8666-666666666666';

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

function engine(journal: MemoryJournal, clock: () => Date) {
  const bus = new MemoryEventBus('svc-matching');
  return {
    bus,
    engine: new MatchingEngine({ journal, bus, snapshotEvery: 0, clock }),
  };
}

describe('amend applies the expiry clock', () => {
  it.each(['GTD', 'GTT'] as const)('an amend after expireAt does not print the expired %s and does not leave it resting', async (tif) => {
    let now = BEFORE;
    const journal = new MemoryJournal();
    const live = engine(journal, () => now);
    const rested = await live.engine.submit(
      MARKET,
      order({ id: MAKER, account: 'desk', side: 'sell', qty: '2', price: '100', tif, expireAt: EXPIRE }),
    );
    const bid = await live.engine.submit(MARKET, order({ id: BID, account: 'mm', side: 'buy', qty: '1', price: '99', tif: 'GTC' }));
    expect(rested.accepted).toBe(true);
    expect(bid.accepted).toBe(true);

    now = AFTER;
    const amended = await live.engine.amend(MARKET, { orderId: BID, expectedVersion: 1, price: parseAmount('100') });

    expect(amended.accepted).toBe(true);
    expect(amended.fills).toEqual([]);
    expect(amended.cancellations.map((row) => [row.orderId, row.reason])).toEqual([[MAKER, 'expired']]);
    expect(live.engine.restingOrders(MARKET).map((row) => row.orderId)).toEqual([BID]);
    expect(live.bus.emitted('orderFilled')).toEqual([]);
    // The event says why, so svc-trade ends the order expired whichever of the event and the inline outcome comes first.
    expect(live.bus.emitted('orderCancelled').map((row) => [row.payload.orderId, row.payload.reason])).toEqual([[MAKER, 'expired']]);

    const recovered = engine(journal, () => AFTER);
    await recovered.engine.recover();
    expect(recovered.engine.serialize()).toBe(live.engine.serialize());
    expect(recovered.bus.emitted('orderFilled')).toEqual([]);
  });

  it.each(['GTD', 'GTT'] as const)('a %s that is not yet expired still rests and trades on amend', async (tif) => {
    const journal = new MemoryJournal();
    const live = engine(journal, () => BEFORE);
    await live.engine.submit(MARKET, order({ id: MAKER, account: 'desk', side: 'sell', qty: '2', price: '100', tif, expireAt: EXPIRE }));
    await live.engine.submit(MARKET, order({ id: BID, account: 'mm', side: 'buy', qty: '1', price: '99', tif: 'GTC' }));

    const amended = await live.engine.amend(MARKET, { orderId: BID, expectedVersion: 1, price: parseAmount('100') });

    expect(amended.accepted).toBe(true);
    expect(amended.fills.map((fill) => fill.makerOrderId)).toEqual([MAKER]);
    expect(amended.cancellations).toEqual([]);
    expect(live.engine.restingOrders(MARKET)).toEqual([expect.objectContaining({ orderId: MAKER, remaining: '1' })]);

    const recovered = engine(journal, () => BEFORE);
    await recovered.engine.recover();
    expect(recovered.engine.serialize()).toBe(live.engine.serialize());
    expect(recovered.bus.emitted('orderFilled').map((row) => row.payload.makerOrderId)).toEqual([MAKER]);
  });
});

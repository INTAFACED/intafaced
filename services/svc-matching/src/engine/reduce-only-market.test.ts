import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal, replay } from './journal.js';
import { MARKET_HALTED, MISSING_OPERATOR } from './halt.js';
import { MARKET_REDUCE_ONLY, replayReduceOnlyMarkets } from './reduce-only-market.js';
import type { EngineOrder, OrderSide } from './types.js';

/**
 * Operator reduce-only of one market. Opens and increases refuse. Other markets stay.
 * Reduce-only, close, cancel stay. Resume is explicit. No duration. Not halt.
 * Missing/same confirm refuses. Missing operator refuses.
 */

const MARKET = 'BTC/USDT';
const OTHER = 'ETH/USDT';
const LIQ = '11111111-1111-4111-8111-111111111111';
const OPEN = '22222222-2222-4222-8222-222222222222';
const TAKER = '33333333-3333-4333-8333-333333333333';
const RO = '44444444-4444-4444-8444-444444444444';
const REST = '55555555-5555-4555-8555-555555555555';
const AFTER = '66666666-6666-4666-8666-666666666666';
const CLOSE = '77777777-7777-4777-8777-777777777777';
const OTHER_REST = '88888888-8888-4888-8888-888888888888';
const AMEND = '99999999-9999-4999-8999-999999999999';
const EXIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BID_HIGH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BID_LOW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FLAT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REDUCE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price?: string; reduceOnly?: boolean }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: spec.price === undefined ? 'market' : 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: spec.price === undefined ? null : parseAmount(spec.price),
    stopPrice: null,
    tif: spec.price === undefined ? 'IOC' : 'GTC',
    ...(spec.reduceOnly ? { reduceOnly: true } : {}),
  };
}

function build() {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 });
  return { journal, bus, engine };
}

async function openLong(engine: MatchingEngine): Promise<void> {
  await engine.submit(MARKET, order({ id: LIQ, account: 'mm', side: 'sell', qty: '2', price: '100' }));
  const fill = await engine.submit(MARKET, order({ id: OPEN, side: 'buy', qty: '2', price: '100' }));
  expect(fill.accepted).toBe(true);
}

describe('operator reduce-only of one market', () => {
  it('refuses a submit that would open or increase and journals nothing for that submit', async () => {
    const { journal, engine } = build();
    await openLong(engine);
    const mode = await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    expect(mode.accepted).toBe(true);
    expect(mode.reduceOnly).toBe(true);
    expect(mode.operatorId).toBe('ops-1');
    expect(engine.isReduceOnly(MARKET)).toBe(true);
    expect(engine.isHalted(MARKET)).toBe(false);

    const before = journal.length;
    const result = await engine.submit(MARKET, order({ id: TAKER, side: 'buy', qty: '1', price: '100' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(MARKET_REDUCE_ONLY);
    expect(result.sequence).toBeNull();
    expect(result.fills).toEqual([]);
    expect(journal.length).toBe(before);
  });

  it('still rests a reduce-only that shrinks the position', async () => {
    const { engine } = build();
    await openLong(engine);
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const result = await engine.submit(MARKET, order({ id: RO, side: 'sell', qty: '1', price: '101', reduceOnly: true }));

    expect(result.accepted).toBe(true);
    expect(result.resting?.kind).toBe('book');
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.orderId).toBe(RO);
  });

  it('still flattens close-position while reduce-only', async () => {
    const { engine } = build();
    await openLong(engine);
    await engine.submit(MARKET, order({ id: EXIT, account: 'liq', side: 'buy', qty: '2', price: '100' }));
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const closed = await engine.closePosition(MARKET, { orderId: CLOSE, accountId: 'desk' });

    expect(closed.accepted).toBe(true);
    expect(closed.rejected).toBeUndefined();
    expect(closed.fills.length).toBeGreaterThan(0);
  });

  it('leaves another market open for new submits', async () => {
    const { engine } = build();
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const result = await engine.submit(OTHER, order({ id: OTHER_REST, side: 'sell', qty: '1', price: '200' }));

    expect(result.accepted).toBe(true);
    expect(engine.isReduceOnly(OTHER)).toBe(false);
    expect(engine.isReduceOnly(MARKET)).toBe(true);
  });

  it('still cancels while reduce-only', async () => {
    const { engine } = build();
    await openLong(engine);
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '101', reduceOnly: true }));

    const cancelled = await engine.cancel(MARKET, REST);

    expect(cancelled.cancelled).toBe(true);
    expect(engine.book(MARKET).toState().asks).toEqual([]);
  });

  it('is not halt — halt still blocks a reducing submit', async () => {
    const { engine } = build();
    await openLong(engine);
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const reducing = await engine.submit(MARKET, order({ id: RO, side: 'sell', qty: '1', price: '101', reduceOnly: true }));
    expect(reducing.accepted).toBe(true);

    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const blocked = await engine.submit(MARKET, order({ id: TAKER, side: 'sell', qty: '1', price: '101', reduceOnly: true }));
    expect(blocked.accepted).toBe(false);
    expect(blocked.rejected?.code).toBe(MARKET_HALTED);
  });

  it('resumes only after an explicit resume — reduce-only never expires', async () => {
    const { engine } = build();
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const blocked = await engine.submit(MARKET, order({ id: TAKER, side: 'buy', qty: '1', price: '100' }));
    expect(blocked.accepted).toBe(false);

    const resume = await engine.resumeReduceOnly(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-3' });
    expect(resume.accepted).toBe(true);
    expect(resume.reduceOnly).toBe(false);
    expect(engine.isReduceOnly(MARKET)).toBe(false);

    const result = await engine.submit(MARKET, order({ id: AFTER, side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });

  it('refuses reduce-only and resume without an operator — does not invent a caller', async () => {
    const { journal, engine } = build();
    const mode = await engine.reduceOnly(MARKET, {});
    expect(mode.accepted).toBe(false);
    expect(mode.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isReduceOnly(MARKET)).toBe(false);
    expect(journal.length).toBe(0);

    const blank = await engine.reduceOnly(MARKET, { operatorId: '   ' });
    expect(blank.accepted).toBe(false);
    expect(blank.rejected?.code).toBe(MISSING_OPERATOR);

    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const resume = await engine.resumeReduceOnly(MARKET, { operatorId: null });
    expect(resume.accepted).toBe(false);
    expect(resume.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isReduceOnly(MARKET)).toBe(true);
  });

  it('does not disable the engine — the process kill-switch is a different door', async () => {
    const { engine } = build();
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    expect(engine.isEnabled).toBe(true);
    expect(engine.isReduceOnly(OTHER)).toBe(false);
    expect(engine.isHalted(MARKET)).toBe(false);
  });

  it('replays reduce-only so a recovered engine still refuses opens', async () => {
    const { journal, engine } = build();
    await openLong(engine);
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    recovered.recover();

    expect(recovered.isReduceOnly(MARKET)).toBe(true);
    expect(replayReduceOnlyMarkets(journal.read()).has(MARKET)).toBe(true);
    expect(replay(journal.read()).has(MARKET)).toBe(true);

    const result = await recovered.submit(MARKET, order({ id: TAKER, side: 'buy', qty: '1', price: '100' }));
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(MARKET_REDUCE_ONLY);
  });

  it('refuses an amend that would increase without journaling', async () => {
    const { journal, engine } = build();
    await openLong(engine);
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const rest = await engine.submit(MARKET, order({ id: AMEND, side: 'sell', qty: '1', price: '101', reduceOnly: true }));
    expect(rest.accepted).toBe(true);
    const before = journal.length;

    const amended = await engine.amend(MARKET, { orderId: AMEND, expectedVersion: 1, qty: parseAmount('3') });

    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(MARKET_REDUCE_ONLY);
    expect(journal.length).toBe(before);
  });

  it('a price amend that omits qty does not grow a position on a reduce-only market', async () => {
    const { journal, engine } = build();
    await openLong(engine);
    await engine.submit(MARKET, order({ id: BID_LOW, account: 'mm', side: 'buy', qty: '2', price: '80' }));
    await engine.submit(MARKET, order({ id: BID_HIGH, account: 'mm', side: 'buy', qty: '2', price: '100' }));
    const rest = await engine.submit(MARKET, order({ id: AMEND, side: 'sell', qty: '2', price: '110' }));
    expect(rest.accepted).toBe(true);
    const reducing = await engine.submit(MARKET, order({ id: REDUCE, side: 'sell', qty: '1', price: '120' }));
    expect(reducing.accepted).toBe(true);
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const shrunk = await engine.amend(MARKET, { orderId: REDUCE, expectedVersion: 1, qty: parseAmount('1'), price: parseAmount('119') });
    expect(shrunk.accepted).toBe(true);
    expect(shrunk.fills).toEqual([]);
    expect(
      engine
        .book(MARKET)
        .toState()
        .positions?.find((row) => row.accountId === 'desk')?.qty,
    ).toBe('2');

    const flat = await engine.submit(MARKET, order({ id: FLAT, side: 'sell', qty: '2', price: '100' }));
    expect(flat.accepted).toBe(true);
    expect(flat.fills).toHaveLength(1);
    expect(engine.book(MARKET).toState().positions).toBeUndefined();

    const before = journal.length;
    const amended = await engine.amend(MARKET, { orderId: AMEND, expectedVersion: 1, price: parseAmount('80') });

    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(MARKET_REDUCE_ONLY);
    expect(amended.fills).toEqual([]);
    expect(journal.length).toBe(before);
    expect(engine.book(MARKET).toState().positions).toBeUndefined();
    expect(engine.book(MARKET).toState().lastTradePrice).toBe('100');
    expect(
      engine
        .book(MARKET)
        .toState()
        .asks.find((level) => level.price === '110')?.orders[0],
    ).toMatchObject({
      orderId: AMEND,
      remaining: '2',
    });
    expect(engine.book(MARKET).toState().bids[0]).toMatchObject({ price: '80' });
    expect(engine.book(MARKET).toState().bids[0]!.orders[0]!.remaining).toBe('2');
  });

  it('replay of reduce-only then resume leaves the market open', async () => {
    const { journal, engine } = build();
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    await engine.resumeReduceOnly(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-3' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    recovered.recover();
    expect(recovered.isReduceOnly(MARKET)).toBe(false);

    const result = await recovered.submit(MARKET, order({ id: AFTER, side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });
});

describe('reduce-only dual-control', () => {
  it('refuses reduce-only when confirmOperatorId is missing — no journal', async () => {
    const { journal, engine } = build();
    const mode = await engine.reduceOnly(MARKET, { operatorId: 'ops-1' });
    expect(mode.accepted).toBe(false);
    expect(mode.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isReduceOnly(MARKET)).toBe(false);
    expect(journal.length).toBe(0);
  });

  it('refuses reduce-only when confirmOperatorId is the same caller — no journal', async () => {
    const { journal, engine } = build();
    const mode = await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(mode.accepted).toBe(false);
    expect(mode.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isReduceOnly(MARKET)).toBe(false);
    expect(journal.length).toBe(0);
  });

  it('refuses resume when confirm is missing or the same — leaves reduce-only', async () => {
    const { journal, engine } = build();
    await engine.reduceOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const before = journal.length;

    const missing = await engine.resumeReduceOnly(MARKET, { operatorId: 'ops-2' });
    expect(missing.accepted).toBe(false);
    expect(missing.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isReduceOnly(MARKET)).toBe(true);

    const same = await engine.resumeReduceOnly(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-2' });
    expect(same.accepted).toBe(false);
    expect(engine.isReduceOnly(MARKET)).toBe(true);
    expect(journal.length).toBe(before);
  });
});

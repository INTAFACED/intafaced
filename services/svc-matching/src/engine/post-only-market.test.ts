import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal, replay } from './journal.js';
import { MARKET_HALTED, MISSING_OPERATOR } from './halt.js';
import { MARKET_POST_ONLY, replayPostOnlyMarkets } from './post-only-market.js';
import type { EngineOrder, OrderSide, TimeInForce } from './types.js';

/**
 * Operator post-only of one market. Non-post-only submits refuse. Other markets stay.
 * Post-only that would take still refuses. An amend that is not post-only, or a
 * price that would cross, does not take. A post-only amend that would not cross may rest.
 * Cancel stays. Resume is explicit. No duration.
 * Not halt. Missing/same confirm refuses. Missing operator refuses.
 */

const MARKET = 'BTC/USDT';
const OTHER = 'ETH/USDT';
const ASK = '11111111-1111-4111-8111-111111111111';
const GTC = '22222222-2222-4222-8222-222222222222';
const PO = '33333333-3333-4333-8333-333333333333';
const CROSS = '44444444-4444-4444-8444-444444444444';
const REST = '55555555-5555-4555-8555-555555555555';
const AFTER = '66666666-6666-4666-8666-666666666666';
const OTHER_REST = '88888888-8888-4888-8888-888888888888';

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price: string; tif?: TimeInForce }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: parseAmount(spec.price),
    stopPrice: null,
    tif: spec.tif ?? 'GTC',
  };
}

function build() {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 });
  return { journal, bus, engine };
}

describe('operator post-only of one market', () => {
  it('refuses a non-post-only submit and journals nothing for that submit', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const mode = await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    expect(mode.accepted).toBe(true);
    expect(mode.postOnly).toBe(true);
    expect(mode.operatorId).toBe('ops-1');
    expect(engine.isPostOnly(MARKET)).toBe(true);
    expect(engine.isHalted(MARKET)).toBe(false);

    const before = journal.length;
    const result = await engine.submit(MARKET, order({ id: GTC, side: 'buy', qty: '1', price: '99' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(MARKET_POST_ONLY);
    expect(result.sequence).toBeNull();
    expect(result.fills).toEqual([]);
    expect(journal.length).toBe(before);
  });

  it('still rests a post-only that would not take', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const result = await engine.submit(MARKET, order({ id: PO, side: 'buy', qty: '1', price: '99', tif: 'PO' }));

    expect(result.accepted).toBe(true);
    expect(result.resting?.kind).toBe('book');
    expect(engine.book(MARKET).toState().bids[0]!.orders[0]!.orderId).toBe(PO);
  });

  it('still refuses a post-only that would take — existing PO law', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const before = journal.length;

    const result = await engine.submit(MARKET, order({ id: CROSS, side: 'buy', qty: '1', price: '100', tif: 'PO' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('post_only_would_cross');
    expect(result.fills).toEqual([]);
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.orderId).toBe(ASK);
    expect(journal.length).toBe(before + 1);
  });

  it('does not take through amend while the market is post-only', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    const rested = await engine.submit(MARKET, order({ id: REST, account: 'taker', side: 'buy', qty: '1', price: '99' }));
    expect(rested.accepted).toBe(true);
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const before = journal.length;

    const crossed = await engine.amend(MARKET, {
      orderId: REST,
      expectedVersion: 1,
      price: parseAmount('100'),
    });

    expect(crossed.accepted).toBe(false);
    expect(crossed.rejected?.code).toBe(MARKET_POST_ONLY);
    expect(crossed.fills).toEqual([]);
    expect(engine.book(MARKET).toState().lastTradePrice).toBeNull();
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.remaining).toBe('1');
    expect(engine.book(MARKET).toState().bids[0]!.orders[0]!.orderId).toBe(REST);
    expect(journal.length).toBe(before);

    const notPostOnly = await engine.amend(MARKET, {
      orderId: REST,
      expectedVersion: 1,
      tif: 'GTC',
      price: parseAmount('98'),
    });
    expect(notPostOnly.accepted).toBe(false);
    expect(notPostOnly.rejected?.code).toBe(MARKET_POST_ONLY);
    expect(notPostOnly.fills).toEqual([]);
    expect(engine.book(MARKET).toState().bids[0]!.price).toBe('99');

    const resting = await engine.amend(MARKET, {
      orderId: REST,
      expectedVersion: 1,
      tif: 'PO',
      price: parseAmount('98'),
    });
    expect(resting.accepted).toBe(true);
    expect(resting.fills).toEqual([]);
    expect(engine.book(MARKET).toState().bids[0]!.price).toBe('98');
    expect(engine.book(MARKET).toState().bids[0]!.orders[0]!.postOnly).toBe(true);
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.remaining).toBe('1');
    expect(engine.book(MARKET).toState().lastTradePrice).toBeNull();

    const poCross = await engine.amend(MARKET, {
      orderId: REST,
      expectedVersion: resting.version ?? 0,
      tif: 'PO',
      price: parseAmount('100'),
    });
    expect(poCross.accepted).toBe(false);
    expect(poCross.rejected?.code).toBe(MARKET_POST_ONLY);
    expect(poCross.fills).toEqual([]);
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.remaining).toBe('1');
    expect(engine.book(MARKET).toState().bids[0]!.price).toBe('98');
    expect(engine.book(MARKET).toState().lastTradePrice).toBeNull();

    const submit = await engine.submit(MARKET, order({ id: GTC, side: 'buy', qty: '1', price: '97' }));
    expect(submit.accepted).toBe(false);
    expect(submit.rejected?.code).toBe(MARKET_POST_ONLY);
  });

  it('leaves another market open for new submits', async () => {
    const { engine } = build();
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const result = await engine.submit(OTHER, order({ id: OTHER_REST, side: 'sell', qty: '1', price: '200' }));

    expect(result.accepted).toBe(true);
    expect(engine.isPostOnly(OTHER)).toBe(false);
    expect(engine.isPostOnly(MARKET)).toBe(true);
  });

  it('still cancels while post-only', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    await engine.submit(MARKET, order({ id: REST, side: 'buy', qty: '1', price: '99', tif: 'PO' }));

    const cancelled = await engine.cancel(MARKET, REST);

    expect(cancelled.cancelled).toBe(true);
    expect(engine.book(MARKET).toState().bids).toEqual([]);
  });

  it('is not halt — halt still blocks a resting post-only', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const resting = await engine.submit(MARKET, order({ id: PO, side: 'buy', qty: '1', price: '99', tif: 'PO' }));
    expect(resting.accepted).toBe(true);

    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const blocked = await engine.submit(MARKET, order({ id: CROSS, side: 'buy', qty: '1', price: '98', tif: 'PO' }));
    expect(blocked.accepted).toBe(false);
    expect(blocked.rejected?.code).toBe(MARKET_HALTED);
  });

  it('resumes only after an explicit resume — post-only never expires', async () => {
    const { engine } = build();
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const blocked = await engine.submit(MARKET, order({ id: GTC, side: 'buy', qty: '1', price: '100' }));
    expect(blocked.accepted).toBe(false);

    const resume = await engine.resumePostOnly(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-3' });
    expect(resume.accepted).toBe(true);
    expect(resume.postOnly).toBe(false);
    expect(engine.isPostOnly(MARKET)).toBe(false);

    const result = await engine.submit(MARKET, order({ id: AFTER, side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });

  it('refuses post-only and resume without an operator — does not invent a caller', async () => {
    const { journal, engine } = build();
    const mode = await engine.postOnly(MARKET, {});
    expect(mode.accepted).toBe(false);
    expect(mode.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isPostOnly(MARKET)).toBe(false);
    expect(journal.length).toBe(0);

    const blank = await engine.postOnly(MARKET, { operatorId: '   ' });
    expect(blank.accepted).toBe(false);
    expect(blank.rejected?.code).toBe(MISSING_OPERATOR);

    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const resume = await engine.resumePostOnly(MARKET, { operatorId: null });
    expect(resume.accepted).toBe(false);
    expect(resume.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isPostOnly(MARKET)).toBe(true);
  });

  it('does not disable the engine — the process kill-switch is a different door', async () => {
    const { engine } = build();
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    expect(engine.isEnabled).toBe(true);
    expect(engine.isPostOnly(OTHER)).toBe(false);
    expect(engine.isHalted(MARKET)).toBe(false);
  });

  it('replays post-only so a recovered engine still refuses non-post-only submits', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    recovered.recover();

    expect(recovered.isPostOnly(MARKET)).toBe(true);
    expect(replayPostOnlyMarkets(journal.read()).has(MARKET)).toBe(true);
    expect(replay(journal.read()).has(MARKET)).toBe(true);

    const result = await recovered.submit(MARKET, order({ id: GTC, side: 'buy', qty: '1', price: '99' }));
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(MARKET_POST_ONLY);
  });

  it('replay of post-only then resume leaves the market open', async () => {
    const { journal, engine } = build();
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    await engine.resumePostOnly(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-3' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    recovered.recover();
    expect(recovered.isPostOnly(MARKET)).toBe(false);

    const result = await recovered.submit(MARKET, order({ id: AFTER, side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });
});

describe('post-only dual-control', () => {
  it('refuses post-only when confirmOperatorId is missing — no journal', async () => {
    const { journal, engine } = build();
    const mode = await engine.postOnly(MARKET, { operatorId: 'ops-1' });
    expect(mode.accepted).toBe(false);
    expect(mode.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isPostOnly(MARKET)).toBe(false);
    expect(journal.length).toBe(0);
  });

  it('refuses post-only when confirmOperatorId is the same caller — no journal', async () => {
    const { journal, engine } = build();
    const mode = await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(mode.accepted).toBe(false);
    expect(mode.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isPostOnly(MARKET)).toBe(false);
    expect(journal.length).toBe(0);
  });

  it('refuses resume when confirm is missing or the same — leaves post-only', async () => {
    const { journal, engine } = build();
    await engine.postOnly(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const before = journal.length;

    const missing = await engine.resumePostOnly(MARKET, { operatorId: 'ops-2' });
    expect(missing.accepted).toBe(false);
    expect(missing.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isPostOnly(MARKET)).toBe(true);

    const same = await engine.resumePostOnly(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-2' });
    expect(same.accepted).toBe(false);
    expect(engine.isPostOnly(MARKET)).toBe(true);
    expect(journal.length).toBe(before);
  });
});

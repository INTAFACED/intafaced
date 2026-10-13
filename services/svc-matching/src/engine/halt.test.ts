import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal, replay } from './journal.js';
import { dualControlRefuse, MARKET_HALTED, MISSING_OPERATOR, readConfirmOperatorId, replayHaltedMarkets } from './halt.js';
import type { EngineOrder, OrderSide } from './types.js';

/**
 * Operator halt of one market. Dual-control. New submits refuse. Other markets stay.
 * Cancels stay. Resume is explicit. No duration. Missing/same confirm refuses.
 */

const MARKET = 'BTC/USDT';
const OTHER = 'ETH/USDT';
const REST = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const OTHER_REST = '33333333-3333-4333-8333-333333333333';
const AFTER = '44444444-4444-4444-8444-444444444444';

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price: string }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: parseAmount(spec.price),
    stopPrice: null,
    tif: 'GTC',
  };
}

function build() {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 });
  return { journal, bus, engine };
}

describe('operator halt of one market', () => {
  it('refuses a new submit on the halted market and journals nothing for that submit', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100' }));
    const halt = await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    expect(halt.accepted).toBe(true);
    expect(halt.halted).toBe(true);
    expect(halt.operatorId).toBe('ops-1');
    expect(halt.confirmOperatorId).toBe('ops-2');
    expect(engine.isHalted(MARKET)).toBe(true);

    const before = journal.length;
    const result = await engine.submit(MARKET, order({ id: TAKER, side: 'buy', qty: '1', price: '100' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(MARKET_HALTED);
    expect(result.sequence).toBeNull();
    expect(result.fills).toEqual([]);
    expect(journal.length).toBe(before);
    expect(engine.book(MARKET).toState().asks[0]!.orders[0]!.orderId).toBe(REST);
  });

  it('leaves another market open', async () => {
    const { engine } = build();
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const result = await engine.submit(OTHER, order({ id: OTHER_REST, side: 'sell', qty: '1', price: '200' }));

    expect(result.accepted).toBe(true);
    expect(engine.isHalted(OTHER)).toBe(false);
    expect(engine.isHalted(MARKET)).toBe(true);
  });

  it('still cancels while halted', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100' }));
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const cancelled = await engine.cancel(MARKET, REST);

    expect(cancelled.cancelled).toBe(true);
    expect(engine.book(MARKET).toState().asks).toEqual([]);
  });

  it('resumes only after an explicit resume — halt never expires', async () => {
    const { engine } = build();
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const blocked = await engine.submit(MARKET, order({ id: TAKER, side: 'buy', qty: '1', price: '100' }));
    expect(blocked.accepted).toBe(false);

    const resume = await engine.resume(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-3' });
    expect(resume.accepted).toBe(true);
    expect(resume.halted).toBe(false);
    expect(engine.isHalted(MARKET)).toBe(false);

    const result = await engine.submit(MARKET, order({ id: AFTER, side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });

  it('refuses halt and resume without an operator — does not invent a caller', async () => {
    const { journal, engine } = build();
    const halt = await engine.halt(MARKET, {});
    expect(halt.accepted).toBe(false);
    expect(halt.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isHalted(MARKET)).toBe(false);
    expect(journal.length).toBe(0);

    const blank = await engine.halt(MARKET, { operatorId: '   ' });
    expect(blank.accepted).toBe(false);
    expect(blank.rejected?.code).toBe(MISSING_OPERATOR);

    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const resume = await engine.resume(MARKET, { operatorId: null });
    expect(resume.accepted).toBe(false);
    expect(resume.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isHalted(MARKET)).toBe(true);
  });

  it('does not halt every market — the process kill-switch is a different door', async () => {
    const { engine } = build();
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    expect(engine.isEnabled).toBe(true);
    expect(engine.isHalted(OTHER)).toBe(false);
  });

  it('replays halt so a recovered engine still refuses submits', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100' }));
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    recovered.recover();

    expect(recovered.isHalted(MARKET)).toBe(true);
    expect(replayHaltedMarkets(journal.read()).has(MARKET)).toBe(true);
    expect(replay(journal.read()).has(MARKET)).toBe(true);

    const result = await recovered.submit(MARKET, order({ id: TAKER, side: 'buy', qty: '1', price: '100' }));
    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe(MARKET_HALTED);
  });

  it('refuses amend on a halted market without journaling', async () => {
    const { journal, engine } = build();
    const rest = await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100' }));
    expect(rest.accepted).toBe(true);
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const before = journal.length;

    const amended = await engine.amend(MARKET, { orderId: REST, expectedVersion: 1, qty: parseAmount('2') });

    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(MARKET_HALTED);
    expect(journal.length).toBe(before);
  });

  it('replay of halt then resume leaves the market open', async () => {
    const { journal, engine } = build();
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    await engine.resume(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-3' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    });
    recovered.recover();
    expect(recovered.isHalted(MARKET)).toBe(false);

    const result = await recovered.submit(MARKET, order({ id: AFTER, side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });
});

describe('one-market halt dual-control', () => {
  it('refuses halt when confirmOperatorId is missing — no journal', async () => {
    const { journal, engine } = build();
    const halt = await engine.halt(MARKET, { operatorId: 'ops-1' });
    expect(halt.accepted).toBe(false);
    expect(halt.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isHalted(MARKET)).toBe(false);
    expect(journal.length).toBe(0);
  });

  it('refuses halt when confirmOperatorId is the same caller — no journal', async () => {
    const { journal, engine } = build();
    const halt = await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(halt.accepted).toBe(false);
    expect(halt.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isHalted(MARKET)).toBe(false);
    expect(journal.length).toBe(0);
  });

  it('refuses resume when confirm is missing or the same — leaves the halt', async () => {
    const { journal, engine } = build();
    await engine.halt(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const before = journal.length;

    const missing = await engine.resume(MARKET, { operatorId: 'ops-2' });
    expect(missing.accepted).toBe(false);
    expect(missing.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isHalted(MARKET)).toBe(true);

    const same = await engine.resume(MARKET, { operatorId: 'ops-2', confirmOperatorId: 'ops-2' });
    expect(same.accepted).toBe(false);
    expect(engine.isHalted(MARKET)).toBe(true);
    expect(journal.length).toBe(before);
  });
});

describe('dualControlRefuse', () => {
  it('refuses unset or same operator ids', () => {
    expect(dualControlRefuse(null, 'ops-2')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('ops-1', null)?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('ops-1', 'ops-1')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('ops-1', 'ops-2')).toBeNull();
    expect(readConfirmOperatorId({})).toBeNull();
    expect(readConfirmOperatorId({ confirmOperatorId: '  ops-2  ' })).toBe('ops-2');
  });

  it('refuses a blank or whitespace-only id when the caller skipped the readers', () => {
    expect(dualControlRefuse('', 'ops-2')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse(' ', 'ops-2')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('\t', 'ops-2')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('ops-1', '')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('ops-1', '   ')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('   ', '   ')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('ops-1', 'ops-1')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse(' ops-1 ', 'ops-1')?.code).toBe(MISSING_OPERATOR);
    expect(dualControlRefuse('ops-1', 'ops-2')).toBeNull();
    expect(dualControlRefuse(' ops-1 ', ' ops-2 ')).toBeNull();
  });
});

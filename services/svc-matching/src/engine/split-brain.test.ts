import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal, replay } from './journal.js';
import { MISSING_OPERATOR } from './halt.js';
import { SPLIT_BRAIN, replaySplitBrain } from './split-brain.js';
import { installCodFence } from './cod-fence.js';
import type { EngineOrder, OrderSide } from './types.js';

installCodFence();

type SplitBrainHost = MatchingEngine & {
  declareSplitBrain(cmd: { operatorId?: string; confirmOperatorId?: string }): Promise<{
    accepted: boolean;
    rejected?: { code: string };
    splitBrain?: boolean;
  }>;
  clearSplitBrain(cmd: { operatorId?: string; confirmOperatorId?: string }): Promise<{
    accepted: boolean;
    rejected?: { code: string };
    splitBrain?: boolean;
  }>;
  isSplitBrain: boolean;
};

/**
 * Split-brain fence (PX-S03). Submit+amend refuse. Cancels stay.
 * Declare/clear needs two distinct operator ids. Unset/same refuses.
 */

const MARKET = 'BTC/USDT';
const REST = '11111111-1111-4111-8111-111111111111';
const TAKER = '22222222-2222-4222-8222-222222222222';
const AFTER = '33333333-3333-4333-8333-333333333333';

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
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 }) as SplitBrainHost;
  return { journal, bus, engine };
}

describe('split-brain fence — PX-S03', () => {
  it('refuses declare when operator or confirm is unset — no journal', async () => {
    const { journal, engine } = build();
    const missing = await engine.declareSplitBrain({});
    expect(missing.accepted).toBe(false);
    expect(missing.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isSplitBrain).toBe(false);
    expect(journal.length).toBe(0);

    const noConfirm = await engine.declareSplitBrain({ operatorId: 'ops-1' });
    expect(noConfirm.accepted).toBe(false);
    expect(noConfirm.rejected?.code).toBe(MISSING_OPERATOR);
    expect(journal.length).toBe(0);
  });

  it('refuses declare when both ids are the same caller — no journal', async () => {
    const { journal, engine } = build();
    const same = await engine.declareSplitBrain({ operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    expect(same.accepted).toBe(false);
    expect(same.rejected?.code).toBe(MISSING_OPERATOR);
    expect(engine.isSplitBrain).toBe(false);
    expect(journal.length).toBe(0);
  });

  it('declared split-brain refuses submit and amend, journals nothing for those, cancels stay', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100' }));
    const declared = await engine.declareSplitBrain({ operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    expect(declared.accepted).toBe(true);
    expect(declared.splitBrain).toBe(true);
    expect(engine.isSplitBrain).toBe(true);

    const before = journal.length;
    const submit = await engine.submit(MARKET, order({ id: TAKER, side: 'buy', qty: '1', price: '100' }));
    expect(submit.accepted).toBe(false);
    expect(submit.rejected?.code).toBe(SPLIT_BRAIN);
    expect(submit.sequence).toBeNull();
    expect(submit.fills).toEqual([]);

    const amended = await engine.amend(MARKET, { orderId: REST, expectedVersion: 1, qty: parseAmount('2') });
    expect(amended.accepted).toBe(false);
    expect(amended.rejected?.code).toBe(SPLIT_BRAIN);
    expect(journal.length).toBe(before);

    const cancelled = await engine.cancel(MARKET, REST);
    expect(cancelled.cancelled).toBe(true);
  });

  it('clear needs two distinct operators; then submits resume', async () => {
    const { engine } = build();
    await engine.declareSplitBrain({ operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    const refused = await engine.clearSplitBrain({ operatorId: 'ops-2', confirmOperatorId: 'ops-2' });
    expect(refused.accepted).toBe(false);
    expect(engine.isSplitBrain).toBe(true);

    const cleared = await engine.clearSplitBrain({ operatorId: 'ops-2', confirmOperatorId: 'ops-3' });
    expect(cleared.accepted).toBe(true);
    expect(cleared.splitBrain).toBe(false);
    expect(engine.isSplitBrain).toBe(false);

    const result = await engine.submit(MARKET, order({ id: AFTER, side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });

  it('replays split-brain so a recovered engine still refuses order entry', async () => {
    const { journal, engine } = build();
    await engine.submit(MARKET, order({ id: REST, side: 'sell', qty: '1', price: '100' }));
    await engine.declareSplitBrain({ operatorId: 'ops-1', confirmOperatorId: 'ops-2' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    }) as SplitBrainHost;
    await recovered.recover();

    expect(recovered.isSplitBrain).toBe(true);
    expect(replaySplitBrain(journal.read())).toBe(true);
    expect(replay(journal.read()).has(MARKET)).toBe(true);

    const blocked = await recovered.submit(MARKET, order({ id: TAKER, side: 'buy', qty: '1', price: '100' }));
    expect(blocked.accepted).toBe(false);
    expect(blocked.rejected?.code).toBe(SPLIT_BRAIN);
  });

  it('replay of declare then clear leaves order entry open', async () => {
    const { journal, engine } = build();
    await engine.declareSplitBrain({ operatorId: 'ops-1', confirmOperatorId: 'ops-2' });
    await engine.clearSplitBrain({ operatorId: 'ops-2', confirmOperatorId: 'ops-3' });

    const recovered = new MatchingEngine({
      journal,
      bus: new MemoryEventBus('svc-matching'),
      snapshotEvery: 0,
    }) as SplitBrainHost;
    await recovered.recover();
    expect(recovered.isSplitBrain).toBe(false);

    const result = await recovered.submit(MARKET, order({ id: AFTER, side: 'sell', qty: '1', price: '100' }));
    expect(result.accepted).toBe(true);
  });
});

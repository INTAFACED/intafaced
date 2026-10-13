import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { VenueOrder } from '@intafaced/venue-contracts';
import type { OmsCancelFn } from './oms-cancel.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';
import { amendRemainingLiveAlgoParent } from './oms-amend-remaining.js';

const OP = '33333333-3333-4333-8333-333333333333';
const leftover = '10';
const now = new Date('2026-08-25T00:00:00.000Z');

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function retainedVwap(): RetainedAlgoSchedule {
  return { durationMs: 120_000, sliceIntervalMs: 15_000, slicesPlanned: 8, participationBps: null };
}

function retainedPov(): RetainedAlgoSchedule {
  return { durationMs: 90_000, sliceIntervalMs: 5_000, slicesPlanned: 18, participationBps: 150 };
}

function live(
  over: Partial<ApprovedAlgoParent> &
    Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'> & {
      schedule?: RetainedAlgoSchedule;
    },
): ApprovedAlgoParent {
  const schedule = over.schedule ?? (over.kind === 'pov' ? retainedPov() : over.kind === 'vwap' ? retainedVwap() : retainedTwap());
  return {
    status: 'approved',
    startedAt: null,
    executionOwner: OP,
    ...over,
    schedule,
  };
}

function withResidual(
  over: Partial<ApprovedAlgoParent> & Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'>,
  remaining = leftover,
): ApprovedAlgoParent {
  return live({ ...over, residual: { remaining } });
}

function venueOrder(over: Partial<VenueOrder> = {}): VenueOrder {
  return {
    venueId: 'street',
    venueOrderId: 'v-1',
    clientOrderId: 'child-1',
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    price: parseAmount('100'),
    amount: parseAmount('1'),
    filled: ZERO,
    remaining: parseAmount('1'),
    averagePrice: null,
    status: 'canceled',
    feePaid: ZERO,
    feeAsset: 'USDT',
    createdAt: now,
    observedAt: now,
    ...over,
  };
}

class FakeCancel {
  readonly calls: { symbol: string; clientOrderId: string }[] = [];
  constructor(
    private readonly next: VenueOrder | Error,
    readonly id = 'street',
  ) {}
  fn: OmsCancelFn = async (symbol, clientOrderId) => {
    this.calls.push({ symbol, clientOrderId });
    if (this.next instanceof Error) throw this.next;
    return this.next;
  };
}

function seedAck(
  store: InMemoryEmsOrderStore,
  over: {
    clientOrderId?: string;
    parentClientOrderId?: string;
    executionGroupId?: string;
    venueId?: string;
    state?: 'ACKNOWLEDGED' | 'REJECTED' | 'UNWIRED' | 'SUBMIT_UNKNOWN' | 'OUTCOME_UNKNOWN';
  } = {},
) {
  store.record({
    clientOrderId: over.clientOrderId ?? 'child-1',
    parentClientOrderId: over.parentClientOrderId ?? 'parent-1',
    executionGroupId: over.executionGroupId ?? 'algo-1',
    childOrderId: over.clientOrderId ?? 'child-1',
    legIndex: 0,
    venueId: over.venueId ?? 'street',
    symbol: 'BTC/USDT',
    side: 'buy',
    execution: null,
    state: over.state ?? 'ACKNOWLEDGED',
    reconciliationKey: null,
  });
}

describe('amendRemainingLiveAlgoParent', () => {
  it('refuses null/undefined/whitespace remaining with remaining_blank; cancel not called; residual unchanged', async () => {
    for (const remaining of [null, undefined, '   ', ''] as const) {
      const parentStore = new InMemoryApprovedAlgoParentStore();
      parentStore.seed(withResidual({ parentClientOrderId: 'parent-1', kind: 'twap' }));
      const emsStore = new InMemoryEmsOrderStore();
      seedAck(emsStore);
      const street = new FakeCancel(venueOrder());
      const out = await amendRemainingLiveAlgoParent({
        parentClientOrderId: 'parent-1',
        remaining,
        parentStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      });
      expect(out).toMatchObject({ ok: false, reason: 'remaining_blank' });
      expect(street.calls).toEqual([]);
      expect(parentStore.get('parent-1')?.residual?.remaining).toBe(leftover);
    }
  });

  it("refuses 'nope' and negative qty with remaining_invalid; residual unchanged", async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(venueOrder());
    const nope = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-1',
      remaining: 'nope',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    const negative = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-1',
      remaining: '-1',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(nope).toMatchObject({ ok: false, reason: 'remaining_invalid' });
    expect(negative).toMatchObject({ ok: false, reason: 'remaining_invalid' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe(leftover);
  });

  it('refuses missing parentClientOrderId', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(await amendRemainingLiveAlgoParent({ remaining: '4', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(await amendRemainingLiveAlgoParent({ parentClientOrderId: '   ', remaining: '4', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
  });

  it('refuses executionGroupId with parent_only', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(venueOrder());
    expect(
      await amendRemainingLiveAlgoParent({
        parentClientOrderId: 'parent-1',
        executionGroupId: 'algo-1',
        remaining: '4',
        parentStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'parent_only' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe(leftover);
  });

  it('refuses not_found', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(
      await amendRemainingLiveAlgoParent({
        parentClientOrderId: 'missing',
        remaining: '4',
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('refuses paper/stopped with not_live; residual unchanged', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-paper', kind: 'twap', status: 'paper' }));
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-stop', kind: 'twap', status: 'stopped' }));
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-staged', kind: 'twap', status: 'staged' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore, { parentClientOrderId: 'parent-paper' });
    seedAck(emsStore, { clientOrderId: 'child-stop', parentClientOrderId: 'parent-stop' });
    const street = new FakeCancel(venueOrder());
    expect(
      await amendRemainingLiveAlgoParent({
        parentClientOrderId: 'parent-paper',
        remaining: '4',
        parentStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      await amendRemainingLiveAlgoParent({
        parentClientOrderId: 'parent-stop',
        remaining: '4',
        parentStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      await amendRemainingLiveAlgoParent({
        parentClientOrderId: 'parent-staged',
        remaining: '4',
        parentStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-paper')?.residual?.remaining).toBe(leftover);
    expect(parentStore.get('parent-stop')?.residual?.remaining).toBe(leftover);
    expect(parentStore.get('parent-staged')?.residual?.remaining).toBe(leftover);
  });

  it('live parent with no residual: after known cancel, consume refuses missing_residual and does not invent leftover', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(venueOrder());
    const out = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-1',
      remaining: '4',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(street.calls).toHaveLength(1);
    expect(parentStore.get('parent-1')?.residual).toBeUndefined();
  });

  it("live parent + remaining '4' + one ACK child cancelled: amended true, residual is '4'", async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(venueOrder());
    const out = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-1',
      remaining: '4',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out).toMatchObject({
      ok: true,
      amended: true,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      residual: { remaining: '4' },
    });
    if (!out.ok) return;
    expect(out.children).toEqual([{ clientOrderId: 'child-1', venueId: 'street', outcome: 'stopped', status: 'canceled' }]);
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe('4');
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
    expect(street.calls).toHaveLength(1);
  });

  it("remaining '0' is valid (not blank); parent residual becomes 0", async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(venueOrder());
    const out = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-1',
      remaining: '0',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out).toMatchObject({ ok: true, amended: true, residual: { remaining: '0' } });
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe('0');
    expect(street.calls).toHaveLength(1);
  });

  it('venue throw (unknown child): children_unknown; parent residual UNCHANGED; not amended', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(new Error('venue 503'));
    const out = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-1',
      remaining: '4',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out).toMatchObject({ ok: false, reason: 'children_unknown' });
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe(leftover);
    expect(street.calls).toHaveLength(1);
  });

  it('does not cancel another parent', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-2', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore, { parentClientOrderId: 'parent-1' });
    seedAck(emsStore, { clientOrderId: 'child-other', parentClientOrderId: 'parent-2' });
    const street = new FakeCancel(venueOrder());
    const out = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-1',
      remaining: '4',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out.ok).toBe(true);
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe('4');
    expect(parentStore.get('parent-2')?.residual?.remaining).toBe(leftover);
  });

  it('TWAP/VWAP/POV live kinds all amend when remaining present and children known', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    parentStore.seed(
      withResidual({
        parentClientOrderId: 'parent-vwap',
        kind: 'vwap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-pov', kind: 'pov' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore, { clientOrderId: 'child-twap', parentClientOrderId: 'parent-twap' });
    seedAck(emsStore, { clientOrderId: 'child-vwap', parentClientOrderId: 'parent-vwap' });
    seedAck(emsStore, { clientOrderId: 'child-pov', parentClientOrderId: 'parent-pov' });

    const street = new FakeCancel(venueOrder());
    const twap = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      remaining: '4',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    const vwap = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-vwap',
      remaining: '3',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    const pov = await amendRemainingLiveAlgoParent({
      parentClientOrderId: 'parent-pov',
      remaining: '2',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(twap).toMatchObject({
      ok: true,
      amended: true,
      parent: { kind: 'twap' },
      residual: { remaining: '4' },
    });
    expect(vwap).toMatchObject({
      ok: true,
      amended: true,
      parent: { kind: 'vwap' },
      residual: { remaining: '3' },
    });
    expect(pov).toMatchObject({
      ok: true,
      amended: true,
      parent: { kind: 'pov' },
      residual: { remaining: '2' },
    });
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('4');
    expect(parentStore.get('parent-vwap')?.residual?.remaining).toBe('3');
    expect(parentStore.get('parent-pov')?.residual?.remaining).toBe('2');
    expect(street.calls).toHaveLength(3);
  });
});

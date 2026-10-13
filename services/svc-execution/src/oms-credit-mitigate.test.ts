import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { VenueOrder } from '@intafaced/venue-contracts';
import type { OmsCancelFn } from './oms-cancel.js';
import { cancelRemainingOnCreditBreach } from './oms-credit-mitigate.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent } from './oms-start.js';

const now = new Date('2026-08-25T00:00:00.000Z');

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

function seedParent(parentStore: InMemoryApprovedAlgoParentStore, over: Partial<ApprovedAlgoParent> = {}): void {
  parentStore.seed({
    parentClientOrderId: 'parent-1',
    kind: 'twap',
    status: 'running',
    schedule: {
      durationMs: 60_000,
      sliceIntervalMs: 10_000,
      slicesPlanned: 6,
      participationBps: null,
    },
    startedAt: '2026-08-25T12:00:00.000Z',
    residual: { remaining: '2' },
    ...over,
  });
}

describe('cancelRemainingOnCreditBreach', () => {
  it('refuses null credit with reason credit_blank — does not cancel', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: null,
      usedCredit: '150',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(street.calls).toHaveLength(0);
  });

  it('refuses undefined credit with reason credit_blank — does not cancel', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: undefined,
      usedCredit: '150',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(street.calls).toHaveLength(0);
  });

  it('refuses whitespace credit with reason credit_blank — does not cancel', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '   ',
      usedCredit: '150',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(street.calls).toHaveLength(0);
  });

  it("refuses invalid credit ('nope') with reason credit_invalid", async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: 'nope',
      usedCredit: '150',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_invalid' });
    expect(street.calls).toHaveLength(0);
  });

  it('refuses blank usedCredit with reason used_credit_blank — does not invent usage, does not cancel', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const blank = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: '   ',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    const missing = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: null,
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(blank).toMatchObject({ ok: false, reason: 'used_credit_blank' });
    expect(missing).toMatchObject({ ok: false, reason: 'used_credit_blank' });
    expect(street.calls).toHaveLength(0);
  });

  it('refuses invalid usedCredit with reason used_credit_invalid', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: 'nope',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: false, reason: 'used_credit_invalid' });
    expect(street.calls).toHaveLength(0);
  });

  it('refuses missing parentClientOrderId with missing_parent', async () => {
    const result = await cancelRemainingOnCreditBreach({
      credit: '100',
      usedCredit: '150',
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('refuses executionGroupId with parent_only', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      executionGroupId: 'algo-1',
      credit: '100',
      usedCredit: '150',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: false, reason: 'parent_only' });
    expect(street.calls).toHaveLength(0);
  });

  it('usedCredit below credit is not a breach — children empty, no cancel, residual stays on parent', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const parentStore = new InMemoryApprovedAlgoParentStore();
    seedParent(parentStore);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: '99',
      cancelByVenue: { street: street.fn },
      emsStore: store,
      parentStore,
    });
    expect(result).toMatchObject({
      ok: true,
      breached: false,
      parent: { parentClientOrderId: 'parent-1' },
      credit: '100',
      usedCredit: '99',
    });
    if (!result.ok || result.breached) return;
    expect(result.children).toEqual([]);
    expect(result.residual).toEqual({ remaining: '2' });
    expect(street.calls).toHaveLength(0);
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe('2');
    expect(parentStore.get('parent-1')?.residual?.released).not.toBe(true);
    expect(result).not.toHaveProperty('flatten');
  });

  it('usedCredit equal to credit is not a breach — children empty, no cancel, residual stays on parent', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const parentStore = new InMemoryApprovedAlgoParentStore();
    seedParent(parentStore);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: '100',
      cancelByVenue: { street: street.fn },
      emsStore: store,
      parentStore,
    });
    expect(result).toMatchObject({ ok: true, breached: false });
    if (!result.ok || result.breached) return;
    expect(result.children).toEqual([]);
    expect(street.calls).toHaveLength(0);
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe('2');
    expect(parentStore.get('parent-1')?.residual?.released).not.toBe(true);
  });

  it('usedCredit above credit cancels remaining children; residual stays on the parent', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const parentStore = new InMemoryApprovedAlgoParentStore();
    seedParent(parentStore);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: '101',
      cancelByVenue: { street: street.fn },
      emsStore: store,
      parentStore,
    });
    expect(result).toMatchObject({
      ok: true,
      breached: true,
      parent: { parentClientOrderId: 'parent-1' },
      credit: '100',
      usedCredit: '101',
    });
    if (!result.ok || !result.breached) return;
    expect(result.children).toEqual([{ clientOrderId: 'child-1', venueId: 'street', outcome: 'stopped', status: 'canceled' }]);
    expect(result.residual).toEqual({ filled: '0', remaining: '1' });
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe('2');
    expect(parentStore.get('parent-1')?.residual?.released).not.toBe(true);
    expect(result).not.toHaveProperty('flatten');
  });

  it('does not cancel another parent', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store, { parentClientOrderId: 'parent-1' });
    seedAck(store, { clientOrderId: 'child-other', parentClientOrderId: 'parent-2' });
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: '101',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.breached) return;
    expect(result.children.map((c) => c.clientOrderId)).toEqual(['child-1']);
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
  });

  it('missing EMS store on a breach is ems_store_unwired', async () => {
    const result = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: '101',
    });
    expect(result).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
  });

  it('result has no flatten field', async () => {
    const clear = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: '100',
      usedCredit: '50',
    });
    expect(clear).not.toHaveProperty('flatten');
    const refused = await cancelRemainingOnCreditBreach({
      parentClientOrderId: 'parent-1',
      credit: null,
      usedCredit: '50',
    });
    expect(refused).not.toHaveProperty('flatten');
  });
});

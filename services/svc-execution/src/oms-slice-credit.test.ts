import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, sub, ZERO } from '@intafaced/ledger-client';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';
import { sliceLiveAlgoParentWithSessionCredit } from './oms-slice-credit.js';

const OP = '33333333-3333-4333-8333-333333333333';
const leftover = '10';

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function live(
  over: Partial<ApprovedAlgoParent> &
    Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'> & {
      schedule?: RetainedAlgoSchedule;
    },
): ApprovedAlgoParent {
  const schedule = over.schedule ?? retainedTwap();
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

function ack(req: SubmitRequest): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-slice-1',
    filledAmount: req.amount,
    averagePrice: req.limitPrice,
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'filled',
    executedAt: new Date('2026-08-25T00:00:00.000Z'),
  };
}

function trackingSubmit(): { calls: SubmitRequest[]; submit: OmsSubmitFn } {
  const calls: SubmitRequest[] = [];
  return {
    calls,
    submit: async (req) => {
      calls.push(req);
      return ack(req);
    },
  };
}

const sliceFields = {
  amount: '0.5',
  venueId: 'street',
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  limitPrice: '100',
  parentCap: '100',
};

describe('sliceLiveAlgoParentWithSessionCredit', () => {
  it('refuses null credit with reason credit_blank; submit not called; residual.remaining still leftover', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const result = await sliceLiveAlgoParentWithSessionCredit({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
      submit: street.submit,
      credit: null,
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it('refuses undefined credit with reason credit_blank; residual unchanged', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const result = await sliceLiveAlgoParentWithSessionCredit({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
      submit: street.submit,
      credit: undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it('refuses whitespace credit with reason credit_blank; residual unchanged', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const result = await sliceLiveAlgoParentWithSessionCredit({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
      submit: street.submit,
      credit: '   ',
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it("refuses invalid credit ('nope') with reason credit_invalid; residual unchanged; submit not called", async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const result = await sliceLiveAlgoParentWithSessionCredit({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
      submit: street.submit,
      credit: 'nope',
    });
    expect(result).toMatchObject({ ok: false, reason: 'credit_invalid' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it("with credit '100' + live parent + residual + wired submit: slice succeeds, remaining falls by qty", async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const result = await sliceLiveAlgoParentWithSessionCredit({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
      submit: street.submit,
      credit: '100',
    });
    const left = formatAmount(sub(parseAmount(leftover), parseAmount('0.5')));
    expect(result).toMatchObject({
      ok: true,
      sliced: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      child: { venueId: 'street' },
      residual: { remaining: left },
    });
    expect(street.calls).toHaveLength(1);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(left);
  });

  it("with credit '0' (not blank): slice proceeds — zero is an owner limit, not invented", async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const result = await sliceLiveAlgoParentWithSessionCredit({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
      submit: street.submit,
      credit: '0',
    });
    const left = formatAmount(sub(parseAmount(leftover), parseAmount('0.5')));
    expect(result).toMatchObject({ ok: true, sliced: true, residual: { remaining: left } });
    expect(street.calls).toHaveLength(1);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(left);
  });

  it('paper parent still refuses after a present credit (delegate to slice) — residual unchanged if seeded', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(withResidual({ parentClientOrderId: 'parent-paper', kind: 'twap', status: 'paper' }));
    const street = trackingSubmit();
    const result = await sliceLiveAlgoParentWithSessionCredit({
      parentClientOrderId: 'parent-paper',
      ...sliceFields,
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
      submit: street.submit,
      credit: '100',
    });
    expect(result).toMatchObject({ ok: false, reason: 'paper' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-paper')?.residual?.remaining).toBe(leftover);
  });
});

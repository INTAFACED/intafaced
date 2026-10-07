import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, sub, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';
import { InMemoryEmsOrderStore, type EmsOrderStore } from './oms-ems-store.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';
import { scheduleSliceLiveAlgoParent } from './oms-schedule-slice.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-schedule-slice-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const STARTED_AT = '2026-08-25T00:00:00.000Z';
const START = new Date(STARTED_AT);
const INTERVAL = 10_000;
const BEFORE_START = new Date(START.getTime() - 1);
const AT_SECOND = new Date(START.getTime() + INTERVAL);
const BEFORE_SECOND = new Date(START.getTime() + INTERVAL - 1);
const OVERDUE = new Date(START.getTime() + INTERVAL * 5);
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function hmacSigned(p: Principal = principal()) {
  return { ...signed(p), service: 'svc-execution' as const };
}

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: INTERVAL, slicesPlanned: 6, participationBps: null };
}

function retainedVwap(): RetainedAlgoSchedule {
  return { durationMs: 120_000, sliceIntervalMs: 15_000, slicesPlanned: 8, participationBps: null };
}

function retainedPov(): RetainedAlgoSchedule {
  return { durationMs: 90_000, sliceIntervalMs: 5_000, slicesPlanned: 18, participationBps: 150 };
}

function live(over: Partial<ApprovedAlgoParent> & Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'>): ApprovedAlgoParent {
  const schedule = over.schedule ?? (over.kind === 'pov' ? retainedPov() : over.kind === 'vwap' ? retainedVwap() : retainedTwap());
  return {
    status: 'running',
    startedAt: STARTED_AT,
    executionOwner: OP,
    residual: { remaining: leftover },
    ...over,
    schedule,
  };
}

function ack(req: SubmitRequest): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-sched-1',
    filledAmount: req.amount,
    averagePrice: req.limitPrice,
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'filled',
    executedAt: START,
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

/** Record is accepted and then dropped, so a following list never shows the child. */
function storeThatDropsRecords(): EmsOrderStore {
  return {
    record() {},
    get() {
      return null;
    },
    getByReconciliationKey() {
      return null;
    },
    list() {
      return [];
    },
  };
}

const leftover = '10';
const sliceFields = {
  amount: '0.5',
  venueId: 'street',
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  limitPrice: '100',
  parentCap: '100',
};

describe('scheduleSliceLiveAlgoParent', () => {
  it('live TWAP/VWAP/POV parent + clock at start takes slice 0 through oms-slice', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-vwap',
        kind: 'vwap',
        schedule: retainedVwap(),
      }),
    );
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-pov',
        kind: 'pov',
        schedule: retainedPov(),
      }),
    );

    const twapSubmit = trackingSubmit();
    const twap = await scheduleSliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      now: START,
      parentStore,
      submit: twapSubmit.submit,
      emsStore: new InMemoryEmsOrderStore(),
    });
    const twapLeft = formatAmount(sub(parseAmount(leftover), parseAmount('0.5')));
    expect(twap).toMatchObject({
      ok: true,
      sliced: true,
      scheduled: true,
      sliceIndex: 0,
      slicesPlanned: 6,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      residual: { remaining: twapLeft },
    });
    expect(twapSubmit.calls).toHaveLength(1);
    expect(twapSubmit.calls[0]?.amount).toBe(parseAmount('0.5'));

    const vwapSubmit = trackingSubmit();
    const vwap = await scheduleSliceLiveAlgoParent({
      parentClientOrderId: 'parent-vwap',
      ...sliceFields,
      now: START,
      parentStore,
      submit: vwapSubmit.submit,
      emsStore: new InMemoryEmsOrderStore(),
    });
    expect(vwap).toMatchObject({
      ok: true,
      scheduled: true,
      sliceIndex: 0,
      parent: { kind: 'vwap' },
    });
    expect(vwapSubmit.calls).toHaveLength(1);

    const povSubmit = trackingSubmit();
    const pov = await scheduleSliceLiveAlgoParent({
      parentClientOrderId: 'parent-pov',
      ...sliceFields,
      amount: '1.25',
      now: START,
      parentStore,
      submit: povSubmit.submit,
      emsStore: new InMemoryEmsOrderStore(),
    });
    expect(pov).toMatchObject({
      ok: true,
      scheduled: true,
      parent: { kind: 'pov' },
    });
    expect(povSubmit.calls[0]?.amount).toBe(parseAmount('1.25'));
  });

  it('clock before the next interval refuses not_due — submit is not called', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: BEFORE_START,
        parentStore,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'not_due' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it('after slice 0, same clock refuses; clock at next interval takes one more child', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    const street = trackingSubmit();
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: START,
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: true, sliceIndex: 0 });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: START,
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_due' });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: BEFORE_SECOND,
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_due' });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: AT_SECOND,
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: true, sliceIndex: 1, scheduled: true });
    expect(street.calls).toHaveLength(2);
    expect(emsStore.list({ parentClientOrderId: 'parent-twap' })).toHaveLength(2);
  });

  it('overdue clock still takes one next slice — never a burst of children', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    const street = trackingSubmit();
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: OVERDUE,
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: true, sliceIndex: 0 });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: OVERDUE,
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_due' });
    expect(street.calls).toHaveLength(1);
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: new Date(OVERDUE.getTime() + INTERVAL),
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: true, sliceIndex: 1 });
    expect(street.calls).toHaveLength(2);
  });

  it('slicesPlanned already taken refuses — never invents extra children', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        schedule: { durationMs: 20_000, sliceIntervalMs: 10_000, slicesPlanned: 1, participationBps: null },
      }),
    );
    const emsStore = new InMemoryEmsOrderStore();
    const street = trackingSubmit();
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: START,
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: true, sliceIndex: 0, slicesPlanned: 1 });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: AT_SECOND,
        parentStore,
        submit: street.submit,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_due' });
    expect(street.calls).toHaveLength(1);
  });

  it('a missing ems store refuses before a slice is submitted', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const first = await scheduleSliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      now: START,
      parentStore,
      submit: street.submit,
    });
    expect(first).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    expect(first).not.toMatchObject({ scheduled: true, sliceIndex: 0, dueAt: STARTED_AT });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);

    const again = await scheduleSliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      now: AT_SECOND,
      parentStore,
      submit: street.submit,
    });
    expect(again).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });

  it('a record that does not keep the child is not scheduled', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    const emsStore = storeThatDropsRecords();
    const result = await scheduleSliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      now: START,
      parentStore,
      submit: street.submit,
      emsStore,
    });
    expect(result).toMatchObject({ ok: false, reason: 'child_not_retained' });
    expect(result).not.toMatchObject({ scheduled: true });
    expect(emsStore.list({ parentClientOrderId: 'parent-twap' })).toEqual([]);
    expect(street.calls).toHaveLength(1);
  });

  it('missing clock / missing schedule / missing remaining refuse', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        parentStore,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_clock' });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: new Date('not-a-date'),
        parentStore,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_clock' });

    const noStart = new InMemoryApprovedAlgoParentStore();
    noStart.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap', startedAt: null }));
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: START,
        parentStore: noStart,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });

    const badSched = new InMemoryApprovedAlgoParentStore();
    badSched.seed(
      live({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        schedule: { durationMs: 60_000, sliceIntervalMs: 0, slicesPlanned: 6, participationBps: null },
      }),
    );
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: START,
        parentStore: badSched,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });

    const noRemain = new InMemoryApprovedAlgoParentStore();
    noRemain.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap', residual: null }));
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        now: START,
        parentStore: noRemain,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(street.calls).toEqual([]);
  });

  it('POV/VWAP never invent qty from participation or a book — missing amount refuses', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-pov', kind: 'pov' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-vwap', kind: 'vwap' }));
    const street = trackingSubmit();
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-pov',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        now: START,
        parentStore,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-vwap',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        now: START,
        parentStore,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(street.calls).toEqual([]);
  });

  it('stopped / paper / staged / missing parent refuse', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-stop', kind: 'twap', status: 'stopped' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-paper', kind: 'twap', status: 'paper' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-staged', kind: 'twap', status: 'staged' }));
    const street = trackingSubmit();
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-stop',
        ...sliceFields,
        now: START,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-paper',
        ...sliceFields,
        now: START,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'paper' });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-staged',
        ...sliceFields,
        now: START,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'staged' });
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'missing',
        ...sliceFields,
        now: START,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(street.calls).toEqual([]);
  });

  it('buy limit worse than parentCap refuses — submit not called', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = trackingSubmit();
    expect(
      await scheduleSliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        limitPrice: '101',
        parentCap: '100',
        now: START,
        parentStore,
        submit: street.submit,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'worse_than_cap' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe(leftover);
  });
});

describe('execution.oms.scheduleSlice tRPC', () => {
  it('door exists (admin:write) and refuses anonymous scheduleSlice', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.scheduleSlice).toBe('function');
    const out = await caller.execution.oms.scheduleSlice({
      parentClientOrderId: 'parent-1',
      ...sliceFields,
      now: START,
    });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.scheduleSlice({
        parentClientOrderId: 'parent-1',
        ...sliceFields,
        now: START,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('takes the due slice through the injected store, clock, and submit bridge', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    const street = trackingSubmit();
    const caller = createExecutionRouter(
      new SealedHouseTenantRegistry(),
      { street: street.submit },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      emsStore,
      undefined,
      undefined,
      parentStore,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.scheduleSlice({
      parentClientOrderId: 'parent-1',
      ...sliceFields,
      now: START,
    });
    const left = formatAmount(sub(parseAmount(leftover), parseAmount('0.5')));
    expect(out).toMatchObject({
      ok: true,
      sliced: true,
      scheduled: true,
      sliceIndex: 0,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      residual: { remaining: left },
    });
    expect(street.calls).toHaveLength(1);
    expect(await caller.execution.oms.scheduleSlice({ parentClientOrderId: 'parent-1', ...sliceFields })).toMatchObject({
      ok: false,
      reason: 'missing_clock',
    });
    expect(
      await caller.execution.oms.scheduleSlice({
        parentClientOrderId: 'parent-1',
        ...sliceFields,
        now: START,
      }),
    ).toMatchObject({ ok: false, reason: 'not_due' });
    expect(parentStore.get('parent-1')?.residual?.remaining).toBe(left);
  });
});

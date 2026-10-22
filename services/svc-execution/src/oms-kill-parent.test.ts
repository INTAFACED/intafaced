import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';
import type { VenueOrder } from '@intafaced/venue-contracts';
import type { OmsCancelFn } from './oms-cancel.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { InMemoryAlgoPauseStore } from './oms-pause.js';
import {
  InMemoryApprovedAlgoParentStore,
  type ApprovedAlgoParent,
  type ApprovedAlgoParentStore,
  type RetainedAlgoSchedule,
} from './oms-start.js';
import { sliceLiveAlgoParent } from './oms-slice.js';
import { killLiveAlgoParent } from './oms-kill-parent.js';
import { killUnattendedLiveParent } from './oms-unattended-kill.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-kill-parent-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const ORIGINATOR = '55555555-5555-4555-8555-555555555555';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const now = new Date('2026-08-25T00:00:00.000Z');

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

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function live(
  over: Partial<ApprovedAlgoParent> &
    Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'> & {
      schedule?: RetainedAlgoSchedule;
    },
): ApprovedAlgoParent {
  return {
    status: 'approved',
    startedAt: null,
    residual: { remaining: '10' },
    originator: ORIGINATOR,
    ...over,
    schedule: over.schedule ?? retainedTwap(),
  };
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
    parentClientOrderId: over.parentClientOrderId ?? 'parent-twap',
    executionGroupId: over.executionGroupId ?? 'parent-twap',
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

function ack(req: SubmitRequest): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-kill-parent-1',
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

function stubStore(over: Partial<ApprovedAlgoParentStore> = {}): ApprovedAlgoParentStore {
  return {
    get: () => null,
    approve: (parent) => parent,
    start: () => null,
    stop: () => null,
    undeploy: () => null,
    expire: () => null,
    ...over,
  };
}

describe('killLiveAlgoParent', () => {
  it('claimed running parent + operator → children stop, parent stopped, slice refuses', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
        executionOwner: OTHER,
      }),
    );
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(venueOrder());
    const pauseStore = new InMemoryAlgoPauseStore();

    expect(
      await killUnattendedLiveParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        parentStore,
        pauseStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'already_claimed' });
    expect(street.calls).toEqual([]);

    const out = await killLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      pauseStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out).toMatchObject({
      ok: true,
      killed: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
    });
    if (!out.ok) return;
    expect(out.children).toEqual([{ clientOrderId: 'child-1', venueId: 'street', outcome: 'stopped', status: 'canceled' }]);
    expect(out.residual).toEqual({ filled: '0', remaining: '1' });
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
    expect(parentStore.get('parent-twap')).toMatchObject({
      status: 'stopped',
      originator: ORIGINATOR,
      executionOwner: OTHER,
    });
    expect(pauseStore.isPaused({ parentClientOrderId: 'parent-twap' })).toBe(true);

    const streetSubmit = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        amount: '0.5',
        venueId: 'street',
        symbol: 'BTC/USDT',
        side: 'buy',
        limitPrice: '100',
        parentStore,
        submit: streetSubmit.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(streetSubmit.calls).toEqual([]);
  });

  it('does not cancel another parent', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-1',
        kind: 'twap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-2',
        kind: 'vwap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore, { parentClientOrderId: 'parent-1' });
    seedAck(emsStore, { clientOrderId: 'child-other', parentClientOrderId: 'parent-2' });
    const street = new FakeCancel(venueOrder());
    const out = await killLiveAlgoParent({
      parentClientOrderId: 'parent-1',
      operatorId: OP,
      parentStore,
      pauseStore: new InMemoryAlgoPauseStore(),
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.children.map((c) => c.clientOrderId)).toEqual(['child-1']);
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
    expect(parentStore.get('parent-2')?.status).toBe('running');
  });

  it('venue throw is unknown - killed is not true, parent stays live, never invents canceled', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-twap',
        kind: 'pov',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(new Error('venue 503'));
    const out = await killLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      operatorId: OP,
      parentStore,
      pauseStore: new InMemoryAlgoPauseStore(),
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.killed).toBe(false);
    expect(out.children[0]).toMatchObject({ outcome: 'unknown', reason: 'cancel_failed' });
    expect(out.residual).toEqual({ filled: '0', remaining: null });
    expect(out.children.some((c) => c.status === 'canceled')).toBe(false);
    expect(parentStore.get('parent-twap')?.status).toBe('running');
  });

  it('missing operator / group / missing parent refuse — no silent success, no cancel', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore);
    const street = new FakeCancel(venueOrder());
    const pauseStore = new InMemoryAlgoPauseStore();
    expect(await killLiveAlgoParent({ emsStore, parentStore, pauseStore, operatorId: OP })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(
      await killLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        executionGroupId: 'algo-1',
        operatorId: OP,
        parentStore,
        pauseStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'parent_only' });
    expect(
      await killLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: '   ',
        parentStore,
        pauseStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(street.calls).toEqual([]);
    expect(parentStore.get('parent-twap')?.status).toBe('running');
  });

  it('paper / not live / not found refuse-closed', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'paper-twap', kind: 'twap', status: 'paper' }));
    parentStore.seed(live({ parentClientOrderId: 'stopped-twap', kind: 'twap', status: 'stopped' }));
    const emsStore = new InMemoryEmsOrderStore();
    const pauseStore = new InMemoryAlgoPauseStore();
    expect(
      await killLiveAlgoParent({
        parentClientOrderId: 'missing',
        operatorId: OP,
        parentStore,
        pauseStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(
      await killLiveAlgoParent({
        parentClientOrderId: 'paper-twap',
        operatorId: OP,
        parentStore,
        pauseStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'paper' });
    expect(
      await killLiveAlgoParent({
        parentClientOrderId: 'stopped-twap',
        operatorId: OP,
        parentStore,
        pauseStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('unwired stores refuse-closed before cancel', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const street = new FakeCancel(venueOrder());
    expect(await killLiveAlgoParent({ parentClientOrderId: 'parent-twap', operatorId: OP })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
    expect(
      await killLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        parentStore,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'pause_store_unwired' });
    expect(
      await killLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        parentStore,
        pauseStore: new InMemoryAlgoPauseStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    expect(
      await killLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        operatorId: OP,
        parentStore: stubStore({
          get: () => live({ parentClientOrderId: 'parent-twap', kind: 'twap' }),
        }),
        pauseStore: new InMemoryAlgoPauseStore(),
        emsStore: new InMemoryEmsOrderStore(),
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
    expect(street.calls).toEqual([]);
  });
});

describe('execution.oms.killParent tRPC', () => {
  it('door exists (admin:write) and refuses anonymous kill', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(signed());
    expect(typeof caller.execution.oms.killParent).toBe('function');
    const out = await caller.execution.oms.killParent({ parentClientOrderId: 'parent-1' });
    expect(out).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.killParent({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('kills a claimed live parent from the signed principal', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'owned-1',
        kind: 'twap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
        executionOwner: OTHER,
      }),
    );
    const emsStore = new InMemoryEmsOrderStore();
    seedAck(emsStore, { parentClientOrderId: 'owned-1' });
    const street = new FakeCancel(venueOrder());
    const caller = createExecutionRouter(
      new SealedHouseTenantRegistry(),
      {},
      { street: street.fn },
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
    ).createCaller(signed());
    expect(await caller.execution.oms.killUnattended({ parentClientOrderId: 'owned-1' })).toMatchObject({
      ok: false,
      reason: 'already_claimed',
    });
    expect(street.calls).toEqual([]);
    const killed = await caller.execution.oms.killParent({ parentClientOrderId: 'owned-1' });
    expect(killed).toMatchObject({ ok: true, killed: true, parent: { parentClientOrderId: 'owned-1' } });
    if (!killed.ok) return;
    expect(killed.children[0]?.outcome).toBe('stopped');
    expect(parentStore.get('owned-1')?.status).toBe('stopped');
    expect(parentStore.get('owned-1')?.executionOwner).toBe(OTHER);
    expect(street.calls).toHaveLength(1);
  });

  it('body operatorId is ignored — signed principal is the operator', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const caller = createExecutionRouter(
      new SealedHouseTenantRegistry(),
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
      {},
      new InMemoryEmsOrderStore(),
      undefined,
      undefined,
      parentStore,
    ).createCaller(signed());
    const out = await caller.execution.oms.killParent({
      parentClientOrderId: 'parent-1',
      operatorId: OTHER,
    } as { parentClientOrderId: string });
    expect(out).toMatchObject({ ok: true, killed: true });
    expect(parentStore.get('parent-1')?.status).toBe('stopped');
  });
});

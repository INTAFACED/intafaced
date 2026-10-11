import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import type { VenueOrder } from '@intafaced/venue-contracts';
import type { OmsCancelFn } from './oms-cancel.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import {
  InMemoryApprovedAlgoParentStore,
  startApprovedAlgoParent,
  type ApprovedAlgoParent,
  type RetainedAlgoSchedule,
} from './oms-start.js';
import { undeployDrainStoppedAlgoParent } from './oms-undeploy-drain.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-undeploy-drain-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
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
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function stopped(
  over: Partial<ApprovedAlgoParent> & Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'> & { schedule?: RetainedAlgoSchedule },
): ApprovedAlgoParent {
  return {
    status: 'stopped',
    startedAt: '2026-08-25T12:00:00.000Z',
    ...over,
    schedule: over.schedule ?? retainedTwap(),
  };
}

const now = new Date('2026-08-25T00:00:00.000Z');

function execution(over: Partial<VenueExecution> = {}): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-1',
    filledAmount: parseAmount('1'),
    averagePrice: parseAmount('100'),
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'partial',
    executedAt: now,
    ...over,
  };
}

function seedChild(
  store: InMemoryEmsOrderStore,
  over: {
    clientOrderId?: string;
    parentClientOrderId?: string;
    venueId?: string;
    state?: 'ACKNOWLEDGED' | 'REJECTED' | 'UNWIRED' | 'SUBMIT_UNKNOWN' | 'OUTCOME_UNKNOWN' | 'CANCELED';
    execution?: VenueExecution | null;
  } = {},
) {
  store.record({
    clientOrderId: over.clientOrderId ?? 'child-1',
    parentClientOrderId: over.parentClientOrderId ?? 'parent-1',
    executionGroupId: 'algo-1',
    childOrderId: over.clientOrderId ?? 'child-1',
    legIndex: 0,
    venueId: over.venueId ?? 'street',
    symbol: 'BTC/USDT',
    side: 'buy',
    execution: over.execution === undefined ? execution() : over.execution,
    state: over.state ?? 'ACKNOWLEDGED',
    reconciliationKey: null,
  });
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

describe('undeployDrainStoppedAlgoParent', () => {
  it('missing parent id', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(await undeployDrainStoppedAlgoParent({ parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(await undeployDrainStoppedAlgoParent({ parentClientOrderId: '   ', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
  });

  it('parent_only when executionGroupId is supplied', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    seedChild(emsStore);
    const street = new FakeCancel(venueOrder());
    expect(
      await undeployDrainStoppedAlgoParent({
        parentClientOrderId: 'parent-1',
        executionGroupId: 'algo-1',
        parentStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'parent_only' });
    expect(street.calls).toHaveLength(0);
    expect(parentStore.get('parent-1')?.status).toBe('stopped');
  });

  it('not_found when the store has no row', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(
      await undeployDrainStoppedAlgoParent({
        parentClientOrderId: 'missing',
        parentStore,
        emsStore: new InMemoryEmsOrderStore(),
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('paper parent refuses — no cancel', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed({
      ...stopped({ parentClientOrderId: 'parent-paper', kind: 'twap' }),
      status: 'paper',
    });
    seedChild(emsStore, { parentClientOrderId: 'parent-paper' });
    const street = new FakeCancel(venueOrder());
    expect(
      await undeployDrainStoppedAlgoParent({
        parentClientOrderId: 'parent-paper',
        parentStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'paper' });
    expect(street.calls).toHaveLength(0);
    expect(parentStore.get('parent-paper')?.status).toBe('paper');
  });

  it('not_stopped (still live/running) refuses — no cancel', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed({
      ...stopped({ parentClientOrderId: 'parent-run', kind: 'twap' }),
      status: 'running',
    });
    seedChild(emsStore);
    const street = new FakeCancel(venueOrder());
    expect(
      await undeployDrainStoppedAlgoParent({
        parentClientOrderId: 'parent-run',
        parentStore,
        emsStore,
        cancelByVenue: { street: street.fn },
      }),
    ).toMatchObject({ ok: false, reason: 'not_stopped' });
    expect(street.calls).toHaveLength(0);
    expect(parentStore.get('parent-run')?.status).toBe('running');
  });

  it('store unwired', async () => {
    expect(await undeployDrainStoppedAlgoParent({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
  });

  it('ems store unwired when the parent is stopped', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    expect(await undeployDrainStoppedAlgoParent({ parentClientOrderId: 'parent-1', parentStore })).toMatchObject({
      ok: false,
      reason: 'ems_store_unwired',
    });
    expect(parentStore.get('parent-1')?.status).toBe('stopped');
  });

  it('cancels remaining live children then undeploys', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    seedChild(emsStore, { execution: execution({ status: 'partial' }) });
    const street = new FakeCancel(venueOrder());
    const out = await undeployDrainStoppedAlgoParent({
      parentClientOrderId: 'parent-1',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out).toMatchObject({
      ok: true,
      undeployed: true,
      status: 'undeployed',
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
    });
    if (!out.ok) return;
    expect(out.children).toEqual([{ clientOrderId: 'child-1', venueId: 'street', outcome: 'stopped', status: 'canceled' }]);
    expect(out.residual).toEqual({ filled: '0', remaining: '1' });
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
    expect(emsStore.get('child-1')?.state).toBe('CANCELED');
    expect(parentStore.get('parent-1')?.status).toBe('undeployed');
  });

  it('unknown cancel refuses — parent stays stopped, never silent success', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    seedChild(emsStore, { execution: execution({ status: 'partial' }) });
    const street = new FakeCancel(new Error('venue 503'));
    const out = await undeployDrainStoppedAlgoParent({
      parentClientOrderId: 'parent-1',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out).toMatchObject({
      ok: false,
      reason: 'unknown_cancel',
      children: [{ clientOrderId: 'child-1', venueId: 'street', outcome: 'unknown', reason: 'cancel_failed' }],
      residual: { filled: '0', remaining: null },
    });
    expect(parentStore.get('parent-1')?.status).toBe('stopped');
    expect(emsStore.get('child-1')?.state).toBe('ACKNOWLEDGED');
  });

  it('does not invent a cancel for already_stopped children', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    seedChild(emsStore, { state: 'REJECTED', execution: null });
    const street = new FakeCancel(venueOrder());
    const out = await undeployDrainStoppedAlgoParent({
      parentClientOrderId: 'parent-1',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out).toMatchObject({ ok: false, reason: 'unknown_cancel', residual: { remaining: null } });
    if (!('children' in out)) throw new Error('missing canceled child evidence');
    expect(out.children[0]).toMatchObject({ outcome: 'already_stopped', reason: 'REJECTED' });
    expect(street.calls).toHaveLength(0);
    expect(parentStore.get('parent-1')?.status).toBe('stopped');
  });

  it('does not cancel another parent', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    seedChild(emsStore, { parentClientOrderId: 'parent-1' });
    seedChild(emsStore, { clientOrderId: 'child-other', parentClientOrderId: 'parent-2' });
    const street = new FakeCancel(venueOrder());
    const out = await undeployDrainStoppedAlgoParent({
      parentClientOrderId: 'parent-1',
      parentStore,
      emsStore,
      cancelByVenue: { street: street.fn },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.children.map((c) => c.clientOrderId)).toEqual(['child-1']);
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
    expect(emsStore.get('child-other')?.state).toBe('ACKNOWLEDGED');
  });

  it('after undeployDrain start refuses not_approved', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const out = await undeployDrainStoppedAlgoParent({
      parentClientOrderId: 'parent-1',
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
    });
    expect(out).toMatchObject({ ok: true, undeployed: true });
    expect(
      startApprovedAlgoParent({
        parentClientOrderId: 'parent-1',
        parentStore,
        jobs: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });
});

describe('execution.oms.undeployDrain tRPC', () => {
  it('door exists (admin:write) and refuses anonymous undeployDrain', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.undeployDrain).toBe('function');
    const out = await caller.execution.oms.undeployDrain({ parentClientOrderId: 'parent-1' });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.undeployDrain({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('cancels remaining then undeploys through the injected maps', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    seedChild(emsStore, { execution: execution({ status: 'partial' }) });
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
      { enabled: true },
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.undeployDrain({ parentClientOrderId: 'parent-1' });
    expect(out).toMatchObject({ ok: true, undeployed: true, status: 'undeployed' });
    if (!out.ok) return;
    expect(out.children[0]?.outcome).toBe('stopped');
    expect(street.calls).toHaveLength(1);
    expect(parentStore.get('parent-1')?.status).toBe('undeployed');
    const start = await caller.execution.oms.start({ parentClientOrderId: 'parent-1' });
    expect(start).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('unknown cancel on the door refuses undeploy', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    parentStore.seed(stopped({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    seedChild(emsStore, { execution: execution({ status: 'partial' }) });
    const street = new FakeCancel(new Error('venue 503'));
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
      { enabled: true },
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.undeployDrain({ parentClientOrderId: 'parent-1' });
    expect(out).toMatchObject({ ok: false, reason: 'unknown_cancel' });
    expect(parentStore.get('parent-1')?.status).toBe('stopped');
  });
});

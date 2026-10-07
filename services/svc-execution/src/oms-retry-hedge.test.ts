import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import { InMemoryEmsOrderStore, type EmsOrderStore } from './oms-ems-store.js';
import { commandOutcome } from './oms-execute.js';
import { retryFailedHedgeChild } from './oms-retry-hedge.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-retry-hedge-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const ORIGINATOR = '55555555-5555-4555-8555-555555555555';
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

function live(over: Partial<ApprovedAlgoParent> & Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'>): ApprovedAlgoParent {
  return {
    status: 'approved',
    startedAt: null,
    residual: { remaining: '10' },
    originator: ORIGINATOR,
    ...over,
    schedule: over.schedule ?? retainedTwap(),
  };
}

function execution(over: Partial<VenueExecution> = {}): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-1',
    filledAmount: parseAmount('0.5'),
    averagePrice: parseAmount('100'),
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'filled',
    executedAt: new Date('2026-08-25T00:00:00.000Z'),
    ...over,
  };
}

function seedChild(
  store: InMemoryEmsOrderStore,
  over: {
    clientOrderId?: string;
    parentClientOrderId?: string;
    venueId?: string;
    state?: 'ACKNOWLEDGED' | 'REJECTED' | 'UNWIRED' | 'SUBMIT_UNKNOWN' | 'OUTCOME_UNKNOWN';
    execution?: VenueExecution | null;
    commandOutcome?: ReturnType<typeof commandOutcome>;
  } = {},
) {
  const clientOrderId = over.clientOrderId ?? 'hedge-1';
  store.record({
    clientOrderId,
    parentClientOrderId: over.parentClientOrderId ?? 'parent-twap',
    executionGroupId: 'parent-twap',
    childOrderId: clientOrderId,
    legIndex: 0,
    venueId: over.venueId ?? 'street',
    symbol: 'BTC/USDT',
    side: 'sell',
    execution: over.execution === undefined ? execution() : over.execution,
    state: over.state ?? 'ACKNOWLEDGED',
    commandOutcome: over.commandOutcome,
    reconciliationKey: null,
  });
}

function stubEmsWithoutList(): EmsOrderStore {
  return {
    record: () => undefined,
    get: () => null,
    getByReconciliationKey: () => null,
  } as unknown as EmsOrderStore;
}

describe('retryFailedHedgeChild', () => {
  it('retries one listed failed child on a live parent using the stored venue — no invented fill', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap', executionOwner: OP }));
    const emsStore = new InMemoryEmsOrderStore();
    seedChild(emsStore, {
      clientOrderId: 'filled-1',
      execution: execution({ filledAmount: parseAmount('2'), venueOrderId: 'v-fill' }),
    });
    seedChild(emsStore, { clientOrderId: 'hedge-fail', state: 'REJECTED', execution: null, venueId: 'street' });
    const out = retryFailedHedgeChild({
      parentClientOrderId: 'parent-twap',
      clientOrderId: 'hedge-fail',
      parentStore,
      emsStore,
    });
    expect(out).toEqual({
      ok: true,
      retried: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap', status: 'approved' },
      child: { clientOrderId: 'hedge-fail', venueId: 'street', outcome: 'retried', reason: 'REJECTED' },
      residual: { filled: '2', remaining: null },
    });
    expect(emsStore.get('hedge-fail')).toMatchObject({ state: 'REJECTED', execution: null, venueId: 'street' });
  });

  it('retries a listed REFUSED commandOutcome child on a running parent', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-vwap',
        kind: 'vwap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    const emsStore = new InMemoryEmsOrderStore();
    seedChild(emsStore, {
      parentClientOrderId: 'parent-vwap',
      clientOrderId: 'hedge-refused',
      state: 'ACKNOWLEDGED',
      execution: null,
      commandOutcome: commandOutcome('hedge-refused', 'REFUSED', 'venue.rejected', null),
    });
    const out = retryFailedHedgeChild({
      parentClientOrderId: 'parent-vwap',
      clientOrderId: 'hedge-refused',
      parentStore,
      emsStore,
    });
    expect(out).toMatchObject({
      ok: true,
      retried: true,
      parent: { parentClientOrderId: 'parent-vwap', kind: 'vwap', status: 'running' },
      child: { clientOrderId: 'hedge-refused', venueId: 'street', outcome: 'retried', reason: 'REFUSED' },
    });
  });

  it('missing child / parent refuse — never invents a hedge', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedChild(emsStore, { clientOrderId: 'hedge-fail', state: 'REJECTED', execution: null });
    expect(retryFailedHedgeChild({ parentStore, emsStore })).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(retryFailedHedgeChild({ parentClientOrderId: 'parent-twap', parentStore, emsStore })).toMatchObject({
      ok: false,
      reason: 'missing_child',
    });
    expect(
      retryFailedHedgeChild({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'hedge-missing',
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_listed' });
    expect(
      retryFailedHedgeChild({
        parentClientOrderId: 'missing',
        clientOrderId: 'hedge-fail',
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('paper / not-live parent refuse', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-paper', kind: 'twap', status: 'paper' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-stop', kind: 'twap', status: 'stopped' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedChild(emsStore, { parentClientOrderId: 'parent-paper', clientOrderId: 'paper-child', state: 'REJECTED', execution: null });
    seedChild(emsStore, { parentClientOrderId: 'parent-stop', clientOrderId: 'stop-child', state: 'REJECTED', execution: null });
    expect(
      retryFailedHedgeChild({
        parentClientOrderId: 'parent-paper',
        clientOrderId: 'paper-child',
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'paper' });
    expect(
      retryFailedHedgeChild({
        parentClientOrderId: 'parent-stop',
        clientOrderId: 'stop-child',
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('live filled / unknown children stay off retry — no invented venue or fill', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedChild(emsStore, { clientOrderId: 'child-live' });
    seedChild(emsStore, { clientOrderId: 'child-unknown', state: 'SUBMIT_UNKNOWN', execution: null });
    expect(
      retryFailedHedgeChild({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-live',
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_listed' });
    expect(
      retryFailedHedgeChild({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-unknown',
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_listed' });
  });

  it('unknown sibling keeps remaining unknown — retry does not invent leftover', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedChild(emsStore, { clientOrderId: 'filled-1', execution: execution({ filledAmount: parseAmount('1') }) });
    seedChild(emsStore, { clientOrderId: 'hedge-fail', state: 'UNWIRED', execution: null });
    seedChild(emsStore, { clientOrderId: 'child-unknown', state: 'OUTCOME_UNKNOWN', execution: null });
    const out = retryFailedHedgeChild({
      parentClientOrderId: 'parent-twap',
      clientOrderId: 'hedge-fail',
      parentStore,
      emsStore,
    });
    expect(out).toMatchObject({
      ok: true,
      retried: true,
      residual: { filled: '1', remaining: null },
      child: { venueId: 'street' },
    });
  });

  it('refuses a group or unwired stores', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedChild(emsStore, { clientOrderId: 'hedge-fail', state: 'REJECTED', execution: null });
    expect(
      retryFailedHedgeChild({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'hedge-fail',
        executionGroupId: 'parent-twap',
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_only' });
    expect(retryFailedHedgeChild({ parentClientOrderId: 'parent-twap', clientOrderId: 'hedge-fail', emsStore })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
    expect(retryFailedHedgeChild({ parentClientOrderId: 'parent-twap', clientOrderId: 'hedge-fail', parentStore })).toMatchObject({
      ok: false,
      reason: 'ems_store_unwired',
    });
    expect(
      retryFailedHedgeChild({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'hedge-fail',
        parentStore,
        emsStore: stubEmsWithoutList(),
      }),
    ).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
  });
});

describe('execution.oms.retryHedge tRPC', () => {
  it('refuses anonymous retry', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.retryHedge({
        parentClientOrderId: 'parent-1',
        clientOrderId: 'hedge-1',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('retries a listed failed child through the injected stores; never invents a venue or fill', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-1', kind: 'twap', executionOwner: OP }));
    const emsStore = new InMemoryEmsOrderStore();
    seedChild(emsStore, {
      parentClientOrderId: 'parent-1',
      clientOrderId: 'hedge-1',
      state: 'REJECTED',
      execution: null,
      venueId: 'street',
    });
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
      emsStore,
      undefined,
      undefined,
      parentStore,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.retryHedge({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'hedge-1',
    });
    expect(out).toMatchObject({
      ok: true,
      retried: true,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap', status: 'approved' },
      child: { clientOrderId: 'hedge-1', venueId: 'street', outcome: 'retried' },
    });
    if (!out.ok) return;
    expect(out.child.venueId).toBe('street');
    expect(emsStore.get('hedge-1')).toMatchObject({ execution: null, venueId: 'street' });
  });
});

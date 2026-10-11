import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';
import {
  InMemoryApprovedAlgoParentStore,
  type ApprovedAlgoParent,
  type ApprovedAlgoParentStore,
  type RetainedAlgoSchedule,
} from './oms-start.js';
import { unclaimLiveAlgoParent } from './oms-claim.js';
import { sliceLiveAlgoParent } from './oms-slice.js';
import { listUnattendedLiveParents } from './oms-unattended.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-unattended-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
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
    residual: { remaining: '10' },
    originator: ORIGINATOR,
    ...over,
    schedule,
  };
}

function ack(req: SubmitRequest): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-unattended-1',
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

describe('listUnattendedLiveParents', () => {
  it('returns only live twap|vwap|pov with empty/missing executionOwner — originator stays, owner is never invented', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'unowned-twap', kind: 'twap' }));
    parentStore.seed(
      live({
        parentClientOrderId: 'unowned-vwap',
        kind: 'vwap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
        executionOwner: null,
      }),
    );
    parentStore.seed(live({ parentClientOrderId: 'unowned-pov', kind: 'pov', executionOwner: '   ' }));
    parentStore.seed(
      live({
        parentClientOrderId: 'owned-twap',
        kind: 'twap',
        executionOwner: OP,
      }),
    );
    parentStore.seed(live({ parentClientOrderId: 'paper-twap', kind: 'twap', status: 'paper' }));
    parentStore.seed(live({ parentClientOrderId: 'stopped-twap', kind: 'twap', status: 'stopped' }));
    parentStore.seed(live({ parentClientOrderId: 'expired-twap', kind: 'twap', status: 'expired' }));
    parentStore.seed(live({ parentClientOrderId: 'undeployed-twap', kind: 'twap', status: 'undeployed' }));

    const out = listUnattendedLiveParents({ parentStore });
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.parents.map((row) => row.parentClientOrderId).sort()).toEqual(['unowned-pov', 'unowned-twap', 'unowned-vwap']);
    for (const row of out.parents) {
      expect(row.executionOwner).toBeNull();
      expect(row.originator).toBe(ORIGINATOR);
      expect(['approved', 'running']).toContain(row.status);
      expect(['twap', 'vwap', 'pov']).toContain(row.kind);
    }
    expect(out.parents.find((row) => row.parentClientOrderId === 'unowned-vwap')).toMatchObject({
      kind: 'vwap',
      status: 'running',
      executionOwner: null,
      originator: ORIGINATOR,
    });
  });

  it('empty store is an empty list — never invents a parent or owner', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(listUnattendedLiveParents({ parentStore })).toEqual({ ok: true, parents: [] });
  });

  it('missing originator stays null — never filled from a desk operator', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'no-originator',
        kind: 'twap',
        originator: null,
      }),
    );
    const out = listUnattendedLiveParents({ parentStore });
    expect(out).toMatchObject({
      ok: true,
      parents: [
        {
          parentClientOrderId: 'no-originator',
          kind: 'twap',
          status: 'approved',
          executionOwner: null,
          originator: null,
        },
      ],
    });
  });

  it('unwired store / missing list method refuse-closed', () => {
    expect(listUnattendedLiveParents({})).toMatchObject({ ok: false, reason: 'parent_store_unwired' });
    expect(listUnattendedLiveParents({ parentStore: stubStore() })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
  });
});

describe('sliceLiveAlgoParent unattended', () => {
  it('unowned live parent refuses — submit is not called, leftover unchanged, no owner invented', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-null', kind: 'vwap', executionOwner: null }));
    parentStore.seed(live({ parentClientOrderId: 'parent-blank', kind: 'pov', executionOwner: '   ' }));
    const street = trackingSubmit();
    for (const parentClientOrderId of ['parent-twap', 'parent-null', 'parent-blank'] as const) {
      expect(
        await sliceLiveAlgoParent({
          parentClientOrderId,
          ...sliceFields,
          parentStore,
          submit: street.submit,
        }),
      ).toMatchObject({ ok: false, reason: 'unattended' });
      expect(parentStore.get(parentClientOrderId)?.residual?.remaining).toBe('10');
      expect(
        parentStore.get(parentClientOrderId)?.executionOwner == null || parentStore.get(parentClientOrderId)?.executionOwner?.trim() === '',
      ).toBe(true);
    }
    expect(street.calls).toEqual([]);
  });

  it('claimed owner can still slice', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap', executionOwner: OP, originator: ORIGINATOR }));
    const street = trackingSubmit();
    const out = await sliceLiveAlgoParent({
      parentClientOrderId: 'parent-twap',
      ...sliceFields,
      parentStore,
      emsStore: new InMemoryEmsOrderStore(),
      submit: street.submit,
    });
    expect(out).toMatchObject({
      ok: true,
      sliced: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
    });
    expect(street.calls).toHaveLength(1);
    expect(street.calls[0]?.amount).toBe(parseAmount('0.5'));
    expect(parentStore.get('parent-twap')?.executionOwner).toBe(OP);
    expect(parentStore.get('parent-twap')?.originator).toBe(ORIGINATOR);
  });

  it('unclaim leaves a live parent unattended — list sees it, slice refuses until claimed again', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap', executionOwner: OP, originator: ORIGINATOR }));
    expect(unclaimLiveAlgoParent({ parentClientOrderId: 'parent-twap', operatorId: OP, parentStore })).toMatchObject({
      ok: true,
      claimed: false,
      executionOwner: null,
    });
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
    expect(parentStore.get('parent-twap')?.originator).toBe(ORIGINATOR);

    const listed = listUnattendedLiveParents({ parentStore });
    expect(listed).toMatchObject({
      ok: true,
      parents: [{ parentClientOrderId: 'parent-twap', executionOwner: null, originator: ORIGINATOR }],
    });

    const street = trackingSubmit();
    expect(
      await sliceLiveAlgoParent({
        parentClientOrderId: 'parent-twap',
        ...sliceFields,
        parentStore,
        submit: street.submit,
      }),
    ).toMatchObject({ ok: false, reason: 'unattended' });
    expect(street.calls).toEqual([]);
  });
});

describe('execution.oms.unattended tRPC', () => {
  it('door exists (admin:read) and refuses anonymous list', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.unattended).toBe('function');
    const out = await caller.execution.oms.unattended({ limit: 50 });
    expect(out).toMatchObject({ ok: true, parents: [] });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.unattended({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('lists seeded unowned live parents through the injected store', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'unowned-twap', kind: 'twap' }));
    parentStore.seed(live({ parentClientOrderId: 'owned-twap', kind: 'twap', executionOwner: OTHER }));
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
      undefined,
      undefined,
      undefined,
      parentStore,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.unattended({ limit: 50 });
    expect(out).toMatchObject({
      ok: true,
      parents: [
        {
          parentClientOrderId: 'unowned-twap',
          kind: 'twap',
          status: 'approved',
          executionOwner: null,
          originator: ORIGINATOR,
        },
      ],
    });
  });
});
import { InMemoryEmsOrderStore } from './oms-ems-store.js';

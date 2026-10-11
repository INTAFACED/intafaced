import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import {
  InMemoryApprovedAlgoParentStore,
  startApprovedAlgoParent,
  type ApprovedAlgoParent,
  type RetainedAlgoSchedule,
} from './oms-start.js';
import { approveAlgoParent } from './oms-approve.js';
import { createExecutionRouter } from './router.js';

const MATCHING_OPEN = { venueHalted: false } as const;
const MATCHING_HALTED = { venueHalted: true } as const;

const SECRET = 'a-execution-oms-approve-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
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

function undeployed(over: Partial<ApprovedAlgoParent> & Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'>): ApprovedAlgoParent {
  const schedule = over.schedule ?? (over.kind === 'pov' ? retainedPov() : over.kind === 'vwap' ? retainedVwap() : retainedTwap());
  return {
    status: 'undeployed',
    startedAt: '2026-08-25T12:00:00.000Z',
    ...over,
    schedule,
  };
}

describe('approveAlgoParent', () => {
  it('refuses missing parent, unwired store, unwired jobs, and jobs_off', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(approveAlgoParent({ parentStore, jobs: { enabled: true } })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(approveAlgoParent({ parentClientOrderId: 'parent-1', jobs: { enabled: true } })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
    expect(approveAlgoParent({ parentClientOrderId: 'parent-1', parentStore })).toMatchObject({
      ok: false,
      reason: 'jobs_gate_unwired',
    });
    expect(
      approveAlgoParent({
        parentClientOrderId: 'parent-1',
        kind: 'twap',
        schedule: retainedTwap(),
        parentStore,
        jobs: { enabled: false },
      }),
    ).toMatchObject({ ok: false, reason: 'jobs_off' });
    expect(parentStore.get('parent-1')).toBeNull();
  });

  it('refuses executionGroupId — parent only', () => {
    expect(
      approveAlgoParent({
        parentClientOrderId: 'parent-1',
        executionGroupId: 'grp-1',
        kind: 'twap',
        schedule: retainedTwap(),
        parentStore: new InMemoryApprovedAlgoParentStore(),
        jobs: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'parent_only' });
  });

  it('refuses a new parent without kind or schedule — never invents slices', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(
      approveAlgoParent({
        parentClientOrderId: 'parent-1',
        parentStore,
        jobs: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_kind' });
    expect(
      approveAlgoParent({
        parentClientOrderId: 'parent-1',
        kind: 'twap',
        parentStore,
        jobs: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      approveAlgoParent({
        parentClientOrderId: 'parent-1',
        kind: 'twap',
        schedule: { durationMs: 0, sliceIntervalMs: 0, slicesPlanned: 0, participationBps: null },
        parentStore,
        jobs: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(parentStore.get('parent-1')).toBeNull();
  });

  it('refuses a non-finite schedule and a negative POV rate — never stores or invents one', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const jobs = { enabled: true } as const;
    const cases: Array<{ id: string; kind: 'twap' | 'vwap' | 'pov'; schedule: RetainedAlgoSchedule }> = [
      { id: 'p-nan', kind: 'twap', schedule: { ...retainedTwap(), slicesPlanned: Number.NaN } },
      { id: 'p-inf-slices', kind: 'twap', schedule: { ...retainedTwap(), slicesPlanned: Number.POSITIVE_INFINITY } },
      { id: 'p-frac', kind: 'twap', schedule: { ...retainedTwap(), slicesPlanned: 1.5 } },
      { id: 'p-inf-dur', kind: 'twap', schedule: { ...retainedTwap(), durationMs: Number.POSITIVE_INFINITY } },
      { id: 'p-inf-int', kind: 'vwap', schedule: { ...retainedVwap(), sliceIntervalMs: Number.POSITIVE_INFINITY } },
      { id: 'p-neg-bps', kind: 'pov', schedule: { ...retainedPov(), participationBps: -1 } },
    ];
    for (const row of cases) {
      expect(
        approveAlgoParent({
          parentClientOrderId: row.id,
          kind: row.kind,
          schedule: row.schedule,
          operatorId: OP,
          parentStore,
          jobs,
          matchingVenueHalt: MATCHING_OPEN,
        }),
      ).toMatchObject({ ok: false, reason: 'missing_schedule' });
      expect(parentStore.get(row.id)).toBeNull();
    }

    const kept = { ...retainedPov(), participationBps: 0 };
    expect(
      approveAlgoParent({
        parentClientOrderId: 'p-zero-bps',
        kind: 'pov',
        schedule: kept,
        operatorId: OP,
        parentStore,
        jobs,
        matchingVenueHalt: MATCHING_OPEN,
      }),
    ).toMatchObject({ ok: true, schedule: kept });
    expect(parentStore.get('p-zero-bps')?.schedule).toEqual(kept);
  });

  it('records a new TWAP/VWAP/POV parent as approved from a retained schedule', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const twap = approveAlgoParent({
      parentClientOrderId: 'p-twap',
      kind: 'twap',
      schedule: retainedTwap(),
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
    });
    expect(twap).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'p-twap', kind: 'twap' },
      status: 'approved',
      schedule: retainedTwap(),
    });
    expect(
      approveAlgoParent({
        parentClientOrderId: 'p-vwap',
        kind: 'vwap',
        schedule: retainedVwap(),
        operatorId: OP,
        parentStore,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
      }),
    ).toMatchObject({ ok: true, parent: { kind: 'vwap' }, schedule: retainedVwap() });
    expect(
      approveAlgoParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        schedule: retainedPov(),
        operatorId: OP,
        parentStore,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
      }),
    ).toMatchObject({ ok: true, parent: { kind: 'pov' }, schedule: retainedPov() });
    expect(parentStore.get('p-twap')?.executionOwner).toBe(OP);
    expect(parentStore.get('p-vwap')?.originator).toBe(OP);
  });

  it('missing operator refuses — unsigned cannot deploy', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(
      approveAlgoParent({
        parentClientOrderId: 'p-twap',
        kind: 'twap',
        schedule: retainedTwap(),
        parentStore,
        jobs: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      approveAlgoParent({
        parentClientOrderId: 'p-twap',
        kind: 'twap',
        schedule: retainedTwap(),
        operatorId: '   ',
        parentStore,
        jobs: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(parentStore.get('p-twap')).toBeNull();
  });

  it('re-approves undeployed using the retained schedule; start then works', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(undeployed({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const out = approveAlgoParent({
      parentClientOrderId: 'parent-1',
      kind: 'vwap',
      schedule: retainedVwap(),
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
    });
    expect(out).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      status: 'approved',
      schedule: retainedTwap(),
    });
    expect(parentStore.get('parent-1')?.status).toBe('approved');
    expect(parentStore.get('parent-1')?.startedAt).toBeNull();
    expect(
      startApprovedAlgoParent({
        parentClientOrderId: 'parent-1',
        operatorId: OP,
        parentStore,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
      }),
    ).toMatchObject({ ok: true, started: true, status: 'running', kind: 'twap' });
  });

  it('refuses already approved, running, and stopped', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed({
      ...undeployed({ parentClientOrderId: 'p-ok', kind: 'twap' }),
      status: 'approved',
      startedAt: null,
    });
    parentStore.seed({
      ...undeployed({ parentClientOrderId: 'p-run', kind: 'twap' }),
      status: 'running',
    });
    parentStore.seed({
      ...undeployed({ parentClientOrderId: 'p-stop', kind: 'twap' }),
      status: 'stopped',
    });
    expect(approveAlgoParent({ parentClientOrderId: 'p-ok', parentStore, jobs: { enabled: true } })).toMatchObject({
      ok: false,
      reason: 'already_approved',
    });
    expect(approveAlgoParent({ parentClientOrderId: 'p-run', parentStore, jobs: { enabled: true } })).toMatchObject({
      ok: false,
      reason: 'already_started',
    });
    expect(approveAlgoParent({ parentClientOrderId: 'p-stop', parentStore, jobs: { enabled: true } })).toMatchObject({
      ok: false,
      reason: 'not_undeployed',
    });
  });

  it('matching halt-all refuses venue_halted; missing source refuses; no parent written', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(
      approveAlgoParent({
        parentClientOrderId: 'p-twap',
        kind: 'twap',
        schedule: retainedTwap(),
        operatorId: OP,
        parentStore,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_HALTED,
      }),
    ).toMatchObject({ ok: false, reason: 'venue_halted' });
    expect(
      approveAlgoParent({
        parentClientOrderId: 'p-twap',
        kind: 'twap',
        schedule: retainedTwap(),
        operatorId: OP,
        parentStore,
        jobs: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'venue_halt_unavailable' });
    expect(parentStore.get('p-twap')).toBeNull();
  });
});

describe('execution.oms.approve tRPC', () => {
  it('door exists (admin:write) and refuses anonymous approve', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.approve).toBe('function');
    const out = await caller.execution.oms.approve({
      parentClientOrderId: 'parent-1',
      kind: 'twap',
      schedule: retainedTwap(),
    });
    expect(out).toMatchObject({ ok: false, reason: 'jobs_off' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.approve({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('approves through the injected store so start can run', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
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
      { enabled: true },
      { enabled: false },
      undefined,
      undefined,
      undefined,
      MATCHING_OPEN,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.approve({
      parentClientOrderId: 'parent-1',
      kind: 'twap',
      schedule: retainedTwap(),
    });
    expect(out).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      status: 'approved',
      schedule: retainedTwap(),
    });
    const started = await caller.execution.oms.start({ parentClientOrderId: 'parent-1' });
    expect(started).toMatchObject({ ok: true, started: true, status: 'running' });
    expect(parentStore.get('parent-1')?.executionOwner).toBe(OP);
  });

  it('body operatorId is ignored — signed principal is the operator', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
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
      { enabled: true },
      { enabled: false },
      undefined,
      undefined,
      undefined,
      MATCHING_OPEN,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.approve({
      parentClientOrderId: 'parent-1',
      kind: 'twap',
      schedule: retainedTwap(),
      operatorId: OTHER,
    } as { parentClientOrderId: string; kind: 'twap'; schedule: RetainedAlgoSchedule });
    expect(out).toMatchObject({ ok: true, approved: true, status: 'approved' });
    expect(parentStore.get('parent-1')?.executionOwner).toBe(OP);
  });
});

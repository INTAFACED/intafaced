import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import {
  InMemoryApprovedAlgoParentStore,
  type ApprovedAlgoParent,
  type ApprovedAlgoParentStore,
  type RetainedAlgoSchedule,
} from './oms-start.js';
import { expireAlgoParent } from './oms-expire.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-expire-test-edge-secret';
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
    ...over,
    schedule,
  };
}

describe('expireAlgoParent', () => {
  it('expires a live parent using expireAt already on the row', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const expireAt = '2026-08-25T18:00:00.000Z';
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        schedule: { ...retainedTwap(), expireAt },
      }),
    );
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-run',
        kind: 'vwap',
        status: 'running',
        startedAt: '2026-08-25T12:00:00.000Z',
        schedule: { ...retainedVwap(), expireAt },
      }),
    );
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-pov',
        kind: 'pov',
        schedule: { ...retainedPov(), expireAt },
      }),
    );

    const twap = expireAlgoParent({ parentClientOrderId: 'parent-twap', parentStore });
    const running = expireAlgoParent({ parentClientOrderId: 'parent-run', parentStore });
    const pov = expireAlgoParent({ parentClientOrderId: 'parent-pov', parentStore });

    expect(twap).toEqual({
      ok: true,
      expired: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      status: 'expired',
      schedule: { ...retainedTwap(), expireAt },
      expireAt,
    });
    expect(running).toMatchObject({
      ok: true,
      expired: true,
      parent: { parentClientOrderId: 'parent-run', kind: 'vwap' },
      status: 'expired',
      expireAt,
    });
    expect(pov).toMatchObject({
      ok: true,
      expired: true,
      parent: { kind: 'pov' },
      expireAt,
    });
    expect(parentStore.get('parent-twap')?.status).toBe('expired');
    expect(parentStore.get('parent-run')?.status).toBe('expired');
    expect(parentStore.get('parent-pov')?.status).toBe('expired');
  });

  it('refuses missing expireAt — empty, null, or invalid ISO', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-none', kind: 'twap' }));
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-empty',
        kind: 'twap',
        schedule: { ...retainedTwap(), expireAt: '   ' },
      }),
    );
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-null',
        kind: 'twap',
        schedule: { ...retainedTwap(), expireAt: null },
      }),
    );
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-bad',
        kind: 'twap',
        schedule: { ...retainedTwap(), expireAt: 'not-an-iso' },
      }),
    );
    expect(expireAlgoParent({ parentClientOrderId: 'parent-none', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(expireAlgoParent({ parentClientOrderId: 'parent-empty', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(expireAlgoParent({ parentClientOrderId: 'parent-null', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(expireAlgoParent({ parentClientOrderId: 'parent-bad', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_expire_at',
    });
    expect(parentStore.get('parent-none')?.status).toBe('approved');
  });

  it('refuses invented clock — no expireAt does not compute one from duration', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-dur',
        kind: 'twap',
        startedAt: '2026-08-25T12:00:00.000Z',
        schedule: { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null },
      }),
    );
    const now = new Date('2026-08-25T12:00:00.000Z');
    const out = expireAlgoParent({
      parentClientOrderId: 'parent-dur',
      parentStore,
      now,
    });
    expect(out).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(parentStore.get('parent-dur')?.status).toBe('approved');
    expect(parentStore.get('parent-dur')?.schedule.expireAt).toBeUndefined();
  });

  it('unsupported_kind is refused', () => {
    const parentStore: ApprovedAlgoParentStore = {
      get: () =>
        ({
          parentClientOrderId: 'parent-ice',
          kind: 'iceberg',
          status: 'approved',
          schedule: { ...retainedTwap(), expireAt: '2026-08-25T18:00:00.000Z' },
          startedAt: null,
        }) as unknown as ApprovedAlgoParent,
      approve: (parent) => parent,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
    };
    expect(expireAlgoParent({ parentClientOrderId: 'parent-ice', parentStore })).toMatchObject({
      ok: false,
      reason: 'unsupported_kind',
    });
  });

  it('store unwired / missing parent / not_found', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(expireAlgoParent({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
    expect(expireAlgoParent({ parentStore })).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(expireAlgoParent({ parentClientOrderId: '   ', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(expireAlgoParent({ parentClientOrderId: 'missing', parentStore })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('already_expired / already_stopped / undeployed', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const expireAt = '2026-08-25T18:00:00.000Z';
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-exp',
        kind: 'twap',
        status: 'expired',
        schedule: { ...retainedTwap(), expireAt },
      }),
    );
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-stop',
        kind: 'twap',
        status: 'stopped',
        startedAt: '2026-08-25T12:00:00.000Z',
        schedule: { ...retainedTwap(), expireAt },
      }),
    );
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-und',
        kind: 'twap',
        status: 'undeployed',
        schedule: { ...retainedTwap(), expireAt },
      }),
    );
    expect(expireAlgoParent({ parentClientOrderId: 'parent-exp', parentStore })).toMatchObject({
      ok: false,
      reason: 'already_expired',
    });
    expect(expireAlgoParent({ parentClientOrderId: 'parent-stop', parentStore })).toMatchObject({
      ok: false,
      reason: 'already_stopped',
    });
    expect(expireAlgoParent({ parentClientOrderId: 'parent-und', parentStore })).toMatchObject({
      ok: false,
      reason: 'undeployed',
    });
  });

  it('refuses a paper parent with a parseable expireAt and does not mark it expired', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const expireAt = '2026-08-25T18:00:00.000Z';
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-paper',
        kind: 'twap',
        status: 'paper',
        schedule: { ...retainedTwap(), expireAt },
      }),
    );
    let expireCalls = 0;
    const watched: ApprovedAlgoParentStore = {
      get: (id) => parentStore.get(id),
      approve: (parent) => parentStore.approve(parent),
      start: (id, startedAt, operatorId) => parentStore.start(id, startedAt, operatorId),
      stop: (id) => parentStore.stop(id),
      undeploy: (id) => parentStore.undeploy(id),
      expire: (id) => {
        expireCalls += 1;
        return parentStore.expire(id);
      },
    };

    expect(expireAlgoParent({ parentClientOrderId: 'parent-paper', parentStore: watched })).toMatchObject({
      ok: false,
      reason: 'not_live',
    });
    expect(expireCalls).toBe(0);
    expect(parentStore.get('parent-paper')?.status).toBe('paper');
  });
});

describe('execution.oms.expire tRPC', () => {
  it('door exists (admin:write) and refuses anonymous expire', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.expire).toBe('function');
    const out = await caller.execution.oms.expire({ parentClientOrderId: 'parent-1' });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.expire({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('expires through the injected store using expireAt already on the row', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const expireAt = '2026-08-25T18:00:00.000Z';
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-1',
        kind: 'twap',
        schedule: { ...retainedTwap(), expireAt },
      }),
    );
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
    const out = await caller.execution.oms.expire({ parentClientOrderId: 'parent-1' });
    expect(out).toEqual({
      ok: true,
      expired: true,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      status: 'expired',
      schedule: { ...retainedTwap(), expireAt },
      expireAt,
    });
    expect(parentStore.get('parent-1')?.status).toBe('expired');
  });
});

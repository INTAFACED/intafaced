import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import {
  InMemoryApprovedAlgoParentStore,
  type ApprovedAlgoParent,
  type ApprovedAlgoParentStore,
  type RetainedAlgoSchedule,
} from './oms-start.js';
import { promotePaperParentToLive } from './oms-promote.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-promote-test-edge-secret';
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

function nullPromoteStore(initial: ApprovedAlgoParent, after: ApprovedAlgoParent | null): ApprovedAlgoParentStore {
  let row: ApprovedAlgoParent | null = initial;
  return {
    get: () => row,
    approve: (parent) => parent,
    start: () => null,
    stop: () => null,
    undeploy: () => null,
    expire: () => null,
    promote: () => {
      row = after;
      return null;
    },
  };
}

function paper(
  over: Partial<ApprovedAlgoParent> &
    Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'> & {
      schedule?: RetainedAlgoSchedule;
    },
): ApprovedAlgoParent {
  const schedule = over.schedule ?? (over.kind === 'pov' ? retainedPov() : over.kind === 'vwap' ? retainedVwap() : retainedTwap());
  return {
    status: 'paper',
    startedAt: null,
    ...over,
    schedule,
  };
}

describe('promotePaperParentToLive', () => {
  it('paper parent + retained residual → promoted, residual echoed via ledger-client, no venue', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const leftover = '1.25';
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        residual: { remaining: leftover },
      }),
    );
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-vwap',
        kind: 'vwap',
        residual: { remaining: '0.5' },
      }),
    );
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-pov',
        kind: 'pov',
        residual: { remaining: '2' },
      }),
    );

    const twap = promotePaperParentToLive({ parentClientOrderId: 'parent-twap', parentStore });
    const vwap = promotePaperParentToLive({ parentClientOrderId: 'parent-vwap', parentStore });
    const pov = promotePaperParentToLive({ parentClientOrderId: 'parent-pov', parentStore });

    expect(twap).toEqual({
      ok: true,
      promoted: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      status: 'approved',
      residual: { remaining: formatAmount(parseAmount(leftover)), released: false },
    });
    expect(vwap).toMatchObject({
      ok: true,
      promoted: true,
      parent: { parentClientOrderId: 'parent-vwap', kind: 'vwap' },
      status: 'approved',
      residual: { remaining: formatAmount(parseAmount('0.5')), released: false },
    });
    expect(pov).toMatchObject({
      ok: true,
      promoted: true,
      parent: { kind: 'pov' },
      status: 'approved',
      residual: { remaining: formatAmount(parseAmount('2')), released: false },
    });
    expect(twap).not.toHaveProperty('venue');
    expect(twap).not.toHaveProperty('venueId');
    expect(twap).not.toHaveProperty('children');
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
    expect(parentStore.get('parent-twap')?.residual).toEqual({ remaining: leftover });
    expect(parentStore.get('parent-twap')?.residual?.released).toBeUndefined();
    expect(parentStore.get('parent-vwap')?.status).toBe('approved');
    expect(parentStore.get('parent-pov')?.status).toBe('approved');
  });

  it('a paper parent whose leftover still parses is promote_rejected when the store returns null', () => {
    const row = paper({
      parentClientOrderId: 'parent-twap',
      kind: 'twap',
      residual: { remaining: '1.25' },
    });
    const parentStore: ApprovedAlgoParentStore = {
      get: () => row,
      approve: (parent) => parent,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
      promote: () => null,
    };
    const out = promotePaperParentToLive({ parentClientOrderId: 'parent-twap', parentStore });
    expect(out).toMatchObject({ ok: false, reason: 'promote_rejected' });
    if (out.ok) return;
    expect(out.detail).toContain('the store did not promote this parent');
    expect(out.detail).not.toMatch(/missing/i);
    expect(parentStore.get('parent-twap')?.status).toBe('paper');
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('1.25');
  });

  it('a null promote is not_found when the second read finds no parent', () => {
    const row = paper({
      parentClientOrderId: 'parent-gone',
      kind: 'twap',
      residual: { remaining: '1.25' },
    });
    const parentStore = nullPromoteStore(row, null);
    const out = promotePaperParentToLive({ parentClientOrderId: 'parent-gone', parentStore });
    expect(out).toMatchObject({
      ok: false,
      reason: 'not_found',
      detail: 'no approved algo parent for parent-gone',
    });
  });

  it('a null promote is not_paper when the second read is no longer paper', () => {
    const row = paper({
      parentClientOrderId: 'parent-live',
      kind: 'twap',
      residual: { remaining: '1.25' },
    });
    const parentStore = nullPromoteStore(row, { ...row, status: 'approved' });
    const out = promotePaperParentToLive({ parentClientOrderId: 'parent-live', parentStore });
    expect(out).toMatchObject({
      ok: false,
      reason: 'not_paper',
      detail: 'parent parent-live is approved — promote needs an already paper parent',
    });
    expect(parentStore.get('parent-live')?.status).toBe('approved');
    expect(parentStore.get('parent-live')?.residual?.remaining).toBe('1.25');
  });

  it('a null promote is missing_residual when the second read has no parseable leftover', () => {
    const blank = paper({
      parentClientOrderId: 'parent-blank',
      kind: 'twap',
      residual: { remaining: '1.25' },
    });
    const released = paper({
      parentClientOrderId: 'parent-released',
      kind: 'pov',
      residual: { remaining: '1.25' },
    });
    const invalid = paper({
      parentClientOrderId: 'parent-bad',
      kind: 'vwap',
      residual: { remaining: '1.25' },
    });
    expect(
      promotePaperParentToLive({
        parentClientOrderId: 'parent-blank',
        parentStore: nullPromoteStore(blank, { ...blank, residual: { remaining: '   ' } }),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      promotePaperParentToLive({
        parentClientOrderId: 'parent-released',
        parentStore: nullPromoteStore(released, { ...released, residual: { remaining: '1.25', released: true } }),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      promotePaperParentToLive({
        parentClientOrderId: 'parent-bad',
        parentStore: nullPromoteStore(invalid, { ...invalid, residual: { remaining: 'not-an-amount' } }),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
  });

  it('refuses a null, blank, invalid, or released leftover before promote', () => {
    const rows = [
      paper({ parentClientOrderId: 'parent-none', kind: 'twap' }),
      paper({ parentClientOrderId: 'parent-null', kind: 'twap', residual: null }),
      paper({ parentClientOrderId: 'parent-empty', kind: 'twap', residual: { remaining: '   ' } }),
      paper({ parentClientOrderId: 'parent-bad', kind: 'twap', residual: { remaining: 'not-an-amount' } }),
      paper({ parentClientOrderId: 'parent-released', kind: 'twap', residual: { remaining: '1.25', released: true } }),
    ];
    let promoteCalls = 0;
    for (const row of rows) {
      const parentStore: ApprovedAlgoParentStore = {
        get: (id) => (id === row.parentClientOrderId ? row : null),
        approve: (parent) => parent,
        start: () => null,
        stop: () => null,
        undeploy: () => null,
        expire: () => null,
        promote: () => {
          promoteCalls += 1;
          return null;
        },
      };
      expect(promotePaperParentToLive({ parentClientOrderId: row.parentClientOrderId, parentStore })).toMatchObject({
        ok: false,
        reason: 'missing_residual',
      });
    }
    expect(promoteCalls).toBe(0);
  });

  it('store.promote returns null when residual is missing or status is not paper', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(paper({ parentClientOrderId: 'parent-none', kind: 'twap' }));
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-approved',
        kind: 'twap',
        status: 'approved',
        residual: { remaining: '1.25' },
      }),
    );
    expect(parentStore.promote('parent-none')).toBeNull();
    expect(parentStore.promote('parent-approved')).toBeNull();
    expect(parentStore.get('parent-none')?.status).toBe('paper');
    expect(parentStore.get('parent-approved')?.status).toBe('approved');
  });

  it('refuses missing residual — null, empty, invalid, or released leftover', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(paper({ parentClientOrderId: 'parent-none', kind: 'twap' }));
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-null',
        kind: 'twap',
        residual: null,
      }),
    );
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-empty',
        kind: 'twap',
        residual: { remaining: '   ' },
      }),
    );
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-bad',
        kind: 'twap',
        residual: { remaining: 'not-an-amount' },
      }),
    );
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-released',
        kind: 'twap',
        residual: { remaining: '1.25', released: true },
      }),
    );
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-none', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-null', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-empty', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-bad', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-released', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_residual',
    });
    expect(parentStore.get('parent-none')?.status).toBe('paper');
    expect(parentStore.get('parent-none')?.residual).toBeUndefined();
  });

  it('refuses inventing leftover from duration, slices, or a venue', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-dur',
        kind: 'twap',
        schedule: { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null },
      }),
    );
    const out = promotePaperParentToLive({ parentClientOrderId: 'parent-dur', parentStore });
    expect(out).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(out).not.toHaveProperty('venue');
    expect(out).not.toHaveProperty('venueId');
    expect(parentStore.get('parent-dur')?.status).toBe('paper');
    expect(parentStore.get('parent-dur')?.residual).toBeUndefined();
  });

  it('refuses inventing a venue — leftover stays on the parent, never sent to a venue', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        residual: { remaining: '1.25' },
      }),
    );
    const out = promotePaperParentToLive({ parentClientOrderId: 'parent-twap', parentStore });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out).not.toHaveProperty('venue');
    expect(out).not.toHaveProperty('venueId');
    expect(out).not.toHaveProperty('children');
    expect(out.residual).toEqual({ remaining: formatAmount(parseAmount('1.25')), released: false });
    expect(parentStore.get('parent-twap')?.residual).toEqual({ remaining: '1.25' });
    expect(parentStore.get('parent-twap')?.residual?.released).not.toBe(true);
  });

  it('not_paper when status is approved/running/expired/etc', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-approved',
        kind: 'twap',
        status: 'approved',
        residual: { remaining: '1.25' },
      }),
    );
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-run',
        kind: 'twap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
        residual: { remaining: '1.25' },
      }),
    );
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-exp',
        kind: 'twap',
        status: 'expired',
        residual: { remaining: '1.25' },
      }),
    );
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-stop',
        kind: 'twap',
        status: 'stopped',
        residual: { remaining: '1.25' },
      }),
    );
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-approved', parentStore })).toMatchObject({
      ok: false,
      reason: 'not_paper',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-run', parentStore })).toMatchObject({
      ok: false,
      reason: 'not_paper',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-exp', parentStore })).toMatchObject({
      ok: false,
      reason: 'not_paper',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-stop', parentStore })).toMatchObject({
      ok: false,
      reason: 'not_paper',
    });
    expect(parentStore.get('parent-approved')?.status).toBe('approved');
    expect(parentStore.get('parent-run')?.status).toBe('running');
  });

  it('unwired store / missing promote method', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        residual: { remaining: '1.25' },
      }),
    );
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-twap' })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
    const unwired: ApprovedAlgoParentStore = {
      get: () => parentStore.get('parent-twap'),
      approve: (parent) => parent,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
    };
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-twap', parentStore: unwired })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
  });

  it('missing parent / not_found', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(promotePaperParentToLive({ parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: '   ', parentStore })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(promotePaperParentToLive({ parentClientOrderId: 'missing', parentStore })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('unsupported_kind is refused', () => {
    const parentStore: ApprovedAlgoParentStore = {
      get: () =>
        ({
          parentClientOrderId: 'parent-ice',
          kind: 'iceberg',
          status: 'paper',
          schedule: retainedTwap(),
          startedAt: null,
          residual: { remaining: '1.25' },
        }) as unknown as ApprovedAlgoParent,
      approve: (parent) => parent,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
      promote: () => null,
    };
    expect(promotePaperParentToLive({ parentClientOrderId: 'parent-ice', parentStore })).toMatchObject({
      ok: false,
      reason: 'unsupported_kind',
    });
  });
});

describe('execution.oms.promote tRPC', () => {
  it('door exists (admin:write) and refuses anonymous promote', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.promote).toBe('function');
    const out = await caller.execution.oms.promote({ parentClientOrderId: 'parent-1' });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.promote({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('promotes a paper parent through the injected store — residual echoed, no venue', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const leftover = '1.25';
    parentStore.seed(
      paper({
        parentClientOrderId: 'parent-1',
        kind: 'twap',
        residual: { remaining: leftover },
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
    const out = await caller.execution.oms.promote({ parentClientOrderId: 'parent-1' });
    expect(out).toEqual({
      ok: true,
      promoted: true,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      status: 'approved',
      residual: { remaining: formatAmount(parseAmount(leftover)), released: false },
    });
    expect(out).not.toHaveProperty('venue');
    expect(out).not.toHaveProperty('venueId');
    expect(parentStore.get('parent-1')?.status).toBe('approved');
    expect(parentStore.get('parent-1')?.residual).toEqual({ remaining: leftover });
  });
});

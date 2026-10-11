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
import { paperRunAlgoParent } from './oms-paper.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-paper-test-edge-secret';
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

function approved(
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

describe('paperRunAlgoParent', () => {
  it('paper on + approved parent + retained schedule → ok, no children, residual stays on parent', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const leftover = '1.25';
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        residual: { remaining: leftover },
      }),
    );
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-vwap',
        kind: 'vwap',
        residual: { remaining: '0.5' },
      }),
    );
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-pov',
        kind: 'pov',
        residual: { remaining: '2' },
      }),
    );

    const twap = paperRunAlgoParent({
      parentClientOrderId: 'parent-twap',
      parentStore,
      paper: { enabled: true },
    });
    const vwap = paperRunAlgoParent({
      parentClientOrderId: 'parent-vwap',
      parentStore,
      paper: { enabled: true },
    });
    const pov = paperRunAlgoParent({
      parentClientOrderId: 'parent-pov',
      parentStore,
      paper: { enabled: true },
    });

    expect(twap).toEqual({
      ok: true,
      paper: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      status: 'paper',
      schedule: retainedTwap(),
      children: [],
      residual: { remaining: formatAmount(parseAmount(leftover)), released: false },
    });
    expect(vwap).toMatchObject({
      ok: true,
      paper: true,
      parent: { parentClientOrderId: 'parent-vwap', kind: 'vwap' },
      status: 'paper',
      children: [],
      residual: { remaining: formatAmount(parseAmount('0.5')), released: false },
    });
    expect(pov).toMatchObject({
      ok: true,
      paper: true,
      parent: { kind: 'pov' },
      children: [],
      residual: { remaining: formatAmount(parseAmount('2')), released: false },
    });
    expect(twap).not.toHaveProperty('venue');
    expect(twap).not.toHaveProperty('venueId');
    expect(parentStore.get('parent-twap')?.status).toBe('paper');
    expect(parentStore.get('parent-twap')?.residual).toEqual({ remaining: leftover });
    expect(parentStore.get('parent-twap')?.residual?.released).toBeUndefined();
    expect(parentStore.get('parent-vwap')?.status).toBe('paper');
    expect(parentStore.get('parent-pov')?.status).toBe('paper');
  });

  it('already-paper parent is accepted and residual stays on the parent', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-paper',
        kind: 'twap',
        status: 'paper',
        residual: { remaining: '1.25' },
      }),
    );
    const out = paperRunAlgoParent({
      parentClientOrderId: 'parent-paper',
      parentStore,
      paper: { enabled: true },
    });
    expect(out).toMatchObject({
      ok: true,
      paper: true,
      status: 'paper',
      children: [],
      residual: { remaining: formatAmount(parseAmount('1.25')), released: false },
    });
    expect(parentStore.get('parent-paper')?.residual?.released).toBeUndefined();
  });

  it('paper off refuses even with an approved parent — no live child, no invented venue', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        residual: { remaining: '1.25' },
      }),
    );
    const out = paperRunAlgoParent({
      parentClientOrderId: 'parent-twap',
      parentStore,
      paper: { enabled: false },
    });
    expect(out).toMatchObject({ ok: false, reason: 'paper_off' });
    expect(out).not.toHaveProperty('venue');
    expect(out).not.toHaveProperty('venueId');
    expect(out).not.toHaveProperty('children');
    expect(parentStore.get('parent-twap')?.status).toBe('approved');
  });

  it('refuses inventing a venue — leftover stays on the parent, never sent to a venue', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-twap',
        kind: 'twap',
        residual: { remaining: '1.25' },
      }),
    );
    const out = paperRunAlgoParent({
      parentClientOrderId: 'parent-twap',
      parentStore,
      paper: { enabled: true },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.children).toEqual([]);
    expect(out).not.toHaveProperty('venue');
    expect(out).not.toHaveProperty('venueId');
    expect(out.residual).toEqual({ remaining: formatAmount(parseAmount('1.25')), released: false });
    expect(parentStore.get('parent-twap')?.residual).toEqual({ remaining: '1.25' });
    expect(parentStore.get('parent-twap')?.residual?.released).not.toBe(true);
  });

  it('paper unwired / store unwired', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    expect(paperRunAlgoParent({ parentClientOrderId: 'parent-twap', parentStore })).toMatchObject({
      ok: false,
      reason: 'paper_gate_unwired',
    });
    expect(paperRunAlgoParent({ parentClientOrderId: 'parent-twap', paper: { enabled: true } })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
  });

  it('missing parent id', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(paperRunAlgoParent({ parentStore, paper: { enabled: true } })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(paperRunAlgoParent({ parentClientOrderId: '   ', parentStore, paper: { enabled: true } })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
  });

  it('not_found when the store has no row', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    expect(
      paperRunAlgoParent({
        parentClientOrderId: 'missing',
        parentStore,
        paper: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('not_approved when status is not approved or paper', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-run',
        kind: 'twap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-stop',
        kind: 'twap',
        status: 'stopped',
      }),
    );
    expect(
      paperRunAlgoParent({
        parentClientOrderId: 'parent-run',
        parentStore,
        paper: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
    expect(
      paperRunAlgoParent({
        parentClientOrderId: 'parent-stop',
        parentStore,
        paper: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('unsupported_kind is refused', () => {
    const parentStore: ApprovedAlgoParentStore = {
      get: () =>
        ({
          parentClientOrderId: 'parent-ice',
          kind: 'iceberg',
          status: 'approved',
          schedule: retainedTwap(),
          startedAt: null,
        }) as unknown as ApprovedAlgoParent,
      approve: (parent) => parent,
      start: () => null,
      stop: () => null,
      undeploy: () => null,
      expire: () => null,
      paper: () => null,
    };
    expect(
      paperRunAlgoParent({
        parentClientOrderId: 'parent-ice',
        parentStore,
        paper: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'unsupported_kind' });
  });

  it('missing_schedule for zero duration / POV without bps', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-zero',
        kind: 'twap',
        schedule: { durationMs: 0, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null },
      }),
    );
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-pov-nobs',
        kind: 'pov',
        schedule: { durationMs: 90_000, sliceIntervalMs: 5_000, slicesPlanned: 18, participationBps: null },
      }),
    );
    expect(
      paperRunAlgoParent({
        parentClientOrderId: 'parent-zero',
        parentStore,
        paper: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      paperRunAlgoParent({
        parentClientOrderId: 'parent-pov-nobs',
        parentStore,
        paper: { enabled: true },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
  });

  it('does not invent residual leftover from duration or slices', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(approved({ parentClientOrderId: 'parent-none', kind: 'twap' }));
    const out = paperRunAlgoParent({
      parentClientOrderId: 'parent-none',
      parentStore,
      paper: { enabled: true },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.residual).toBeNull();
    expect(out.children).toEqual([]);
    expect(parentStore.get('parent-none')?.residual).toBeUndefined();
  });

  it('blank remaining is not a leftover and papers with residual null', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-blank',
        kind: 'twap',
        residual: { remaining: '   ' },
      }),
    );
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-empty',
        kind: 'vwap',
        residual: { remaining: '' },
      }),
    );
    const blank = paperRunAlgoParent({
      parentClientOrderId: 'parent-blank',
      parentStore,
      paper: { enabled: true },
    });
    const empty = paperRunAlgoParent({
      parentClientOrderId: 'parent-empty',
      parentStore,
      paper: { enabled: true },
    });
    expect(blank).toMatchObject({ ok: true, paper: true, status: 'paper', children: [], residual: null });
    expect(empty).toMatchObject({ ok: true, paper: true, status: 'paper', children: [], residual: null });
    expect(parentStore.get('parent-blank')?.status).toBe('paper');
    expect(parentStore.get('parent-empty')?.status).toBe('paper');
  });

  it('refuses a retained remaining that is not a ledger amount with missing_residual', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(
      approved({
        parentClientOrderId: 'parent-bad',
        kind: 'twap',
        residual: { remaining: 'not-a-number' },
      }),
    );
    const out = paperRunAlgoParent({
      parentClientOrderId: 'parent-bad',
      parentStore,
      paper: { enabled: true },
    });
    expect(out).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(parentStore.get('parent-bad')?.status).toBe('approved');
    expect(parentStore.get('parent-bad')?.residual).toEqual({ remaining: 'not-a-number' });
  });
});

describe('execution.oms.paper tRPC', () => {
  it('door exists (admin:write) and returns paper_off when default paper gate is off', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.paper).toBe('function');
    const out = await caller.execution.oms.paper({ parentClientOrderId: 'parent-1' });
    expect(out).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses anonymous paper', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.paper({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('papers through the injected store when paper gate is on — no children, residual on parent', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const leftover = '1.25';
    parentStore.seed(
      approved({
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
      { enabled: false },
      { enabled: true },
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.paper({ parentClientOrderId: 'parent-1' });
    expect(out).toEqual({
      ok: true,
      paper: true,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      status: 'paper',
      schedule: retainedTwap(),
      children: [],
      residual: { remaining: formatAmount(parseAmount(leftover)), released: false },
    });
    expect(out).not.toHaveProperty('venue');
    expect(parentStore.get('parent-1')?.status).toBe('paper');
    expect(parentStore.get('parent-1')?.residual).toEqual({ remaining: leftover });
  });
});

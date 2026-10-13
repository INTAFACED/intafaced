import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { assignChildFill, InMemoryFillAssignStore } from './oms-fill-assign.js';
import { confirmChildFill, InMemoryFillConfirmStore, readChildFillConfirmation } from './oms-fill-confirm.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-fill-confirm-test-edge-secret';
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

function live(over: Partial<ApprovedAlgoParent> & Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'>): ApprovedAlgoParent {
  return {
    status: 'approved',
    startedAt: null,
    residual: { remaining: '10' },
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

function seedFill(
  store: InMemoryEmsOrderStore,
  over: {
    clientOrderId?: string;
    parentClientOrderId?: string;
    state?: 'ACKNOWLEDGED' | 'REJECTED' | 'UNWIRED' | 'SUBMIT_UNKNOWN' | 'OUTCOME_UNKNOWN';
    execution?: VenueExecution | null;
  } = {},
) {
  store.record({
    clientOrderId: over.clientOrderId ?? 'child-1',
    parentClientOrderId: over.parentClientOrderId ?? 'parent-twap',
    executionGroupId: 'parent-twap',
    childOrderId: over.clientOrderId ?? 'child-1',
    legIndex: 0,
    venueId: 'street',
    symbol: 'BTC/USDT',
    side: 'buy',
    execution: over.execution === undefined ? execution() : over.execution,
    state: over.state ?? 'ACKNOWLEDGED',
    reconciliationKey: null,
  });
}

describe('confirmChildFill', () => {
  it('live parent + existing child fill + confirmer → confirmed trail, client-accepted', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    parentStore.seed(
      live({
        parentClientOrderId: 'parent-vwap',
        kind: 'vwap',
        status: 'running',
        startedAt: '2026-08-25T00:00:00.000Z',
      }),
    );
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore);
    seedFill(emsStore, { clientOrderId: 'child-vwap', parentClientOrderId: 'parent-vwap' });
    const fillConfirmStore = new InMemoryFillConfirmStore();
    const now = new Date('2026-08-25T12:00:00.000Z');

    const twap = confirmChildFill({
      parentClientOrderId: 'parent-twap',
      clientOrderId: 'child-1',
      confirmerId: OP,
      parentStore,
      emsStore,
      fillConfirmStore,
      now,
    });
    expect(twap).toMatchObject({
      ok: true,
      confirmed: true,
      clientAccepted: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      child: { clientOrderId: 'child-1' },
      fill: { filledAmount: '0.5', averagePrice: '100', status: 'filled' },
      confirmerId: OP,
      confirmedAt: '2026-08-25T12:00:00.000Z',
    });
    expect(fillConfirmStore.get('child-1')).toMatchObject({ confirmerId: OP, parentClientOrderId: 'parent-twap' });

    const vwap = confirmChildFill({
      parentClientOrderId: 'parent-vwap',
      clientOrderId: 'child-vwap',
      confirmerId: OP,
      parentStore,
      emsStore,
      fillConfirmStore,
      now,
    });
    expect(vwap).toMatchObject({
      ok: true,
      confirmed: true,
      clientAccepted: true,
      parent: { parentClientOrderId: 'parent-vwap', kind: 'vwap' },
      confirmerId: OP,
    });
  });

  it('unconfirmed child fill is venue-filled but not client-accepted', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore);
    const fillConfirmStore = new InMemoryFillConfirmStore();
    expect(
      readChildFillConfirmation({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({
      ok: true,
      confirmed: false,
      clientAccepted: false,
      fill: { filledAmount: '0.5', status: 'filled' },
      confirmerId: null,
      confirmedAt: null,
    });
  });

  it('missing confirmer refuses — never invents a user', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore);
    const fillConfirmStore = new InMemoryFillConfirmStore();
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_confirmer' });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        confirmerId: '   ',
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_confirmer' });
    expect(fillConfirmStore.get('child-1')).toBeNull();
  });

  it('confirming a missing fill refuses — never invents leftover as a fill', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    const fillConfirmStore = new InMemoryFillConfirmStore();
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'ghost',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_fill' });

    seedFill(emsStore, { clientOrderId: 'unknown-1', execution: null, state: 'SUBMIT_UNKNOWN' });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'unknown-1',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_fill' });

    seedFill(emsStore, {
      clientOrderId: 'rejected-1',
      execution: execution({ status: 'rejected' }),
      state: 'REJECTED',
    });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'rejected-1',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_fill' });
    expect(fillConfirmStore.get('ghost')).toBeNull();
  });

  it('a zero or negative filled amount or average price is not a child fill and stays off the trail', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    const fillConfirmStore = new InMemoryFillConfirmStore();
    const fillAssignStore = new InMemoryFillAssignStore();
    const bad = [
      { id: 'zero-qty', execution: execution({ filledAmount: ZERO, status: 'filled' }) },
      { id: 'zero-px', execution: execution({ averagePrice: ZERO, status: 'filled' }) },
      { id: 'neg-qty', execution: execution({ filledAmount: parseAmount('-0.5'), status: 'partial' }) },
      { id: 'neg-px', execution: execution({ averagePrice: parseAmount('-100'), status: 'partial' }) },
    ];
    for (const row of bad) {
      seedFill(emsStore, { clientOrderId: row.id, execution: row.execution });
      expect(
        confirmChildFill({
          parentClientOrderId: 'parent-twap',
          clientOrderId: row.id,
          confirmerId: OP,
          parentStore,
          emsStore,
          fillConfirmStore,
        }),
      ).toMatchObject({ ok: false, reason: 'missing_fill' });
      expect(
        readChildFillConfirmation({
          parentClientOrderId: 'parent-twap',
          clientOrderId: row.id,
          parentStore,
          emsStore,
          fillConfirmStore,
        }),
      ).toMatchObject({ ok: false, reason: 'missing_fill' });
      expect(
        assignChildFill({
          parentClientOrderId: 'parent-twap',
          clientOrderId: row.id,
          accountTag: 'client-alpha',
          operatorId: OP,
          parentStore,
          emsStore,
          fillAssignStore,
        }),
      ).toMatchObject({ ok: false, reason: 'missing_fill' });
      expect(fillConfirmStore.get(row.id)).toBeNull();
      expect(fillAssignStore.trail(row.id)).toEqual([]);
    }

    seedFill(emsStore, {
      clientOrderId: 'child-partial',
      execution: execution({
        filledAmount: parseAmount('0.25'),
        averagePrice: parseAmount('50'),
        status: 'partial',
      }),
    });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-partial',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
        now: new Date('2026-08-25T12:00:00.000Z'),
      }),
    ).toMatchObject({
      ok: true,
      confirmed: true,
      clientAccepted: true,
      fill: { filledAmount: '0.25', averagePrice: '50', status: 'partial' },
    });
  });

  it('double-confirm refuses — trail is irreversible', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore);
    const fillConfirmStore = new InMemoryFillConfirmStore();
    const first = confirmChildFill({
      parentClientOrderId: 'parent-twap',
      clientOrderId: 'child-1',
      confirmerId: OP,
      parentStore,
      emsStore,
      fillConfirmStore,
      now: new Date('2026-08-25T12:00:00.000Z'),
    });
    expect(first).toMatchObject({ ok: true, confirmerId: OP });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        confirmerId: OTHER,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'already_confirmed' });
    expect(fillConfirmStore.get('child-1')?.confirmerId).toBe(OP);
  });

  it('paper / not-live / missing parent / missing child refuse', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-paper', kind: 'twap', status: 'paper' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-stop', kind: 'twap', status: 'stopped' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore, { parentClientOrderId: 'parent-paper', clientOrderId: 'paper-child' });
    seedFill(emsStore, { parentClientOrderId: 'parent-stop', clientOrderId: 'stop-child' });
    const fillConfirmStore = new InMemoryFillConfirmStore();
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-paper',
        clientOrderId: 'paper-child',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'paper' });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-stop',
        clientOrderId: 'stop-child',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      confirmChildFill({
        clientOrderId: 'child-1',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      confirmChildFill({
        parentClientOrderId: 'missing',
        clientOrderId: 'child-1',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-paper',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'paper' });
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child' });
  });

  it('child fill on a different parent refuses', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-other', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore, { parentClientOrderId: 'parent-other' });
    const fillConfirmStore = new InMemoryFillConfirmStore();
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        confirmerId: OP,
        parentStore,
        emsStore,
        fillConfirmStore,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_mismatch' });
  });

  it('unwired stores refuse', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore);
    expect(confirmChildFill({ parentClientOrderId: 'parent-twap', clientOrderId: 'child-1', confirmerId: OP })).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        confirmerId: OP,
        parentStore,
      }),
    ).toMatchObject({ ok: false, reason: 'ems_store_unwired' });
    expect(
      confirmChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        confirmerId: OP,
        parentStore,
        emsStore,
      }),
    ).toMatchObject({ ok: false, reason: 'fill_store_unwired' });
  });
});

describe('execution.oms.confirmFill tRPC', () => {
  it('door exists (admin:write) and refuses anonymous confirm', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.confirmFill).toBe('function');
    expect(typeof caller.execution.oms.fill).toBe('function');
    const out = await caller.execution.oms.confirmFill({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'child-1',
    });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.confirmFill({ parentClientOrderId: 'parent-1', clientOrderId: 'child-1' }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('confirms a seeded child fill through the injected stores; unconfirmed is not client-accepted', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore, { parentClientOrderId: 'parent-1' });
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

    const before = await caller.execution.oms.fill({ parentClientOrderId: 'parent-1', clientOrderId: 'child-1' });
    expect(before).toMatchObject({
      ok: true,
      confirmed: false,
      clientAccepted: false,
      confirmerId: null,
      fill: { filledAmount: '0.5', status: 'filled' },
    });

    const confirmed = await caller.execution.oms.confirmFill({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'child-1',
    });
    expect(confirmed).toMatchObject({
      ok: true,
      confirmed: true,
      clientAccepted: true,
      confirmerId: OP,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
    });

    const after = await caller.execution.oms.fill({ parentClientOrderId: 'parent-1', clientOrderId: 'child-1' });
    expect(after).toMatchObject({ ok: true, confirmed: true, clientAccepted: true, confirmerId: OP });

    expect(await caller.execution.oms.confirmFill({ parentClientOrderId: 'parent-1', clientOrderId: 'child-1' })).toMatchObject({
      ok: false,
      reason: 'already_confirmed',
    });
  });

  it('body confirmerId is ignored — signed principal is the confirmer', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-1', kind: 'twap' }));
    const emsStore = new InMemoryEmsOrderStore();
    seedFill(emsStore, { parentClientOrderId: 'parent-1' });
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
    const out = await caller.execution.oms.confirmFill({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'child-1',
      confirmerId: OTHER,
    } as { parentClientOrderId: string; clientOrderId: string });
    expect(out).toMatchObject({ ok: true, confirmed: true, confirmerId: OP });
  });
});

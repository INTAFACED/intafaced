import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { InMemoryManualFillStore, recordManualChildFill, type ManualFillStore } from './oms-manual-fill.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-manual-fill-test-edge-secret';
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

const print = {
  clientOrderId: 'child-1',
  amount: '0.50',
  price: '100.00',
  side: 'buy' as const,
  parentCap: '100',
};

describe('recordManualChildFill', () => {
  it('live parent + qty + price + confirmer → recorded trail, already confirmed', () => {
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
    const manualFillStore = new InMemoryManualFillStore();
    const now = new Date('2026-08-25T12:00:00.000Z');

    const twap = recordManualChildFill({
      parentClientOrderId: 'parent-twap',
      confirmerId: OP,
      parentStore,
      manualFillStore,
      now,
      ...print,
    });
    expect(twap).toMatchObject({
      ok: true,
      recorded: true,
      confirmed: true,
      clientAccepted: true,
      parent: { parentClientOrderId: 'parent-twap', kind: 'twap' },
      child: { clientOrderId: 'child-1' },
      fill: { filledAmount: '0.5', averagePrice: '100' },
      confirmerId: OP,
      confirmedAt: '2026-08-25T12:00:00.000Z',
    });
    expect(manualFillStore.get('child-1')).toMatchObject({
      confirmerId: OP,
      parentClientOrderId: 'parent-twap',
      filledAmount: '0.5',
      averagePrice: '100',
    });
    expect(twap).toMatchObject({ residual: { remaining: '9.5' } });
    expect(parentStore.get('parent-twap')?.residual).toMatchObject({ remaining: '9.5' });
    expect(parentStore.get('parent-vwap')?.residual).toMatchObject({ remaining: '10' });

    const vwap = recordManualChildFill({
      parentClientOrderId: 'parent-vwap',
      clientOrderId: 'child-vwap',
      amount: '1',
      price: '50',
      side: 'buy',
      parentCap: '50',
      confirmerId: OP,
      parentStore,
      manualFillStore,
      now,
    });
    expect(vwap).toMatchObject({
      ok: true,
      recorded: true,
      confirmed: true,
      clientAccepted: true,
      parent: { parentClientOrderId: 'parent-vwap', kind: 'vwap' },
      confirmerId: OP,
      residual: { remaining: '9' },
    });
    expect(parentStore.get('parent-vwap')?.residual).toMatchObject({ remaining: '9' });
  });

  it('qty must not exceed retained residual — leftover stays, no trail', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap', residual: { remaining: '0.25' } }));
    const manualFillStore = new InMemoryManualFillStore();
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'exceeds_remaining' });
    expect(manualFillStore.get('child-1')).toBeNull();
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('0.25');
  });

  it('buy print worse than parentCap refuses — leftover stays, no trail', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const manualFillStore = new InMemoryManualFillStore();
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
        price: '101',
        parentCap: '100',
      }),
    ).toMatchObject({ ok: false, reason: 'worse_than_cap' });
    expect(manualFillStore.get('child-1')).toBeNull();
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('10');
  });

  it('sell print worse than parentCap refuses — leftover stays, no trail', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const manualFillStore = new InMemoryManualFillStore();
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
        side: 'sell',
        price: '99',
        parentCap: '100',
      }),
    ).toMatchObject({ ok: false, reason: 'worse_than_cap' });
    expect(manualFillStore.get('child-1')).toBeNull();
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('10');
  });

  it('missing parentCap refuses — never invents ticks', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const manualFillStore = new InMemoryManualFillStore();
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        amount: '0.5',
        price: '100',
        side: 'buy',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price_cap' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
        parentCap: 'not-a-cap',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price_cap' });
    expect(manualFillStore.get('child-1')).toBeNull();
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('10');
  });

  it('missing remaining refuses — never invents a cap', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-none', kind: 'twap', residual: null }));
    parentStore.seed(live({ parentClientOrderId: 'parent-released', kind: 'twap', residual: { remaining: '10', released: true } }));
    const manualFillStore = new InMemoryManualFillStore();
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-none',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-released',
        clientOrderId: 'child-2',
        amount: '0.5',
        price: '100',
        side: 'buy',
        parentCap: '100',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(manualFillStore.get('child-1')).toBeNull();
    expect(parentStore.get('parent-none')?.residual ?? null).toBeNull();
  });

  it('missing confirmer refuses — never invents a user', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const manualFillStore = new InMemoryManualFillStore();
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_confirmer' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: '   ',
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_confirmer' });
    expect(manualFillStore.get('child-1')).toBeNull();
  });

  it('missing qty/price refuses — never invents a print from residual', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const manualFillStore = new InMemoryManualFillStore();
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        price: '100',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        amount: '   ',
        price: '100',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        amount: '0',
        price: '100',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        amount: 'not-a-qty',
        price: '100',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        amount: '0.5',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        amount: '0.5',
        price: '0',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        amount: '0.5',
        price: 'bad',
        confirmerId: OP,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_price' });
    expect(manualFillStore.get('child-1')).toBeNull();
  });

  it('double-record refuses — trail is irreversible', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    const manualFillStore = new InMemoryManualFillStore();
    const first = recordManualChildFill({
      parentClientOrderId: 'parent-twap',
      confirmerId: OP,
      parentStore,
      manualFillStore,
      now: new Date('2026-08-25T12:00:00.000Z'),
      ...print,
    });
    expect(first).toMatchObject({ ok: true, confirmerId: OP, fill: { filledAmount: '0.5', averagePrice: '100' } });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        clientOrderId: 'child-1',
        amount: '9',
        price: '100',
        side: 'buy',
        parentCap: '100',
        confirmerId: OTHER,
        parentStore,
        manualFillStore,
      }),
    ).toMatchObject({ ok: false, reason: 'already_recorded' });
    expect(manualFillStore.get('child-1')).toMatchObject({
      confirmerId: OP,
      filledAmount: '0.5',
      averagePrice: '100',
    });
  });

  it('record returning null leaves the parent residual unchanged and no fill on the trail', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap', residual: { remaining: '10.00' } }));
    const manualFillStore: ManualFillStore = {
      get: () => null,
      record: () => null,
    };
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'already_recorded' });
    expect(manualFillStore.get('child-1')).toBeNull();
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('10.00');
  });

  it('record throwing leaves the parent residual unchanged and no fill on the trail', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap', residual: { remaining: '10.00' } }));
    const manualFillStore: ManualFillStore = {
      get: () => null,
      record: () => {
        throw new Error('trail append failed');
      },
    };
    expect(() =>
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toThrow(/trail append failed/);
    expect(manualFillStore.get('child-1')).toBeNull();
    expect(parentStore.get('parent-twap')?.residual?.remaining).toBe('10.00');
  });

  it('paper / not-live / missing parent / missing child refuse', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-paper', kind: 'twap', status: 'paper' }));
    parentStore.seed(live({ parentClientOrderId: 'parent-stop', kind: 'twap', status: 'stopped' }));
    const manualFillStore = new InMemoryManualFillStore();
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-paper',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'paper' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-stop',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      recordManualChildFill({
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'missing',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        manualFillStore,
        amount: '0.5',
        price: '100',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_child' });
  });

  it('unwired stores refuse', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'parent-twap', kind: 'twap' }));
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        ...print,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'parent_store_unwired',
    });
    expect(
      recordManualChildFill({
        parentClientOrderId: 'parent-twap',
        confirmerId: OP,
        parentStore,
        ...print,
      }),
    ).toMatchObject({ ok: false, reason: 'fill_store_unwired' });
  });
});

describe('execution.oms.manualFill tRPC', () => {
  it('door exists (admin:write) and refuses anonymous record', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const caller = router.createCaller(hmacSigned());
    expect(typeof caller.execution.oms.manualFill).toBe('function');
    const out = await caller.execution.oms.manualFill({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'child-1',
      amount: '0.5',
      price: '100',
      side: 'buy',
      parentCap: '100',
    });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.manualFill({
        parentClientOrderId: 'parent-1',
        clientOrderId: 'child-1',
        amount: '0.5',
        price: '100',
        side: 'buy',
        parentCap: '100',
      }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('records a manual child fill through the injected parent store; already confirmed', async () => {
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
      undefined,
      undefined,
      undefined,
      parentStore,
    ).createCaller(hmacSigned());

    const recorded = await caller.execution.oms.manualFill({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'child-1',
      amount: '0.50',
      price: '100.00',
      side: 'buy',
      parentCap: '100',
    });
    expect(recorded).toMatchObject({
      ok: true,
      recorded: true,
      confirmed: true,
      clientAccepted: true,
      confirmerId: OP,
      parent: { parentClientOrderId: 'parent-1', kind: 'twap' },
      fill: { filledAmount: '0.5', averagePrice: '100' },
    });

    expect(
      await caller.execution.oms.manualFill({
        parentClientOrderId: 'parent-1',
        clientOrderId: 'child-1',
        amount: '9',
        price: '100',
        side: 'buy',
        parentCap: '100',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'already_recorded',
    });
  });

  it('body confirmerId is ignored — signed principal is the confirmer', async () => {
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
      undefined,
      undefined,
      undefined,
      parentStore,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.manualFill({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'child-1',
      amount: '0.5',
      price: '100',
      side: 'buy',
      parentCap: '100',
      confirmerId: OTHER,
    } as { parentClientOrderId: string; clientOrderId: string; amount: string; price: string; side: 'buy'; parentCap: string });
    expect(out).toMatchObject({ ok: true, recorded: true, confirmed: true, confirmerId: OP });
  });
});

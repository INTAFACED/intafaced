import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueOrder } from '@intafaced/venue-contracts';
import type { OmsCancelFn } from './oms-cancel.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { cancelRemainingParentChildren } from './oms-cancel-remaining.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-cancel-remaining-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
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

function hmacSigned(p: Principal = principal()) {
  return { ...signed(p), service: 'svc-execution' as const };
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
    parentClientOrderId: over.parentClientOrderId ?? 'parent-1',
    executionGroupId: over.executionGroupId ?? 'algo-1',
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

describe('cancelRemainingParentChildren', () => {
  it('cancels remaining children of one parent and reports residual', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingParentChildren({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: true, parent: { parentClientOrderId: 'parent-1' } });
    if (!result.ok) return;
    expect(result.children).toEqual([{ clientOrderId: 'child-1', venueId: 'street', outcome: 'stopped', status: 'canceled' }]);
    expect(result.residual).toEqual({ filled: '0', remaining: '1' });
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
  });

  it('does not cancel another parent', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store, { parentClientOrderId: 'parent-1' });
    seedAck(store, { clientOrderId: 'child-other', parentClientOrderId: 'parent-2' });
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingParentChildren({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children.map((c) => c.clientOrderId)).toEqual(['child-1']);
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
  });

  it('skips already_stopped children — no invented cancel', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store, { state: 'REJECTED' });
    const street = new FakeCancel(venueOrder());
    const result = await cancelRemainingParentChildren({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children[0]).toMatchObject({ outcome: 'already_stopped', reason: 'REJECTED' });
    expect(result.children[0]?.status).toBeUndefined();
    expect(street.calls).toHaveLength(0);
    expect(result.residual).toEqual({ filled: '0', remaining: null });
  });

  it('venue throw is unknown residual — never invents canceled', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(new Error('venue 503'));
    const result = await cancelRemainingParentChildren({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children[0]).toMatchObject({ outcome: 'unknown', reason: 'cancel_failed' });
    expect(result.residual).toEqual({ filled: '0', remaining: null });
    expect(result.children.some((c) => c.status === 'canceled')).toBe(false);
  });

  it('refuses a group or a missing parent', async () => {
    const store = new InMemoryEmsOrderStore();
    expect(await cancelRemainingParentChildren({ emsStore: store })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(
      await cancelRemainingParentChildren({
        parentClientOrderId: 'parent-1',
        executionGroupId: 'algo-1',
        emsStore: store,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_only' });
  });

  it('missing EMS store is refused', async () => {
    expect(await cancelRemainingParentChildren({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'ems_store_unwired',
    });
  });
});

describe('execution.oms.cancelRemaining tRPC', () => {
  it('refuses anonymous cancelRemaining', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.cancelRemaining({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('cancels remaining through the injected map and reports residual', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
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
      store,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.cancelRemaining({ parentClientOrderId: 'parent-1' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parent).toEqual({ parentClientOrderId: 'parent-1' });
    expect(out.children[0]?.outcome).toBe('stopped');
    expect(out.residual.remaining).toBe('1');
    expect(street.calls).toHaveLength(1);
  });
});

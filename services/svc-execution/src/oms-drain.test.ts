import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import type { VenueOrder } from '@intafaced/venue-contracts';
import type { OmsCancelFn } from './oms-cancel.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { drainInFlightAlgo } from './oms-drain.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-drain-test-edge-secret';
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

function storedExecution(
  filled: string,
  status: VenueExecution['status'] = 'partial',
  venueId = 'street',
): VenueExecution {
  return {
    venueId,
    venueOrderId: 'v-stored',
    filledAmount: parseAmount(filled),
    averagePrice: parseAmount('100'),
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status,
    executedAt: now,
  };
}

function seedAck(
  store: InMemoryEmsOrderStore,
  over: {
    clientOrderId?: string;
    parentClientOrderId?: string;
    executionGroupId?: string;
    venueId?: string;
    state?: 'ACKNOWLEDGED' | 'REJECTED' | 'UNWIRED' | 'SUBMIT_UNKNOWN' | 'OUTCOME_UNKNOWN' | 'CANCELED';
    execution?: VenueExecution | null;
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
    execution: over.execution === undefined ? null : over.execution,
    state: over.state ?? 'ACKNOWLEDGED',
    reconciliationKey: null,
  });
}

describe('drainInFlightAlgo', () => {
  it('drains by parent — child stops and residual remaining is reported', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    const result = await drainInFlightAlgo({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toMatchObject({ ok: true, algo: { parentClientOrderId: 'parent-1' } });
    if (!result.ok) return;
    expect(result.children).toEqual([{ clientOrderId: 'child-1', venueId: 'street', outcome: 'stopped', status: 'canceled' }]);
    expect(result.residual).toEqual({ filled: '0', remaining: '1' });
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
  });

  it('drains by execution group — does not cancel another algo', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store, { executionGroupId: 'algo-1' });
    seedAck(store, { clientOrderId: 'child-other', parentClientOrderId: 'parent-2', executionGroupId: 'algo-2' });
    const street = new FakeCancel(venueOrder());
    const result = await drainInFlightAlgo({
      executionGroupId: 'algo-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children.map((c) => c.clientOrderId)).toEqual(['child-1']);
    expect(street.calls).toHaveLength(1);
    expect(result.residual).toEqual({ filled: '0', remaining: '1' });
  });

  it('refuses both or neither algo identity', async () => {
    const store = new InMemoryEmsOrderStore();
    expect(await drainInFlightAlgo({ emsStore: store })).toMatchObject({ ok: false, reason: 'missing_algo' });
    expect(await drainInFlightAlgo({ parentClientOrderId: 'p', executionGroupId: 'g', emsStore: store })).toMatchObject({
      ok: false,
      reason: 'ambiguous_algo',
    });
  });

  it('venue throw is unknown residual — never invents canceled', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(new Error('venue 503'));
    const result = await drainInFlightAlgo({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children[0]).toMatchObject({ outcome: 'unknown', reason: 'cancel_failed' });
    expect(result.residual).toEqual({ filled: '0', remaining: null });
    expect(result.children[0] && result.children[0].status === 'canceled').toBe(false);
  });

  it('filled race reports residual remaining 0 — not rewritten to canceled', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(
      venueOrder({ status: 'filled', filled: parseAmount('1'), remaining: ZERO, averagePrice: parseAmount('100') }),
    );
    const result = await drainInFlightAlgo({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children[0]).toMatchObject({ outcome: 'stopped', status: 'filled' });
    expect(result.residual).toEqual({ filled: '1', remaining: '0' });
  });

  it('does not invent a new child — cancel is the only venue call', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(venueOrder());
    await drainInFlightAlgo({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(street.calls).toEqual([{ symbol: 'BTC/USDT', clientOrderId: 'child-1' }]);
    expect(store.list({ parentClientOrderId: 'parent-1' })).toHaveLength(1);
  });

  it('empty algo is an honest empty drain', async () => {
    const store = new InMemoryEmsOrderStore();
    const street = new FakeCancel(venueOrder());
    const result = await drainInFlightAlgo({
      parentClientOrderId: 'parent-none',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result).toEqual({
      ok: true,
      algo: { parentClientOrderId: 'parent-none' },
      children: [],
      residual: { filled: '0', remaining: '0' },
    });
    expect(street.calls).toHaveLength(0);
  });

  it('missing EMS store is refused', async () => {
    expect(await drainInFlightAlgo({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'ems_store_unwired',
    });
  });

  it('counts stored fills on a later drain of rows that already stopped', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store, { clientOrderId: 'child-canceled', state: 'CANCELED', execution: storedExecution('0.4') });
    seedAck(store, {
      clientOrderId: 'child-rejected',
      state: 'REJECTED',
      execution: storedExecution('0.15', 'rejected'),
    });
    seedAck(store, { clientOrderId: 'child-unwired', state: 'UNWIRED', execution: storedExecution('0.25') });
    seedAck(store, { clientOrderId: 'child-empty', state: 'CANCELED' });
    const street = new FakeCancel(venueOrder());
    const result = await drainInFlightAlgo({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children.every((child) => child.outcome === 'already_stopped')).toBe(true);
    expect(result.residual).toEqual({ filled: '0.8', remaining: '0' });
    expect(street.calls).toHaveLength(0);
  });

  it('counts a lone partial fill and keeps the venue remaining', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store);
    const street = new FakeCancel(
      venueOrder({
        status: 'partially_filled',
        filled: parseAmount('0.4'),
        remaining: parseAmount('0.6'),
        averagePrice: parseAmount('100'),
      }),
    );
    const result = await drainInFlightAlgo({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children[0]).toMatchObject({ outcome: 'stopped', status: 'partially_filled' });
    expect(result.residual).toEqual({ filled: '0.4', remaining: '0.6' });
  });

  it('keeps a known fill when another child is unknown', async () => {
    const store = new InMemoryEmsOrderStore();
    seedAck(store, { clientOrderId: 'child-canceled', state: 'CANCELED', execution: storedExecution('0.25') });
    seedAck(store, { clientOrderId: 'child-partial' });
    seedAck(store, { clientOrderId: 'child-down', venueId: 'down' });
    const street = new FakeCancel(
      venueOrder({
        clientOrderId: 'child-partial',
        status: 'partially_filled',
        filled: parseAmount('0.4'),
        remaining: parseAmount('0.6'),
        averagePrice: parseAmount('100'),
      }),
    );
    const down = new FakeCancel(new Error('venue 503'), 'down');
    const result = await drainInFlightAlgo({
      parentClientOrderId: 'parent-1',
      cancelByVenue: { street: street.fn, down: down.fn },
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children.map((child) => child.outcome)).toEqual(['already_stopped', 'stopped', 'unknown']);
    expect(result.residual).toEqual({ filled: '0.65', remaining: null });
  });
});

describe('execution.oms.drain tRPC', () => {
  it('refuses anonymous drain', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.drain({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('drains through the injected map', async () => {
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
    const out = await caller.execution.oms.drain({ parentClientOrderId: 'parent-1' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.children[0]?.outcome).toBe('stopped');
    expect(out.residual.remaining).toBe('1');
  });
});

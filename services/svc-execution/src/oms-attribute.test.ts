import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { attributeChildFillsToParent } from './oms-attribute.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-attribute-test-edge-secret';
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

function execution(over: Partial<VenueExecution> = {}): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: 'v-1',
    filledAmount: parseAmount('1'),
    averagePrice: parseAmount('100'),
    feeAmount: ZERO,
    feeAsset: 'USDT',
    status: 'filled',
    executedAt: new Date('2026-08-25T00:00:00.000Z'),
    ...over,
  };
}

function seed(
  store: InMemoryEmsOrderStore,
  over: {
    clientOrderId?: string;
    parentClientOrderId?: string;
    venueId?: string;
    state?: 'ACKNOWLEDGED' | 'REJECTED' | 'UNWIRED' | 'SUBMIT_UNKNOWN' | 'OUTCOME_UNKNOWN';
    execution?: VenueExecution | null;
  } = {},
) {
  store.record({
    clientOrderId: over.clientOrderId ?? 'child-1',
    parentClientOrderId: over.parentClientOrderId ?? 'parent-1',
    executionGroupId: 'algo-1',
    childOrderId: over.clientOrderId ?? 'child-1',
    legIndex: 0,
    venueId: over.venueId ?? 'street',
    symbol: 'BTC/USDT',
    side: 'buy',
    execution: over.execution === undefined ? execution() : over.execution,
    state: over.state ?? 'ACKNOWLEDGED',
    reconciliationKey: null,
  });
}

describe('attributeChildFillsToParent', () => {
  it('attributes confirmed child fills and updates parent residual', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { clientOrderId: 'child-1', execution: execution({ filledAmount: parseAmount('1'), venueOrderId: 'v-1' }) });
    seed(store, { clientOrderId: 'child-2', execution: execution({ filledAmount: parseAmount('2'), venueOrderId: 'v-2' }) });
    const result = attributeChildFillsToParent({ parentClientOrderId: 'parent-1', emsStore: store });
    expect(result).toMatchObject({ ok: true, parent: { parentClientOrderId: 'parent-1' } });
    if (!result.ok) return;
    expect(result.children.map((c) => c.clientOrderId)).toEqual(['child-1', 'child-2']);
    expect(result.children.every((c) => c.outcome === 'attributed')).toBe(true);
    expect(result.residual).toEqual({ filled: '3', remaining: null });
  });

  it('does not attribute another parent', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { parentClientOrderId: 'parent-1', execution: execution({ filledAmount: parseAmount('1') }) });
    seed(store, {
      clientOrderId: 'child-other',
      parentClientOrderId: 'parent-2',
      execution: execution({ filledAmount: parseAmount('9'), venueOrderId: 'v-other' }),
    });
    const result = attributeChildFillsToParent({ parentClientOrderId: 'parent-1', emsStore: store });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children.map((c) => c.clientOrderId)).toEqual(['child-1']);
    expect(result.residual).toEqual({ filled: '1', remaining: null });
  });

  it('unknown child keeps remaining unknown — no invented fill', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { execution: execution({ filledAmount: parseAmount('1') }) });
    seed(store, { clientOrderId: 'child-unknown', state: 'SUBMIT_UNKNOWN', execution: null });
    const result = attributeChildFillsToParent({ parentClientOrderId: 'parent-1', emsStore: store });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children.find((c) => c.clientOrderId === 'child-unknown')).toMatchObject({
      outcome: 'unknown',
      reason: 'SUBMIT_UNKNOWN',
    });
    expect(result.residual).toEqual({ filled: '1', remaining: null });
    expect(result.children.some((c) => c.filled === '9')).toBe(false);
  });

  it('partial fill attributes the observed amount — remaining stays unknown', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { execution: execution({ filledAmount: parseAmount('0.4'), status: 'partial' }) });
    const result = attributeChildFillsToParent({ parentClientOrderId: 'parent-1', emsStore: store });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children[0]).toMatchObject({ outcome: 'attributed', filled: '0.4', status: 'partial' });
    expect(result.residual).toEqual({ filled: '0.4', remaining: null });
  });

  it('rejected child with no execution is not a zero leftover', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { state: 'REJECTED', execution: null });
    const result = attributeChildFillsToParent({ parentClientOrderId: 'parent-1', emsStore: store });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.children[0]).toMatchObject({ outcome: 'already_stopped', reason: 'REJECTED' });
    expect(result.children[0]?.filled).toBeUndefined();
    expect(result.residual).toEqual({ filled: '0', remaining: null });
  });

  it('refuses a group, a missing parent, or an empty journal', () => {
    const store = new InMemoryEmsOrderStore();
    expect(attributeChildFillsToParent({ emsStore: store })).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(attributeChildFillsToParent({ parentClientOrderId: 'parent-1', executionGroupId: 'algo-1', emsStore: store })).toMatchObject({
      ok: false,
      reason: 'parent_only',
    });
    expect(attributeChildFillsToParent({ parentClientOrderId: 'parent-none', emsStore: store })).toMatchObject({
      ok: false,
      reason: 'no_ems_evidence',
    });
  });

  it('missing EMS store is refused', () => {
    expect(attributeChildFillsToParent({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'ems_store_unwired',
    });
  });
});

describe('execution.oms.attribute tRPC', () => {
  it('refuses anonymous attribute', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(router.createCaller(anon).execution.oms.attribute({ parentClientOrderId: 'parent-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('attributes through the injected store and updates residual', async () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { execution: execution({ filledAmount: parseAmount('1') }) });
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
      store,
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.attribute({ parentClientOrderId: 'parent-1' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parent).toEqual({ parentClientOrderId: 'parent-1' });
    expect(out.children[0]?.outcome).toBe('attributed');
    expect(out.residual).toEqual({ filled: '1', remaining: null });
  });
});

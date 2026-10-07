import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { commandOutcome } from './oms-execute.js';
import { repairFailedHedgeChild } from './oms-repair-hedge.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-oms-repair-hedge-test-edge-secret';
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
    clientOrderId: over.clientOrderId ?? 'hedge-1',
    parentClientOrderId: over.parentClientOrderId ?? 'parent-1',
    executionGroupId: 'mm-1',
    childOrderId: over.clientOrderId ?? 'hedge-1',
    legIndex: 0,
    venueId: over.venueId ?? 'street',
    symbol: 'BTC/USDT',
    side: 'sell',
    execution: over.execution === undefined ? execution() : over.execution,
    state: over.state ?? 'ACKNOWLEDGED',
    reconciliationKey: null,
  });
}

describe('repairFailedHedgeChild', () => {
  it('repairs a REJECTED hedge child and leaves residual on the parent', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, {
      clientOrderId: 'filled-1',
      execution: execution({ filledAmount: parseAmount('2'), venueOrderId: 'v-fill' }),
    });
    seed(store, { clientOrderId: 'hedge-fail', state: 'REJECTED', execution: null });
    const result = repairFailedHedgeChild({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'hedge-fail',
      emsStore: store,
    });
    expect(result).toEqual({
      ok: true,
      repaired: true,
      parent: { parentClientOrderId: 'parent-1' },
      child: { clientOrderId: 'hedge-fail', venueId: 'street', outcome: 'repaired', reason: 'REJECTED' },
      residual: { filled: '2', remaining: null },
    });
  });

  it('counts a fill on a stopped child and does not invent a zero leftover', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, {
      clientOrderId: 'filled-live',
      execution: execution({ filledAmount: parseAmount('3'), venueOrderId: 'v-live' }),
    });
    seed(store, {
      clientOrderId: 'hedge-rejected',
      state: 'REJECTED',
      execution: execution({ filledAmount: parseAmount('1.5'), venueOrderId: 'v-rej' }),
    });
    seed(store, {
      clientOrderId: 'hedge-unwired',
      state: 'UNWIRED',
      execution: execution({ filledAmount: parseAmount('2'), venueOrderId: 'v-unw' }),
    });
    seed(store, {
      clientOrderId: 'hedge-status-rejected',
      execution: execution({ filledAmount: parseAmount('0.25'), status: 'rejected', venueOrderId: 'v-st' }),
    });
    const result = repairFailedHedgeChild({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'hedge-rejected',
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.residual).toEqual({ filled: '6.75', remaining: null });
  });

  it('counts a partial fill and leaves remaining null', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, {
      clientOrderId: 'hedge-rejected',
      state: 'REJECTED',
      execution: execution({ filledAmount: parseAmount('0.5'), venueOrderId: 'v-rej' }),
    });
    seed(store, {
      clientOrderId: 'child-partial',
      execution: execution({ filledAmount: parseAmount('1.25'), status: 'partial', venueOrderId: 'v-part' }),
    });
    const result = repairFailedHedgeChild({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'hedge-rejected',
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.residual).toEqual({ filled: '1.75', remaining: null });
  });

  it('repairs a listed REFUSED commandOutcome child', () => {
    const store = new InMemoryEmsOrderStore();
    store.record({
      clientOrderId: 'hedge-refused',
      parentClientOrderId: 'parent-1',
      executionGroupId: 'mm-1',
      childOrderId: 'hedge-refused',
      legIndex: 0,
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'sell',
      execution: null,
      state: 'ACKNOWLEDGED',
      commandOutcome: commandOutcome('hedge-refused', 'REFUSED', 'venue.rejected', null),
      reconciliationKey: null,
    });
    expect(
      repairFailedHedgeChild({
        parentClientOrderId: 'parent-1',
        clientOrderId: 'hedge-refused',
        emsStore: store,
      }),
    ).toMatchObject({
      ok: true,
      repaired: true,
      child: { clientOrderId: 'hedge-refused', venueId: 'street', reason: 'REFUSED' },
    });
  });

  it('does not invent a hedge when the child is not failed', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { clientOrderId: 'hedge-live' });
    expect(
      repairFailedHedgeChild({
        parentClientOrderId: 'parent-1',
        clientOrderId: 'hedge-live',
        emsStore: store,
      }),
    ).toMatchObject({ ok: false, reason: 'not_failed' });
  });

  it("refuses another parent's child", () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { clientOrderId: 'hedge-fail', parentClientOrderId: 'parent-2', state: 'REJECTED', execution: null });
    expect(
      repairFailedHedgeChild({
        parentClientOrderId: 'parent-1',
        clientOrderId: 'hedge-fail',
        emsStore: store,
      }),
    ).toMatchObject({ ok: false, reason: 'not_parent_child' });
  });

  it('unknown sibling keeps remaining on the parent — no invented hedge', () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { clientOrderId: 'filled-1', execution: execution({ filledAmount: parseAmount('1') }) });
    seed(store, { clientOrderId: 'hedge-fail', state: 'UNWIRED', execution: null });
    seed(store, { clientOrderId: 'child-unknown', state: 'SUBMIT_UNKNOWN', execution: null });
    const result = repairFailedHedgeChild({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'hedge-fail',
      emsStore: store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.residual).toEqual({ filled: '1', remaining: null });
  });

  it('refuses a group, missing ids, empty journal, or unwired store', () => {
    const store = new InMemoryEmsOrderStore();
    expect(repairFailedHedgeChild({ emsStore: store })).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(repairFailedHedgeChild({ parentClientOrderId: 'parent-1', emsStore: store })).toMatchObject({
      ok: false,
      reason: 'missing_child',
    });
    expect(
      repairFailedHedgeChild({
        parentClientOrderId: 'parent-1',
        clientOrderId: 'hedge-1',
        executionGroupId: 'mm-1',
        emsStore: store,
      }),
    ).toMatchObject({ ok: false, reason: 'parent_only' });
    expect(repairFailedHedgeChild({ parentClientOrderId: 'parent-1', clientOrderId: 'hedge-missing', emsStore: store })).toMatchObject({
      ok: false,
      reason: 'no_ems_evidence',
    });
    expect(repairFailedHedgeChild({ parentClientOrderId: 'parent-1', clientOrderId: 'hedge-1' })).toMatchObject({
      ok: false,
      reason: 'ems_store_unwired',
    });
  });
});

describe('execution.oms.repairHedge tRPC', () => {
  it('refuses anonymous repair', async () => {
    const router = createExecutionRouter(new SealedHouseTenantRegistry());
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    await expect(
      router.createCaller(anon).execution.oms.repairHedge({
        parentClientOrderId: 'parent-1',
        clientOrderId: 'hedge-1',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('repairs a failed hedge child through the injected store', async () => {
    const store = new InMemoryEmsOrderStore();
    seed(store, { clientOrderId: 'hedge-fail', state: 'REJECTED', execution: null });
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
    const out = await caller.execution.oms.repairHedge({
      parentClientOrderId: 'parent-1',
      clientOrderId: 'hedge-fail',
    });
    expect(out).toMatchObject({
      ok: true,
      repaired: true,
      parent: { parentClientOrderId: 'parent-1' },
      child: { clientOrderId: 'hedge-fail', outcome: 'repaired' },
      residual: { filled: '0', remaining: null },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { CaptureLake } from '@intafaced/venue-adapter';
import type { VenueBookSnapshot } from '@intafaced/venue-contracts';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { runTcaForParent } from './oms-tca-parent.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-tca-parent-test-edge-secret';
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

const FILL_AT = new Date('2026-08-24T12:00:00.000Z');

function recordFill(store: InMemoryEmsOrderStore, parent = 'parent-1') {
  store.record({
    clientOrderId: 'child-1',
    parentClientOrderId: parent,
    executionGroupId: 'group-1',
    childOrderId: 'child-1',
    venueId: 'street',
    symbol: 'BTC/USDT',
    side: 'buy',
    execution: {
      venueId: 'street',
      venueOrderId: 'v-1',
      filledAmount: parseAmount('1'),
      averagePrice: parseAmount('101'),
      feeAmount: parseAmount('0.1'),
      feeAsset: 'USDT',
      status: 'filled',
      executedAt: FILL_AT,
    },
    state: 'ACKNOWLEDGED',
    recordedAtMs: 1,
  });
}

function retainedBook(now = FILL_AT): CaptureLake {
  const lake = new CaptureLake({ now: () => now });
  const snapshot: VenueBookSnapshot = {
    venueId: 'street',
    symbol: 'BTC/USDT',
    sequence: 9,
    sequenced: true,
    observedAt: now,
    bids: [[parseAmount('100'), parseAmount('2')]],
    asks: [[parseAmount('102'), parseAmount('2')]],
  };
  lake.recordBook(snapshot);
  return lake;
}

describe('runTcaForParent', () => {
  it('runs TCA for one parent from retained EMS fills and a bound capture book', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
    const result = runTcaForParent({
      parentClientOrderId: 'parent-1',
      emsStore,
      captureLake: retainedBook(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.parentClientOrderId).toBe('parent-1');
    expect(result.run.realized).toMatchObject({ status: 'AVAILABLE', fillVwap: '101' });
    expect(result.run.benchmarks.find((row) => row.class === 'arrival')).toMatchObject({
      status: 'AVAILABLE',
      price: '101',
      source: 'capture.lake',
    });
    expect(result.run.slippage.find((row) => row.versus === 'arrival')).toMatchObject({
      status: 'AVAILABLE',
      fillVwap: '101',
      benchmark: '101',
      slippage: '0',
    });
  });

  it('does not treat fill VWAP as an invented arrival when capture is missing', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
    expect(runTcaForParent({ parentClientOrderId: 'parent-1', emsStore })).toMatchObject({
      ok: false,
      reason: 'missing_retained_inputs',
    });
  });

  it('refuses when the parent has no EMS rows', () => {
    expect(
      runTcaForParent({
        parentClientOrderId: 'ghost',
        emsStore: new InMemoryEmsOrderStore(),
        captureLake: retainedBook(),
      }),
    ).toMatchObject({ ok: false, reason: 'no_ems_evidence' });
  });

  it('refuses a missing parent id and an unwired store', () => {
    expect(runTcaForParent({ emsStore: new InMemoryEmsOrderStore() })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(runTcaForParent({ parentClientOrderId: 'parent-1' })).toMatchObject({
      ok: false,
      reason: 'ems_store_unwired',
    });
  });

  it('isolates one parent — a sibling parent is not scored', () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore, 'parent-1');
    emsStore.record({
      clientOrderId: 'child-other',
      parentClientOrderId: 'parent-other',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: {
        venueId: 'street',
        venueOrderId: 'v-2',
        filledAmount: parseAmount('9'),
        averagePrice: parseAmount('200'),
        feeAmount: parseAmount('1'),
        feeAsset: 'USDT',
        status: 'filled',
        executedAt: FILL_AT,
      },
      state: 'ACKNOWLEDGED',
      recordedAtMs: 2,
    });
    const result = runTcaForParent({
      parentClientOrderId: 'parent-1',
      emsStore,
      captureLake: retainedBook(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.clientOrderIds).toEqual(['child-1']);
    expect(result.run.realized).toMatchObject({ fillVwap: '101' });
  });

  it('drops an invalid executedAt and keeps the earliest valid stamp as the retained clock', () => {
    const emsStore = new InMemoryEmsOrderStore();
    const earlier = new Date('2026-08-24T11:00:00.000Z');
    const later = new Date('2026-08-24T13:00:00.000Z');
    emsStore.record({
      clientOrderId: 'child-invalid',
      parentClientOrderId: 'parent-1',
      executionGroupId: 'group-1',
      childOrderId: 'child-invalid',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: {
        venueId: 'street',
        venueOrderId: 'v-invalid',
        filledAmount: parseAmount('1'),
        averagePrice: parseAmount('101'),
        feeAmount: parseAmount('0.1'),
        feeAsset: 'USDT',
        status: 'filled',
        executedAt: new Date('not-a-clock'),
      },
      state: 'ACKNOWLEDGED',
      recordedAtMs: 3,
    });
    emsStore.record({
      clientOrderId: 'child-later',
      parentClientOrderId: 'parent-1',
      executionGroupId: 'group-1',
      childOrderId: 'child-later',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: {
        venueId: 'street',
        venueOrderId: 'v-later',
        filledAmount: parseAmount('1'),
        averagePrice: parseAmount('101'),
        feeAmount: parseAmount('0.1'),
        feeAsset: 'USDT',
        status: 'filled',
        executedAt: later,
      },
      state: 'ACKNOWLEDGED',
      recordedAtMs: 4,
    });
    emsStore.record({
      clientOrderId: 'child-earlier',
      parentClientOrderId: 'parent-1',
      executionGroupId: 'group-1',
      childOrderId: 'child-earlier',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: {
        venueId: 'street',
        venueOrderId: 'v-earlier',
        filledAmount: parseAmount('1'),
        averagePrice: parseAmount('101'),
        feeAmount: parseAmount('0.1'),
        feeAsset: 'USDT',
        status: 'filled',
        executedAt: earlier,
      },
      state: 'ACKNOWLEDGED',
      recordedAtMs: 5,
    });
    const result = runTcaForParent({
      parentClientOrderId: 'parent-1',
      emsStore,
      captureLake: retainedBook(earlier),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.arrivalAt).toBe('2026-08-24T11:00:00.000Z');
    expect(result.run.benchmarks.find((row) => row.class === 'arrival')).toMatchObject({
      status: 'AVAILABLE',
      source: 'capture.lake',
    });
  });

  it('refuses when every retained execution clock is missing or invalid', () => {
    const emsStore = new InMemoryEmsOrderStore();
    emsStore.record({
      clientOrderId: 'child-blank',
      parentClientOrderId: 'parent-1',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: null,
      state: 'OUTCOME_UNKNOWN',
      recordedAtMs: 1,
    });
    emsStore.record({
      clientOrderId: 'child-invalid',
      parentClientOrderId: 'parent-1',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: {
        venueId: 'street',
        venueOrderId: 'v-invalid',
        filledAmount: parseAmount('1'),
        averagePrice: parseAmount('101'),
        feeAmount: parseAmount('0.1'),
        feeAsset: 'USDT',
        status: 'filled',
        executedAt: new Date('not-a-clock'),
      },
      state: 'ACKNOWLEDGED',
      recordedAtMs: 2,
    });
    expect(
      runTcaForParent({
        parentClientOrderId: 'parent-1',
        emsStore,
        captureLake: retainedBook(),
      }),
    ).toMatchObject({
      ok: false,
      reason: 'missing_retained_inputs',
    });
  });
});

describe('execution.oms.tca.parent tRPC', () => {
  it('reads one parent and does not accept caller observations', async () => {
    const emsStore = new InMemoryEmsOrderStore();
    recordFill(emsStore);
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
      retainedBook(),
    ).createCaller(hmacSigned());
    const out = await caller.execution.oms.tca.parent({ parentClientOrderId: 'parent-1' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.run.realized).toMatchObject({ status: 'AVAILABLE', fillVwap: '101' });
    expect(out.run.benchmarks.find((row) => row.class === 'arrival')).toMatchObject({
      status: 'AVAILABLE',
      source: 'capture.lake',
    });
  });
});

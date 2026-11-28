/**
 * Unit card — execution.oms.unattended / orphaned refuse unpublished page size (never invent 50)
 *
 * 1. Promise: omit / NaN / 0 throws named unset. Owner-explicit 50 still pages.
 *    Zod still caps 1..200 (same window as ems.list).
 * 2. Break: unattended/orphaned with no page size dumps the store.
 * 3. Done bar: unset throws named *ListLimitUnsetError; 50 is allowed
 * 4. Class N
 * 5. Paths: services/svc-execution/src/ems-list-limit.ts, router.ts
 *
 * Store.list remains the kill / TCA / /ready work set — not recut here.
 * failedHedges / unconfirmed stay parent-id filtered — not milled.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import {
  assertOrphanedListLimit,
  assertUnattendedListLimit,
  EMS_LIST_LIMIT_CAP,
  EXECUTION_ORPHANED_LIST_LIMIT_UNSET,
  EXECUTION_UNATTENDED_LIST_LIMIT_UNSET,
  OrphanedListLimitUnsetError,
  UnattendedListLimitUnsetError,
} from './ems-list-limit.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { InMemoryApprovedAlgoParentStore, type ApprovedAlgoParent, type RetainedAlgoSchedule } from './oms-start.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-exception-list-limit-test-edge-secret';
const OP = '33333333-3333-4333-8333-333333333333';
const ORIGINATOR = '55555555-5555-4555-8555-555555555555';
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

function hmacSigned(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return {
    ...edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-signed',
    }),
    service: 'svc-execution' as const,
  };
}

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function live(over: Partial<ApprovedAlgoParent> & Pick<ApprovedAlgoParent, 'parentClientOrderId' | 'kind'>): ApprovedAlgoParent {
  return {
    status: 'approved',
    startedAt: null,
    residual: { remaining: '10' },
    originator: ORIGINATOR,
    ...over,
    schedule: over.schedule ?? retainedTwap(),
  };
}

function ack(id: string): VenueExecution {
  return {
    venueId: 'street',
    venueOrderId: `v-${id}`,
    filledAmount: parseAmount('1'),
    averagePrice: parseAmount('100'),
    feeAmount: parseAmount('0'),
    feeAsset: 'USDT',
    status: 'filled',
    executedAt: new Date('2026-08-22T00:00:00.000Z'),
  };
}

/** The router as the desk calls it, with only the stores a list reads. */
function callerWith(stores: { emsStore?: InMemoryEmsOrderStore; parentStore?: InMemoryApprovedAlgoParentStore }) {
  return createExecutionRouter(
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
    stores.emsStore,
    undefined,
    undefined,
    stores.parentStore,
  ).createCaller(hmacSigned());
}

describe('assertUnattendedListLimit', () => {
  it('refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertUnattendedListLimit(undefined)).toThrow(UnattendedListLimitUnsetError);
    expect(() => assertUnattendedListLimit(null)).toThrow(UnattendedListLimitUnsetError);
    expect(() => assertUnattendedListLimit(Number.NaN)).toThrow(UnattendedListLimitUnsetError);
    expect(() => assertUnattendedListLimit(0)).toThrow(UnattendedListLimitUnsetError);
    try {
      assertUnattendedListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(UnattendedListLimitUnsetError);
      expect((e as UnattendedListLimitUnsetError).code).toBe(EXECUTION_UNATTENDED_LIST_LIMIT_UNSET);
      expect((e as UnattendedListLimitUnsetError).message).toMatch(/never invent 50/);
      expect((e as UnattendedListLimitUnsetError).message).not.toMatch(/default 50|50-row/i);
    }
  });

  it('owner-explicit 50 is allowed and caps at 200', () => {
    expect(assertUnattendedListLimit(50)).toBe(50);
    expect(assertUnattendedListLimit(1)).toBe(1);
    expect(assertUnattendedListLimit(EMS_LIST_LIMIT_CAP + 1)).toBe(EMS_LIST_LIMIT_CAP);
  });
});

describe('assertOrphanedListLimit', () => {
  it('refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertOrphanedListLimit(undefined)).toThrow(OrphanedListLimitUnsetError);
    expect(() => assertOrphanedListLimit(null)).toThrow(OrphanedListLimitUnsetError);
    expect(() => assertOrphanedListLimit(Number.NaN)).toThrow(OrphanedListLimitUnsetError);
    expect(() => assertOrphanedListLimit(0)).toThrow(OrphanedListLimitUnsetError);
    try {
      assertOrphanedListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(OrphanedListLimitUnsetError);
      expect((e as OrphanedListLimitUnsetError).code).toBe(EXECUTION_ORPHANED_LIST_LIMIT_UNSET);
      expect((e as OrphanedListLimitUnsetError).message).toMatch(/never invent 50/);
      expect((e as OrphanedListLimitUnsetError).message).not.toMatch(/default 50|50-row/i);
    }
  });

  it('owner-explicit 50 is allowed and caps at 200', () => {
    expect(assertOrphanedListLimit(50)).toBe(50);
    expect(assertOrphanedListLimit(1)).toBe(1);
    expect(assertOrphanedListLimit(EMS_LIST_LIMIT_CAP + 1)).toBe(EMS_LIST_LIMIT_CAP);
  });
});

describe('execution.oms.unattended limit unset refuse', () => {
  it('omit refuses with the named code, and a page over 200 is refused at the door', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'unowned-1', kind: 'twap' }));
    const caller = callerWith({ parentStore });
    await expect(caller.execution.oms.unattended({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: EXECUTION_UNATTENDED_LIST_LIMIT_UNSET },
    });
    await expect(caller.execution.oms.unattended({ limit: 201 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.execution.oms.unattended({ limit: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const max = await caller.execution.oms.unattended({ limit: 200 });
    expect(max).toMatchObject({ ok: true });
    if (!max.ok) return;
    expect(max.parents).toHaveLength(1);
  });

  it('omit / empty input refuses PRECONDITION_FAILED — never dumps both parents', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    parentStore.seed(live({ parentClientOrderId: 'unowned-1', kind: 'twap' }));
    parentStore.seed(live({ parentClientOrderId: 'unowned-2', kind: 'vwap' }));
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

    await expect(caller.execution.oms.unattended({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: /never invent 50/,
    });

    const page = await caller.execution.oms.unattended({ limit: 1 });
    expect(page).toMatchObject({ ok: true });
    if (!page.ok) return;
    expect(page.parents).toHaveLength(1);

    const explicit50 = await caller.execution.oms.unattended({ limit: 50 });
    expect(explicit50).toMatchObject({ ok: true });
    if (!explicit50.ok) return;
    expect(explicit50.parents).toHaveLength(2);
    expect(parentStore.list()).toHaveLength(2);

    const emptyStore = new InMemoryApprovedAlgoParentStore();
    const emptyCaller = createExecutionRouter(
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
      emptyStore,
    ).createCaller(hmacSigned());
    await expect(emptyCaller.execution.oms.unattended({ limit: 50 })).resolves.toEqual({ ok: true, parents: [] });
  });
});

describe('execution.oms.orphaned limit unset refuse', () => {
  it('omit refuses with the named code, and a page over 200 is refused at the door', async () => {
    const emsStore = new InMemoryEmsOrderStore();
    emsStore.record({ clientOrderId: 'orphan-1', venueId: 'street', symbol: 'BTC/USDT', side: 'buy', execution: ack('1') });
    const caller = callerWith({ emsStore, parentStore: new InMemoryApprovedAlgoParentStore() });
    await expect(caller.execution.oms.orphaned({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: EXECUTION_ORPHANED_LIST_LIMIT_UNSET },
    });
    await expect(caller.execution.oms.orphaned({ limit: 201 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.execution.oms.orphaned({ limit: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const max = await caller.execution.oms.orphaned({ limit: 200 });
    expect(max).toMatchObject({ ok: true });
    if (!max.ok) return;
    expect(max.fills).toHaveLength(1);
  });

  it('omit / empty input refuses PRECONDITION_FAILED — never dumps both fills', async () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const emsStore = new InMemoryEmsOrderStore();
    emsStore.record({
      clientOrderId: 'orphan-1',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: ack('1'),
    });
    emsStore.record({
      clientOrderId: 'orphan-2',
      venueId: 'street',
      symbol: 'ETH/USDT',
      side: 'sell',
      execution: ack('2'),
    });
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

    await expect(caller.execution.oms.orphaned({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: /never invent 50/,
    });

    const page = await caller.execution.oms.orphaned({ limit: 1 });
    expect(page).toMatchObject({ ok: true });
    if (!page.ok) return;
    expect(page.fills).toHaveLength(1);

    const explicit50 = await caller.execution.oms.orphaned({ limit: 50 });
    expect(explicit50).toMatchObject({ ok: true });
    if (!explicit50.ok) return;
    expect(explicit50.fills).toHaveLength(2);
    expect(emsStore.list()).toHaveLength(2);

    const emptyEms = new InMemoryEmsOrderStore();
    const emptyCaller = createExecutionRouter(
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
      emptyEms,
      undefined,
      undefined,
      parentStore,
    ).createCaller(hmacSigned());
    await expect(emptyCaller.execution.oms.orphaned({ limit: 50 })).resolves.toEqual({ ok: true, fills: [] });
  });
});

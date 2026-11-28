/**
 * Unit card — execution.oms.ems.list refuses unpublished page size (never invent 50)
 *
 * 1. Promise: omit / NaN / 0 throws execution.ems_list_limit_unset. Owner-explicit 50
 *    still pages. Zod still caps 1..200.
 * 2. Break: ems.list with no page size dumps the journal.
 * 3. Done bar: unset throws EmsListLimitUnsetError; 50 is allowed
 * 4. Class N
 * 5. Paths: services/svc-execution/src/ems-list-limit.ts, router.ts
 *
 * Store.list remains the kill / TCA work set — not recut here.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import type { VenueExecution } from '@intafaced/venue-adapter';
import { assertEmsListLimit, EMS_LIST_LIMIT_CAP, EmsListLimitUnsetError, EXECUTION_EMS_LIST_LIMIT_UNSET } from './ems-list-limit.js';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-ems-list-limit-test-edge-secret';
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

describe('assertEmsListLimit', () => {
  it('refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertEmsListLimit(undefined)).toThrow(EmsListLimitUnsetError);
    expect(() => assertEmsListLimit(null)).toThrow(EmsListLimitUnsetError);
    expect(() => assertEmsListLimit(Number.NaN)).toThrow(EmsListLimitUnsetError);
    expect(() => assertEmsListLimit(0)).toThrow(EmsListLimitUnsetError);
    try {
      assertEmsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(EmsListLimitUnsetError);
      expect((e as EmsListLimitUnsetError).code).toBe(EXECUTION_EMS_LIST_LIMIT_UNSET);
      expect((e as EmsListLimitUnsetError).message).toMatch(/never invent 50/);
      expect((e as EmsListLimitUnsetError).message).not.toMatch(/default 50|50-row/i);
    }
  });

  it('owner-explicit 50 is allowed and caps at 200', () => {
    expect(assertEmsListLimit(50)).toBe(50);
    expect(assertEmsListLimit(1)).toBe(1);
    expect(assertEmsListLimit(100)).toBe(100);
    expect(assertEmsListLimit(EMS_LIST_LIMIT_CAP)).toBe(EMS_LIST_LIMIT_CAP);
    expect(assertEmsListLimit(EMS_LIST_LIMIT_CAP + 1)).toBe(EMS_LIST_LIMIT_CAP);
  });
});

describe('execution.oms.ems.list limit unset refuse', () => {
  it('omit refuses with the named code, and a page over 200 is refused at the door', async () => {
    const emsStore = new InMemoryEmsOrderStore();
    emsStore.record({ clientOrderId: 'ems-1', venueId: 'street', symbol: 'BTC/USDT', side: 'buy', execution: ack('1') });
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
    ).createCaller(hmacSigned());

    await expect(caller.execution.oms.ems.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: EXECUTION_EMS_LIST_LIMIT_UNSET },
    });
    await expect(caller.execution.oms.ems.list({ limit: 201 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.execution.oms.ems.list({ limit: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.execution.oms.ems.list({ limit: 200 })).resolves.toHaveLength(1);
  });

  it('omit / empty input refuses PRECONDITION_FAILED — never dumps both acks', async () => {
    const emsStore = new InMemoryEmsOrderStore();
    emsStore.record({
      clientOrderId: 'ems-1',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      execution: ack('1'),
    });
    emsStore.record({
      clientOrderId: 'ems-2',
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
    ).createCaller(hmacSigned());

    await expect(caller.execution.oms.ems.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: /never invent 50/,
    });

    const page = await caller.execution.oms.ems.list({ limit: 1 });
    expect(page).toHaveLength(1);

    const explicit50 = await caller.execution.oms.ems.list({ limit: 50 });
    expect(explicit50).toHaveLength(2);
    expect(emsStore.list()).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type ActionApproval } from '@intafaced/contracts';
import type { VenueOrder } from '@intafaced/venue-contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { InMemoryEmsOrderStore } from './oms-ems-store.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-mount-test-edge-secret-long';
const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: true,
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

function approvals() {
  let calls = 0;
  return {
    calls: () => calls,
    async consume(input: {
      approvalId: string;
      operationId: string;
      payloadHash: string;
      targetService: string;
      targetId: string;
      expectedVersion: string;
    }): Promise<ActionApproval> {
      calls += 1;
      return {
        ...input,
        actionType: 'execution.halt',
        requesterId: OP,
        approverId: APPROVER,
        policyVersion: 'v1',
        createdAt: '2026-10-17T00:00:00.000Z',
        expiresAt: '2026-10-17T00:10:00.000Z',
        status: 'CONSUMED',
      };
    },
  };
}

function canceledOrder(): VenueOrder {
  const now = new Date('2026-10-17T00:00:00.000Z');
  const zero = parseAmount('0');
  return {
    venueId: 'street',
    venueOrderId: 'v-1',
    clientOrderId: 'child-1',
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    price: parseAmount('100'),
    amount: parseAmount('1'),
    filled: zero,
    remaining: parseAmount('1'),
    averagePrice: null,
    status: 'canceled',
    feePaid: zero,
    feeAsset: 'USDT',
    createdAt: now,
    observedAt: now,
  };
}

function routerWith(store: InMemoryEmsOrderStore | undefined, consumer = approvals()) {
  return {
    consumer,
    api: createExecutionRouter(
      new SealedHouseTenantRegistry(),
      {},
      { street: async () => canceledOrder() },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      consumer,
    ),
  };
}

describe('execution founder in-flight desk', () => {
  it('refuses an unwired journal instead of listing zero children', async () => {
    const { api } = routerWith(undefined);
    await expect(api.createCaller(await signed()).execution.ops.inFlight()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('execution.ems_store_unwired'),
    });
  });

  it('lists in-flight children and omits terminal ones', async () => {
    const store = new InMemoryEmsOrderStore();
    store.record({
      clientOrderId: 'child-1',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      state: 'ACKNOWLEDGED',
      account: 'acct-1',
      execution: null,
    });
    store.record({
      clientOrderId: 'child-2',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'sell',
      state: 'CANCELED',
      account: 'acct-1',
      execution: null,
    });
    const { api } = routerWith(store);
    const live = await api.createCaller(await signed()).execution.ops.inFlight();
    expect(live.children.map((row) => row.clientOrderId)).toEqual(['child-1']);
    const empty = new InMemoryEmsOrderStore();
    const none = await routerWith(empty)
      .api.createCaller(await signed())
      .execution.ops.inFlight();
    expect(none.children).toEqual([]);
  });

  it('refuses halt without admin:write, and admin:write without MFA', async () => {
    const store = new InMemoryEmsOrderStore();
    const { api, consumer } = routerWith(store);
    await expect(
      api.createCaller(await signed(principal({ scopes: ['admin:read'], mfa: true }))).execution.ops.halt({
        account: 'acct-1',
        approvalId: 'appr-1',
        operationId: 'op-1',
        idempotencyKey: 'halt-key-01',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.createCaller(await signed(principal({ mfa: false }))).execution.ops.halt({
        account: 'acct-1',
        approvalId: 'appr-1',
        operationId: 'op-1',
        idempotencyKey: 'halt-key-01',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: expect.stringContaining('mfa.required') });
    expect(consumer.calls()).toBe(0);
  });

  it('does not consume an approval when the journal is missing or the scope is ambiguous', async () => {
    const missing = routerWith(undefined);
    await expect(
      missing.api.createCaller(await signed()).execution.ops.halt({
        account: 'acct-1',
        approvalId: 'appr-1',
        operationId: 'op-1',
        idempotencyKey: 'halt-key-01',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('execution.ems_store_unwired') });
    expect(missing.consumer.calls()).toBe(0);

    const store = new InMemoryEmsOrderStore();
    const both = routerWith(store);
    await expect(
      both.api.createCaller(await signed()).execution.ops.halt({
        account: 'acct-1',
        session: 'sess-1',
        approvalId: 'appr-1',
        operationId: 'op-1',
        idempotencyKey: 'halt-key-01',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('execution.halt_scope') });
    expect(both.consumer.calls()).toBe(0);
  });

  it('halts one account and replays without a second consume', async () => {
    const store = new InMemoryEmsOrderStore();
    store.record({
      clientOrderId: 'child-1',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      state: 'ACKNOWLEDGED',
      account: 'acct-1',
      execution: null,
    });
    const { api, consumer } = routerWith(store);
    const caller = api.createCaller(await signed());
    const body = {
      account: 'acct-1',
      approvalId: 'appr-1',
      operationId: 'op-1',
      idempotencyKey: 'halt-key-01',
    };
    const halted = await caller.execution.ops.halt(body);
    expect(halted).toMatchObject({
      ok: true,
      approverId: APPROVER,
      children: [{ clientOrderId: 'child-1', outcome: 'stopped', status: 'canceled' }],
    });
    const replay = await caller.execution.ops.halt(body);
    expect(replay).toEqual(halted);
    expect(consumer.calls()).toBe(1);
    await expect(caller.execution.ops.halt({ ...body, account: 'acct-2' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(consumer.calls()).toBe(1);
  });

  it('refuses halt when identity is unwired and kills nothing', async () => {
    const store = new InMemoryEmsOrderStore();
    store.record({
      clientOrderId: 'child-1',
      venueId: 'street',
      symbol: 'BTC/USDT',
      side: 'buy',
      state: 'ACKNOWLEDGED',
      account: 'acct-1',
      execution: null,
    });
    const api = createExecutionRouter(
      new SealedHouseTenantRegistry(),
      {},
      { street: async () => canceledOrder() },
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
    );
    await expect(
      api.createCaller(await signed()).execution.ops.halt({
        account: 'acct-1',
        approvalId: 'appr-1',
        operationId: 'op-1',
        idempotencyKey: 'halt-key-01',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('action_approval.identity_unwired') });
    expect(store.get('child-1')?.state).toBe('ACKNOWLEDGED');
  });
});

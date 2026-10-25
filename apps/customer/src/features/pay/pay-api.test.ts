import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import type { JournalStorage, JournalLocks } from '../../shared/minimal-original-journal';
import { createPersonalPayApi, createBusinessPayApi, createPayMutationGuard, createCheckoutApi } from './pay-api';
import { z } from 'zod';
import { paymentSchema, subscriptionSchema } from './schemas';

const userId = '11111111-1111-4111-8111-111111111111';
const spaceId = '22222222-2222-4222-8222-222222222222';
const merchantId = '33333333-3333-4333-8333-333333333333';
const transferId = '44444444-4444-4444-8444-444444444444';
function response(data: unknown) {
  return new Response(JSON.stringify({ result: { data } }));
}

function nativeLockFixture(): JournalLocks {
  const held = new Set<string>();
  return {
    request: async (name: string, _options: unknown, work: (lock: unknown) => unknown) => {
      if (held.has(name)) return work(null);
      held.add(name);
      try {
        return await work({ name });
      } finally {
        held.delete(name);
      }
    },
  } as JournalLocks;
}
function createPersistentTestGuard(storage: JournalStorage) {
  const locks = nativeLockFixture();
  return createPayMutationGuard(storage, true, { durable: () => storage, locks: () => locks });
}

describe('Personal Pay network boundary', () => {
  it('sends exact asset units from the caller’s ledger space with one stable transfer identity', async () => {
    const requests: { url: string; method: string; body?: unknown }[] = [];
    const api = createApiClient({
      fetch: async (url, options) => {
        requests.push({
          url: String(url),
          method: options?.method ?? 'GET',
          body: options?.body ? JSON.parse(String(options.body)) : undefined,
        });
        if (String(url).includes('spaces.list'))
          return response([
            {
              id: spaceId,
              assetId: 'USDT',
              kind: 'primary',
              name: 'Main',
              goalTarget: null,
              lockedUntil: null,
              balance: '100.000000000000000001',
              ledgerAccount: { ownerType: 'user', ownerId: userId, assetId: 'USDT', kind: 'bank:primary' },
            },
          ]);
        return response({ ledgerTxId: 'ledger-confirmed', amount: '0.000000000000000001' });
      },
    });
    const pay = createPersonalPayApi(api, userId, createPayMutationGuard());
    const result = await pay.send({ transferId, fromSpaceId: spaceId, toUserId: merchantId, amount: '0.000000000000000001' });
    expect(result).toEqual({ ok: true, data: { ledgerTxId: 'ledger-confirmed', amount: '0.000000000000000001' } });
    expect(requests[1]).toEqual({
      url: '/api/bank/trpc/transfers.toUser',
      method: 'POST',
      body: { transferId, fromSpaceId: spaceId, toUserId: merchantId, amount: '0.000000000000000001' },
    });
  });
  it('refuses a numerical ledger projection before any transfer is posted', async () => {
    const methods: string[] = [];
    const api = createApiClient({
      fetch: async (_url, options) => {
        methods.push(options!.method!);
        return response([
          {
            id: spaceId,
            assetId: 'USDT',
            kind: 'primary',
            name: 'Main',
            goalTarget: null,
            lockedUntil: null,
            balance: 0.1,
            ledgerAccount: { ownerType: 'user', ownerId: userId, assetId: 'USDT', kind: 'bank:primary' },
          },
        ]);
      },
    });
    const result = await createPersonalPayApi(api, userId, createPayMutationGuard()).send({
      transferId,
      fromSpaceId: spaceId,
      toUserId: merchantId,
      amount: '0.1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' });
    expect(methods).toEqual(['GET']);
  });
  it('accepts an owned named bank space whose ledger owner is the space partition', async () => {
    const api = createApiClient({
      fetch: async () =>
        response([
          {
            id: spaceId,
            assetId: 'USDT',
            kind: 'named',
            name: 'Savings',
            goalTarget: null,
            lockedUntil: null,
            balance: '1',
            ledgerAccount: { ownerType: 'subaccount', ownerId: spaceId, assetId: 'USDT', kind: 'available' },
          },
        ]),
    });
    expect(await createPersonalPayApi(api, userId, createPayMutationGuard()).spaces()).toMatchObject({ ok: true, data: [{ id: spaceId }] });
  });
});

describe('Unconfirmed Pay outcomes', () => {
  it('keeps a lost escrow release unresolved until the authoritative order confirms ledger settlement', async () => {
    let settled = false;
    let released = false;
    const trade = () => ({
      id: transferId,
      offerId: spaceId,
      sellerId: userId,
      buyerId: merchantId,
      asset: 'USDT',
      amount: '2',
      fiatCurrency: 'USD',
      fiatAmount: '2.1',
      price: '1.05',
      method: 'operator-method',
      status: released ? 'released' : 'fiat_sent',
      resolution: released ? 'released' : null,
      deadlineAt: null,
      createdAt: '2026-10-07T12:00:00Z',
      escrowedAt: '2026-10-07T12:00:00Z',
      resolvedAt: released ? '2026-10-07T12:01:00Z' : null,
      settledAt: settled ? '2026-10-07T12:02:00Z' : null,
    });
    const api = createApiClient({
      fetch: async (_url, options) => {
        if (options?.method === 'POST') {
          released = true;
          return new Response(JSON.stringify({ error: { message: 'Connection ended' } }), { status: 503 });
        }
        return response(trade());
      },
    });
    const guard = createPayMutationGuard();
    const pay = createPersonalPayApi(api, userId, guard);
    expect(await pay.manageTrade(transferId, 'confirmReceived')).toMatchObject({ ok: false, reason: 'uncertain' });
    expect(await pay.reconcileTrade(transferId)).toMatchObject({ ok: false, reason: 'uncertain' });
    expect(guard.status(`${userId}:trade:${transferId}`)).toBe('uncertain');
    settled = true;
    expect(await pay.reconcileTrade(transferId)).toMatchObject({
      ok: true,
      data: { status: 'released', settledAt: '2026-10-07T12:02:00Z' },
    });
    expect(guard.status(`${userId}:trade:${transferId}`)).toBe(null);
  });
  it('keeps the original transfer reference available after a reload without persisting money or credentials', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    await createPayMutationGuard(storage).run(
      'customer:send',
      async () => ({ ok: false, reason: 'uncertain', message: 'Connection ended' }),
      transferId,
    );
    expect(createPayMutationGuard(storage).reference('customer:send')).toBe(transferId);
    expect(JSON.parse(values.get('pay.unresolved:customer:send') ?? '{}')).toEqual({ status: 'uncertain', reference: transferId });
  });
  it('retains a lost mutation across reload and prevents a blind duplicate', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const original = createPayMutationGuard(storage);
    await original.run('customer:send', async () => ({ ok: false, reason: 'uncertain', message: 'Connection ended' }));
    const reloaded = createPayMutationGuard(storage);
    let repeated = false;
    const result = await reloaded.run('customer:send', async () => {
      repeated = true;
      return { ok: true, data: 'duplicate' };
    });
    expect(result).toMatchObject({ ok: false, reason: 'uncertain' });
    expect(repeated).toBe(false);
  });
  it('refuses to start a mutation if a required recovery journal cannot be saved', async () => {
    const guard = createPersistentTestGuard({
      getItem: () => null,
      setItem: () => {
        throw new Error('Storage blocked');
      },
      removeItem: () => {},
    });
    let posted = false;
    const result = await guard.run('customer:send', async () => {
      posted = true;
      return { ok: true, data: 'sent' };
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_supported', code: 'pay.recovery_journal_unavailable' });
    expect(posted).toBe(false);
  });
});

describe('Public checkout capability boundary', () => {
  it('uses the fixed link amount and excludes payer-supplied rail choices', async () => {
    let posted: unknown;
    const api = createApiClient({
      fetch: async (_url, options) => {
        posted = JSON.parse(String(options?.body));
        return response({
          sessionToken: 'session-capability',
          session: {
            id: transferId,
            status: 'open',
            label: 'Order fixture',
            amount: '12.000000000000000001',
            currency: 'USD',
            method: 'card',
            expiresAt: '2026-10-07T13:00:00Z',
            instruction: null,
          },
        });
      },
    });
    const checkout = createCheckoutApi(api, createPayMutationGuard());
    const result = await checkout.open(
      {
        id: merchantId,
        merchantId,
        profileId: null,
        label: 'Order fixture',
        amount: '12.000000000000000001',
        currency: 'USD',
        expiresAt: null,
        remainingUses: 1,
        checkoutConfig: {},
      },
      'link-capability',
      { geoCountry: 'ID', method: 'card', amount: '999', assetId: 'USDT' },
    );
    expect(result.ok).toBe(true);
    expect(posted).toEqual({ token: 'link-capability', geoCountry: 'ID', method: 'card' });
  });
});

describe('Business Pay authority boundary', () => {
  it('persists the original subscription outcome reference through the business mutation boundary', async () => {
    const guard = createPayMutationGuard();
    const api = createApiClient({
      fetch: async (url) => {
        if (String(url).includes('merchant.me'))
          return response({
            id: merchantId,
            userId,
            mode: 'gateway',
            status: 'active',
            kybStatus: 'approved',
            kybRef: 'verified',
            feeBps: null,
          });
        throw new TypeError('TEST disconnected');
      },
    });
    const pay = createBusinessPayApi(
      api,
      userId,
      { verified: true, companyId: 'TEST-company', companyName: 'TEST company', merchantId, userId, scopes: ['pay:read', 'pay:write'] },
      guard,
    );
    const operation = `subscription:${transferId}`;
    expect((await pay.mutate('subscription.pause', { subscriptionId: transferId }, z.unknown(), 'pay:write', operation, 'paused')).ok).toBe(
      false,
    );
    expect(guard.status(`${userId}:${operation}`)).toBe('uncertain');
    expect(guard.reference(`${userId}:${operation}`)).toBe('paused');
  });

  it('keeps refund permission distinct from payment creation permission', async () => {
    const requests: string[] = [];
    const api = createApiClient({
      fetch: async (url) => {
        requests.push(String(url));
        return response(null);
      },
    });
    const pay = createBusinessPayApi(api, userId, {
      verified: true,
      companyId: 'verified-company',
      companyName: 'Company fixture',
      merchantId,
      userId,
      scopes: ['pay:read', 'pay:write'],
    });
    expect(
      await pay.mutate(
        'payment.refund',
        { paymentId: transferId, amount: '1', refundId: 'invoice-refund' },
        paymentSchema,
        'pay:refund',
        `payment:${transferId}`,
      ),
    ).toMatchObject({ ok: false, reason: 'forbidden', code: 'pay.business_permission_missing' });
    expect(requests).toEqual([]);
  });
  it('refuses Business reads before sending a request when company authority is absent', async () => {
    const requests: string[] = [];
    const api = createApiClient({
      fetch: async (url) => {
        requests.push(String(url));
        return response(null);
      },
    });
    const pay = createBusinessPayApi(api, userId, null);
    expect(await pay.merchant()).toMatchObject({ ok: false, reason: 'forbidden', code: 'pay.business_authority_missing' });
    expect(requests).toEqual([]);
  });
  it('refuses a foreign merchant projection even when the transport returns success', async () => {
    const api = createApiClient({
      fetch: async (url) =>
        String(url).includes('merchant.me')
          ? response({ id: merchantId, userId, mode: 'gateway', status: 'active', kybStatus: 'approved', kybRef: 'verified', feeBps: null })
          : response([
              {
                id: transferId,
                merchantId: spaceId,
                profileId: null,
                amount: '9',
                assetId: 'USD',
                method: 'card',
                railAdapter: 'acquirer',
                railRef: null,
                status: 'created',
                capturedAmount: '0',
                refundedAmount: '0',
                createdAt: '2026-10-07T12:00:00Z',
              },
            ]),
    });
    const pay = createBusinessPayApi(api, userId, {
      verified: true,
      companyId: 'verified-company',
      companyName: 'Company fixture',
      merchantId,
      userId,
      scopes: ['pay:read'],
    });
    expect(await pay.query('payment.list', { merchantId, limit: 50 }, z.array(paymentSchema))).toMatchObject({
      ok: false,
      reason: 'invalid_response',
      code: 'pay.merchant_projection_mismatch',
    });
  });
});

describe('subscription.create attempt ids', () => {
  const mandateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const operation = `subscription-create:${mandateId}`;
  const lockId = `${userId}:${operation}`;
  const attemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const authority = {
    verified: true as const,
    companyId: 'verified-company',
    companyName: 'Company fixture',
    merchantId,
    userId,
    scopes: ['pay:read', 'pay:write'],
  };
  function subscriptionRow(id: string, status: 'active' | 'cancelled' = 'active') {
    return {
      id,
      mandateId,
      merchantId,
      customerId: 'cust-replay',
      nextRunAt: '2026-01-15T00:00:00.000Z',
      status,
      cancelledAt: status === 'cancelled' ? '2026-02-01T00:00:00.000Z' : null,
      path: 'crypto_invoice',
      createdAt: '2026-01-15T00:00:00.000Z',
      anchorAt: null,
      anchorOccurrence: 0,
      pausedAt: null,
      resumedAt: null,
      stalledAt: null,
      stallReason: null,
    };
  }
  function merchantResponse() {
    return response({
      id: merchantId,
      userId,
      mode: 'gateway',
      status: 'active',
      kybStatus: 'approved',
      kybRef: 'verified',
      feeBps: null,
    });
  }
  function attemptOf(key: string | undefined) {
    expect(key?.startsWith(`${lockId}:`)).toBe(true);
    const attemptId = key!.slice(lockId.length + 1);
    expect(attemptId).toMatch(attemptIdPattern);
    expect(attemptId).not.toBe(lockId);
    return attemptId;
  }

  it('retries the stored attempt id after the response is lost and returns the original subscription', async () => {
    const creates: Array<{ idempotencyKey?: string; mandateId?: string; path?: string }> = [];
    const stored = new Map<string, ReturnType<typeof subscriptionRow>>();
    const subscription = subscriptionRow(firstId);
    const api = createApiClient({
      fetch: async (url, options) => {
        const href = String(url);
        if (href.includes('merchant.me')) return merchantResponse();
        if (!href.includes('subscription.create')) throw new Error(href);
        const body = JSON.parse(String(options?.body)) as { idempotencyKey?: string; mandateId?: string; path?: string };
        creates.push(body);
        const key = body.idempotencyKey ?? '';
        const prior = stored.get(key);
        if (!prior) {
          stored.set(key, subscription);
          throw new Error('socket hang up');
        }
        return response(prior);
      },
    });
    const pay = createBusinessPayApi(api, userId, authority, createPayMutationGuard());
    const lost = await pay.mutate('subscription.create', { mandateId, path: 'crypto_invoice' }, subscriptionSchema, 'pay:write', operation);
    expect(lost).toMatchObject({ ok: false, reason: 'uncertain' });
    const attemptId = attemptOf(creates[0]?.idempotencyKey);
    expect(creates[0]).toMatchObject({ mandateId, path: 'crypto_invoice' });
    expect(pay.guard.status(lockId)).toBe('uncertain');
    expect(pay.guard.reference(lockId)).toBe(attemptId);

    const replayed = await pay.mutate(
      'subscription.create',
      { mandateId, path: 'crypto_invoice' },
      subscriptionSchema,
      'pay:write',
      operation,
    );
    expect(replayed).toEqual({ ok: true, data: subscription });
    expect(creates[1]?.idempotencyKey).toBe(`${lockId}:${attemptId}`);
    expect(stored.size).toBe(1);
    expect(pay.guard.status(lockId)).toBeNull();
    expect(pay.guard.reference(lockId)).toBeNull();
  });

  it('sends the same key when a payment link create is repeated after a lost reply, and gets the same link back', async () => {
    const creates: Array<{ idempotencyKey?: string; label?: string }> = [];
    const stored = new Map<string, object>();
    const link = {
      id: firstId,
      token: 'pl_testtokenvalue',
      prefix: 'pl_testtok',
      label: 'Invoice',
      expiresAt: '2026-03-01T00:00:00.000Z',
      maxUses: null,
      checkoutUrl: '/checkout?token=pl_testtokenvalue',
    };
    const api = createApiClient({
      fetch: async (url, options) => {
        const href = String(url);
        if (href.includes('merchant.me')) return merchantResponse();
        if (!href.includes('merchant.createLink')) throw new Error(href);
        const body = JSON.parse(String(options?.body)) as { idempotencyKey?: string; label?: string };
        creates.push(body);
        const key = body.idempotencyKey ?? '';
        if (!stored.has(key)) {
          stored.set(key, link);
          throw new Error('socket hang up');
        }
        return response(stored.get(key));
      },
    });
    const pay = createBusinessPayApi(api, userId, authority, createPayMutationGuard());
    const schema = z.object({
      id: z.string(),
      token: z.string(),
      prefix: z.string(),
      label: z.string(),
      expiresAt: z.string(),
      maxUses: z.number().nullable(),
      checkoutUrl: z.string().nullish(),
    });
    const lock = `${userId}:link-create`;
    const input = { merchantId, label: 'Invoice' };
    const lost = await pay.mutate('merchant.createLink', input, schema, 'pay:write', 'link-create');
    expect(lost).toMatchObject({ ok: false, reason: 'uncertain' });
    expect(creates[0]?.idempotencyKey?.startsWith(`${lock}:`)).toBe(true);
    const again = await pay.mutate('merchant.createLink', input, schema, 'pay:write', 'link-create');
    expect(again).toEqual({ ok: true, data: link });
    expect(creates[1]?.idempotencyKey).toBe(creates[0]?.idempotencyKey);
    expect(stored.size).toBe(1);
    expect(pay.guard.status(lock)).toBeNull();
  });

  it('clears the journal when a replay is a definite refusal so the next click uses a new attempt id', async () => {
    const creates: Array<{ idempotencyKey?: string }> = [];
    let createsSeen = 0;
    const api = createApiClient({
      fetch: async (url, options) => {
        const href = String(url);
        if (href.includes('merchant.me')) return merchantResponse();
        if (!href.includes('subscription.create')) throw new Error(href);
        const body = JSON.parse(String(options?.body)) as { idempotencyKey?: string };
        creates.push(body);
        createsSeen += 1;
        if (createsSeen === 1) throw new Error('socket hang up');
        if (createsSeen === 2) {
          return new Response(
            JSON.stringify({
              error: {
                message: 'pay.mandate_inactive: Mandate is inactive',
                data: { code: 'CONFLICT', cause: { code: 'pay.mandate_inactive' } },
              },
            }),
            { status: 409 },
          );
        }
        return response(subscriptionRow(secondId));
      },
    });
    const pay = createBusinessPayApi(api, userId, authority, createPayMutationGuard());
    const lost = await pay.mutate('subscription.create', { mandateId, path: 'crypto_invoice' }, subscriptionSchema, 'pay:write', operation);
    expect(lost).toMatchObject({ ok: false, reason: 'uncertain' });
    const attemptId = attemptOf(creates[0]?.idempotencyKey);
    expect(pay.guard.status(lockId)).toBe('uncertain');
    expect(pay.guard.reference(lockId)).toBe(attemptId);

    const refused = await pay.mutate(
      'subscription.create',
      { mandateId, path: 'crypto_invoice' },
      subscriptionSchema,
      'pay:write',
      operation,
    );
    expect(refused).toMatchObject({ ok: false, reason: 'error', code: 'pay.mandate_inactive' });
    expect(creates[1]?.idempotencyKey).toBe(`${lockId}:${attemptId}`);
    expect(pay.guard.status(lockId)).toBeNull();
    expect(pay.guard.reference(lockId)).toBeNull();

    const again = await pay.mutate(
      'subscription.create',
      { mandateId, path: 'crypto_invoice' },
      subscriptionSchema,
      'pay:write',
      operation,
    );
    expect(again).toEqual({ ok: true, data: subscriptionRow(secondId) });
    const nextAttempt = attemptOf(creates[2]?.idempotencyKey);
    expect(nextAttempt).not.toBe(attemptId);
    expect(pay.guard.status(lockId)).toBeNull();
  });

  it('mints a new attempt after cancel so the same mandate can subscribe again', async () => {
    const creates: Array<{ idempotencyKey?: string }> = [];
    const byKey = new Map<string, ReturnType<typeof subscriptionRow>>();
    const byId = new Map<string, ReturnType<typeof subscriptionRow>>();
    const ids = [firstId, secondId];
    const api = createApiClient({
      fetch: async (url, options) => {
        const href = String(url);
        if (href.includes('merchant.me')) return merchantResponse();
        const body = JSON.parse(String(options?.body)) as { idempotencyKey?: string; subscriptionId?: string };
        if (href.includes('subscription.create')) {
          creates.push(body);
          const key = body.idempotencyKey ?? '';
          const prior = byKey.get(key);
          if (prior) return response(prior);
          const id = ids[byKey.size];
          if (!id) throw new Error('unexpected create');
          const row = subscriptionRow(id);
          byKey.set(key, row);
          byId.set(id, row);
          return response(row);
        }
        if (href.includes('subscription.cancel')) {
          const row = byId.get(body.subscriptionId ?? '');
          if (!row) throw new Error('missing subscription');
          const cancelled = subscriptionRow(row.id, 'cancelled');
          byKey.forEach((value, key) => {
            if (value.id === row.id) byKey.set(key, cancelled);
          });
          byId.set(row.id, cancelled);
          return response(cancelled);
        }
        throw new Error(href);
      },
    });
    const pay = createBusinessPayApi(api, userId, authority, createPayMutationGuard());
    const created = await pay.mutate(
      'subscription.create',
      { mandateId, path: 'crypto_invoice', idempotencyKey: lockId },
      subscriptionSchema,
      'pay:write',
      operation,
    );
    expect(created).toEqual({ ok: true, data: subscriptionRow(firstId) });
    const firstAttempt = attemptOf(creates[0]?.idempotencyKey);
    expect(pay.guard.status(lockId)).toBeNull();

    const cancelled = await pay.mutate(
      'subscription.cancel',
      { subscriptionId: firstId },
      subscriptionSchema,
      'pay:write',
      `subscription:${firstId}`,
    );
    expect(cancelled).toEqual({ ok: true, data: subscriptionRow(firstId, 'cancelled') });

    const again = await pay.mutate(
      'subscription.create',
      { mandateId, path: 'crypto_invoice' },
      subscriptionSchema,
      'pay:write',
      operation,
    );
    expect(again).toEqual({ ok: true, data: subscriptionRow(secondId) });
    const secondAttempt = attemptOf(creates[1]?.idempotencyKey);
    expect(secondAttempt).not.toBe(firstAttempt);
    expect(byKey.size).toBe(2);
    expect(pay.guard.reference(lockId)).toBeNull();
  });

  it('does not send a create when an uncertain attempt has no stored attempt id', async () => {
    const values = new Map<string, string>();
    values.set(`pay.unresolved:${lockId}`, JSON.stringify({ status: 'uncertain' }));
    let creates = 0;
    const api = createApiClient({
      fetch: async (url) => {
        const href = String(url);
        if (href.includes('merchant.me')) return merchantResponse();
        if (href.includes('subscription.create')) {
          creates += 1;
          return response(subscriptionRow(firstId));
        }
        throw new Error(href);
      },
    });
    const pay = createBusinessPayApi(
      api,
      userId,
      authority,
      createPersistentTestGuard({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
      }),
    );
    const result = await pay.mutate(
      'subscription.create',
      { mandateId, path: 'crypto_invoice' },
      subscriptionSchema,
      'pay:write',
      operation,
    );
    expect(result).toMatchObject({ ok: false, reason: 'uncertain', code: 'pay.operation_unresolved' });
    expect(creates).toBe(0);
    expect(values.get(`pay.unresolved:${lockId}`)).toBe(JSON.stringify({ status: 'uncertain' }));
  });
});

describe('Send original context admission and settlement', () => {
  const input = { transferId, fromSpaceId: spaceId, toUserId: merchantId, amount: '0.000000000000000001' };
  const spaces = [
    {
      id: spaceId,
      assetId: 'USDT',
      kind: 'primary',
      name: 'Main',
      goalTarget: null,
      lockedUntil: null,
      balance: '9999999999999999999.000000000000000001',
      ledgerAccount: { ownerType: 'user', ownerId: userId, assetId: 'USDT', kind: 'bank:primary' },
    },
  ];
  function journal() {
    const values = new Map<string, string>();
    let saves = 0,
      removals = 0;
    const guard = createPersistentTestGuard({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        saves++;
        values.set(key, value);
      },
      removeItem: (key) => {
        removals++;
        values.delete(key);
      },
    });
    return { guard, values, saves: () => saves, removals: () => removals };
  }
  it('rejects a stale rendered action before input capture or source read', async () => {
    let reads = 0,
      captured = false;
    const stored = journal();
    const api = createApiClient({
      fetch: async () => {
        reads++;
        return response(spaces);
      },
    });
    const stale = {
      ...input,
      get transferId() {
        captured = true;
        return transferId;
      },
    };
    const result = await createPersonalPayApi(api, userId, stored.guard).send(stale, () => false);
    expect(result).toMatchObject({ ok: false, reason: 'aborted', code: 'pay.send_context_changed' });
    expect([reads, stored.saves(), stored.removals()]).toEqual([0, 0, 0]);
    expect(captured).toBe(false);
  });
  it('rejects a departure during held source parsing without a journal or POST', async () => {
    const stored = journal();
    let current = true,
      posts = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = createApiClient({
      fetch: async (_url, options) => {
        if (options?.method === 'POST') {
          posts++;
          return response({ ledgerTxId: 'late', amount: input.amount });
        }
        const read = response(spaces);
        read.text = async () => {
          await held;
          return JSON.stringify({ result: { data: spaces } });
        };
        return read;
      },
    });
    const pending = createPersonalPayApi(api, userId, stored.guard).send(input, () => current);
    current = false;
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'pay.send_context_changed' });
    expect([posts, stored.saves(), stored.values.size]).toEqual([0, 0, 0]);
  });
  for (const outcome of ['known', 'unknown', 'malformed'] as const)
    it('preserves dispatched original journal bytes after departed ' + outcome + ' reply', async () => {
      const stored = journal();
      let current = true,
        posts = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const api = createApiClient({
        fetch: async (_url, options) => {
          if (options?.method !== 'POST') return response(spaces);
          posts++;
          await held;
          return outcome === 'unknown'
            ? new Response(JSON.stringify({ error: 'Unknown' }), { status: 503 })
            : response({ ledgerTxId: 'original-only', amount: outcome === 'malformed' ? '2' : input.amount });
        },
      });
      const pending = createPersonalPayApi(api, userId, stored.guard).send(input, () => current);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posts).toBe(1);
      const bytes = stored.values.get('pay.unresolved:' + userId + ':send');
      expect(JSON.parse(bytes!)).toEqual({ status: 'uncertain', reference: transferId });
      current = false;
      release();
      expect(await pending).toMatchObject({ ok: false, code: 'pay.send_context_changed' });
      expect(stored.values.get('pay.unresolved:' + userId + ':send')).toBe(bytes);
      expect([stored.saves(), stored.removals(), posts]).toEqual([1, 0, 1]);
      expect(stored.guard.status(userId + ':send')).toBe('uncertain');
    });
  it('cleans only a current known original reply and leaves the default guard callers unchanged', async () => {
    const stored = journal();
    const api = createApiClient({
      fetch: async (_url, options) =>
        options?.method === 'POST' ? response({ ledgerTxId: 'current-original', amount: input.amount }) : response(spaces),
    });
    expect(await createPersonalPayApi(api, userId, stored.guard).send(input, () => true)).toMatchObject({ ok: true });
    expect([stored.saves(), stored.removals(), stored.values.size]).toEqual([1, 1, 0]);
    expect(await stored.guard.run('default:p2p', async () => ({ ok: true, data: 'unchanged' }))).toEqual({ ok: true, data: 'unchanged' });
    expect(stored.guard.status('default:p2p')).toBe(null);
  });
});

describe('Send recovery cleanup owns the original record', () => {
  it('keeps a substituted recovery record when the original known reply arrives', async () => {
    const values = new Map<string, string>();
    const guard = createPersistentTestGuard({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = guard.run(
      'original:send',
      async () => {
        await held;
        return { ok: true, data: 'original-known' };
      },
      transferId,
      () => true,
    );
    const replacement = JSON.stringify({ status: 'uncertain', reference: 'another-original' });
    values.set('pay.unresolved:original:send', replacement);
    release();
    expect(await pending).toEqual({ ok: true, data: 'original-known' });
    expect(guard.knownCleanup('original:send')).toBe(true);
    expect(await guard.cleanupKnown('original:send', () => true, guard.knownProof('original:send'))).toBe(false);
    expect(values.get('pay.unresolved:original:send')).toBe(replacement);
  });
});

describe('Durable Pay originals across independent guards', () => {
  function device() {
    const values = new Map<string, string>(),
      legacy = new Map<string, string>();
    const fault = { read: false, save: false, remove: false, silentSave: false, silentRemove: false };
    const durable: JournalStorage = {
      getItem: (key) => {
        if (fault.read) throw new Error('Read denied');
        return values.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (fault.save) throw new Error('Quota');
        if (!fault.silentSave) values.set(key, value);
      },
      removeItem: (key) => {
        if (fault.remove) throw new Error('Remove denied');
        if (!fault.silentRemove) values.delete(key);
      },
    };
    const session: JournalStorage = {
      getItem: (key) => legacy.get(key) ?? null,
      setItem: (key, value) => {
        legacy.set(key, value);
      },
      removeItem: (key) => {
        legacy.delete(key);
      },
    };
    const locks = nativeLockFixture();
    const guard = () => createPayMutationGuard(undefined, true, { durable: () => durable, legacy: () => session, locks: () => locks });
    return { values, legacy, fault, guard };
  }
  it('re-reads a later original rather than admitting from a cached empty read in another tab', async () => {
    const deviceState = device(),
      first = deviceState.guard(),
      independent = deviceState.guard();
    expect(independent.status('owner:send')).toBe(null);
    let posts = 0;
    await first.run(
      'owner:send',
      async () => {
        posts++;
        return { ok: false, reason: 'uncertain', message: 'Unknown' };
      },
      transferId,
    );
    expect(independent.reference('owner:send')).toBe(transferId);
    expect(
      await independent.run('owner:send', async () => {
        posts++;
        return { ok: true, data: 'duplicate' };
      }),
    ).toMatchObject({ ok: false, reason: 'uncertain' });
    expect(posts).toBe(1);
    expect(await independent.run('different-owner:send', async () => ({ ok: true, data: 'isolated' }))).toMatchObject({ ok: true });
  });
  it('never overwrites an original when only reads fail, even though writes work', async () => {
    const d = device(),
      key = 'pay.unresolved:owner:send';
    const raw = JSON.stringify({ status: 'uncertain', reference: transferId });
    d.values.set(key, raw);
    d.fault.read = true;
    let posts = 0;
    expect(
      await d.guard().run('owner:send', async () => {
        posts++;
        return { ok: true, data: 'new' };
      }),
    ).toMatchObject({ ok: false, code: 'pay.recovery_journal_unavailable' });
    expect([posts, d.values.get(key)]).toEqual([0, raw]);
  });
  for (const failure of ['save', 'silentSave'] as const)
    it('refuses dispatch after ' + failure + ' without verified durable readback', async () => {
      const d = device();
      d.fault[failure] = true;
      let posts = 0;
      expect(
        await d.guard().run('owner:send', async () => {
          posts++;
          return { ok: true, data: 'new' };
        }),
      ).toMatchObject({ ok: false, code: 'pay.recovery_journal_unavailable' });
      expect(posts).toBe(0);
    });
  for (const failure of ['remove', 'silentRemove'] as const)
    it('keeps a current known reply after ' + failure + ' and retries only local exact cleanup', async () => {
      const d = device(),
        guard = d.guard();
      d.fault[failure] = true;
      let current = true,
        posts = 0;
      expect(
        await guard.run(
          'owner:send',
          async () => {
            posts++;
            return { ok: true, data: 'original-known' };
          },
          transferId,
          () => current,
        ),
      ).toEqual({ ok: true, data: 'original-known' });
      const bytes = d.values.get('pay.unresolved:owner:send');
      expect(guard.knownCleanup('owner:send')).toBe(true);
      expect(guard.status('owner:send')).toBe('uncertain');
      current = false;
      d.fault[failure] = false;
      expect(await guard.cleanupKnown('owner:send', () => true, guard.knownProof('owner:send'))).toBe(false);
      expect(d.values.get('pay.unresolved:owner:send')).toBe(bytes);
      current = true;
      expect(await guard.cleanupKnown('owner:send', () => true, guard.knownProof('owner:send'))).toBe(true);
      expect([posts, guard.status('owner:send')]).toEqual([1, null]);
    });
  it('migrates surviving legacy bytes under coordination before they can disappear with the tab', async () => {
    const d = device(),
      guard = d.guard(),
      key = 'pay.unresolved:owner:send';
    const raw = 'pending';
    d.legacy.set(key, raw);
    expect(guard.status('owner:send')).toBe('uncertain');
    d.fault.silentSave = true;
    expect(await guard.restore('owner:send')).toMatchObject({ ok: false });
    expect(d.legacy.get(key)).toBe(raw);
    d.fault.silentSave = false;
    expect(await guard.restore('owner:send')).toMatchObject({ ok: true });
    expect([d.values.get(key), d.legacy.has(key), d.guard().status('owner:send')]).toEqual([raw, false, 'uncertain']);
  });
  it('refuses a simultaneous same-key contender, while a different owner remains usable', async () => {
    const d = device(),
      first = d.guard(),
      second = d.guard();
    let release!: () => void,
      posts = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = first.run(
      'owner:send',
      async () => {
        posts++;
        await held;
        return { ok: false, reason: 'uncertain', message: 'Unknown' };
      },
      transferId,
    );
    expect(await second.restore('owner:send')).toMatchObject({ ok: true });
    expect(second.reference('owner:send')).toBe(transferId);
    expect(
      await second.run('owner:send', async () => {
        posts++;
        return { ok: true, data: 'duplicate' };
      }),
    ).toMatchObject({ ok: false, code: 'pay.recovery_journal_unavailable' });
    expect(await second.run('another-owner:send', async () => ({ ok: true, data: 'valid' }))).toMatchObject({ ok: true });
    release();
    await pending;
    expect(posts).toBe(1);
    expect(await second.restore('owner:send')).toMatchObject({ ok: true });
    expect(second.reference('owner:send')).toBe(transferId);
  });
  it('never treats a restored original unknown as a current known reply or cleanup proof', async () => {
    const d = device(),
      guard = d.guard();
    await guard.run('owner:send', async () => ({ ok: false, reason: 'uncertain', message: 'Unknown' }), transferId);
    const another = d.guard();
    expect(await another.restore('owner:send')).toMatchObject({ ok: true });
    expect(another.knownCleanup('owner:send')).toBe(false);
    expect(await another.cleanupKnown('owner:send', () => true, another.knownProof('owner:send'))).toBe(false);
    expect(another.reference('owner:send')).toBe(transferId);
  });
});

describe('Send admission before private input capture', () => {
  it('rejects a restored original before reading input getters or source preflight', async () => {
    const guard = createPayMutationGuard();
    await guard.run(userId + ':send', async () => ({ ok: false, reason: 'uncertain', message: 'Unknown' }), transferId);
    let captured = false,
      reads = 0;
    const api = createApiClient({
      fetch: async () => {
        reads++;
        return response([]);
      },
    });
    const input = {
      get transferId() {
        captured = true;
        return transferId;
      },
      fromSpaceId: spaceId,
      toUserId: merchantId,
      amount: '1',
    };
    expect(await createPersonalPayApi(api, userId, guard).send(input, () => true)).toMatchObject({
      ok: false,
      code: 'pay.operation_unresolved',
    });
    expect([captured, reads]).toEqual([false, 0]);
  });
});

describe('Known cleanup preserves the rendered original', () => {
  it('rejects a stale original proof after a fresh known transfer replaces it in the same current context', async () => {
    const values = new Map<string, string>();
    let refuseCleanup = true,
      posts = 0;
    const storage: JournalStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        if (refuseCleanup) throw new Error('Local cleanup unavailable');
        values.delete(key);
      },
    };
    const guard = createPersistentTestGuard(storage);
    const action = async () => {
      posts++;
      return { ok: true as const, data: 'known-original' };
    };
    await guard.run('owner:send', action, transferId, () => true);
    const firstProof = guard.knownProof('owner:send');
    refuseCleanup = false;
    expect(await guard.cleanupKnown('owner:send', () => true, firstProof)).toBe(true);
    refuseCleanup = true;
    await guard.run('owner:send', action, 'fresh-original', () => true);
    const replacement = values.get('pay.unresolved:owner:send');
    const currentProof = guard.knownProof('owner:send');
    refuseCleanup = false;
    expect(await guard.cleanupKnown('owner:send', () => true, firstProof)).toBe(false);
    expect(values.get('pay.unresolved:owner:send')).toBe(replacement);
    expect(await guard.cleanupKnown('owner:send', () => true, currentProof)).toBe(true);
    expect([posts, values.size]).toEqual([2, 0]);
  });
});

describe('Feature-owned original P2P reconciliation holds its admission lease', () => {
  function offerFixture() {
    const values = new Map<string, string>();
    const storage: JournalStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, raw) => {
        values.set(key, raw);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const guard = createPersistentTestGuard(storage);
    let status: 'active' | 'paused' = 'active',
      holdNext = false,
      current = true,
      reads = 0,
      posts = 0;
    let release!: () => void;
    const row = () => ({
      id: spaceId,
      makerId: userId,
      side: 'sell',
      asset: 'USDT',
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: '1',
      minAmount: '1',
      maxAmount: '2',
      remainingAmount: '2',
      methods: [],
      terms: '',
      status,
      createdAt: '2026-10-10T00:00:00Z',
    });
    const api = createApiClient({
      canWrite: () => current,
      fetch: async (url, options) => {
        const procedure = new URL(String(url), 'http://isolated.invalid').pathname.split('/').at(-1);
        if (options?.method === 'POST') {
          posts++;
          status = procedure === 'offers.resume' ? 'active' : 'paused';
          return procedure === 'offers.resume'
            ? response(row())
            : new Response(JSON.stringify({ error: 'Isolated unknown' }), { status: 503 });
        }
        reads++;
        const captured = row();
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return response(captured);
      },
    });
    return {
      pay: createPersonalPayApi(api, userId, guard),
      guard,
      values,
      hold: () => {
        holdNext = true;
      },
      release: () => release(),
      current: (value: boolean) => {
        current = value;
      },
      reads: () => reads,
      posts: () => posts,
    };
  }
  it('blocks a parallel old check and resume admission, then preserves a fresh same-action unknown until its own current proof', async () => {
    const f = offerFixture(),
      key = `${userId}:offer:${spaceId}`,
      storageKey = 'pay.unresolved:' + key;
    expect(await f.pay.manageOffer(spaceId, 'pause')).toMatchObject({ ok: false, reason: 'uncertain' });
    const original = f.values.get(storageKey),
      reads = f.reads();
    f.hold();
    const held = f.pay.reconcileOffer(spaceId);
    await Promise.resolve();
    expect(await f.pay.reconcileOffer(spaceId)).toMatchObject({ ok: false, code: 'pay.reconciliation_in_progress' });
    expect(f.reads()).toBe(reads + 1);
    expect(await f.pay.manageOffer(spaceId, 'resume')).toMatchObject({ ok: false });
    expect([f.posts(), f.values.get(storageKey)]).toEqual([1, original]);
    f.release();
    expect(await held).toMatchObject({ ok: true, data: { status: 'paused' } });
    expect(f.guard.status(key)).toBe(null);
    expect(await f.pay.manageOffer(spaceId, 'resume')).toMatchObject({ ok: true, data: { status: 'active' } });
    expect(await f.pay.manageOffer(spaceId, 'pause')).toMatchObject({ ok: false, reason: 'uncertain' });
    expect(f.values.get(storageKey)).toBe(original);
    expect(f.guard.status(key)).toBe('uncertain');
    expect(await f.pay.reconcileOffer(spaceId)).toMatchObject({ ok: true, data: { status: 'paused' } });
    expect([f.posts(), f.guard.status(key)]).toEqual([3, null]);
  });
  it('retains the original when its owner API becomes stale during a held feature proof', async () => {
    const f = offerFixture(),
      key = `${userId}:offer:${spaceId}`;
    await f.pay.manageOffer(spaceId, 'pause');
    const original = f.values.get('pay.unresolved:' + key);
    f.hold();
    const held = f.pay.reconcileOffer(spaceId);
    await Promise.resolve();
    f.current(false);
    f.release();
    expect(await held).toMatchObject({ ok: false, code: 'pay.reconciliation_context_changed', reason: 'aborted' });
    expect(f.values.get('pay.unresolved:' + key)).toBe(original);
    expect(f.guard.status(key)).toBe('uncertain');
  });
});

describe('Exact original P2P reconciliation identity', () => {
  for (const feature of ['offer', 'trade'] as const) {
    it('retains the original ' + feature + ' for a different same-owner row and accepts only its own current row', async () => {
      const requestedId = feature === 'offer' ? spaceId : transferId;
      const key = `${userId}:${feature}:${requestedId}`;
      const storageKey = 'pay.unresolved:' + key;
      const original = JSON.stringify({ status: 'uncertain', reference: feature === 'offer' ? 'pause' : 'confirmReceived' });
      const values = new Map([[storageKey, original]]);
      const guard = createPersistentTestGuard({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
      });
      let returnedId = merchantId;
      let posts = 0;
      const api = createApiClient({
        fetch: async (_url, options) => {
          if (options?.method === 'POST') posts++;
          return response(
            feature === 'offer'
              ? {
                  id: returnedId,
                  makerId: userId,
                  side: 'sell',
                  asset: 'USDT',
                  fiatCurrency: 'USD',
                  priceType: 'fixed',
                  price: '1',
                  minAmount: '1',
                  maxAmount: '2',
                  remainingAmount: '2',
                  methods: [],
                  terms: '',
                  status: 'paused',
                  createdAt: '2026-10-10T00:00:00Z',
                }
              : {
                  id: returnedId,
                  offerId: spaceId,
                  sellerId: userId,
                  buyerId: merchantId,
                  asset: 'USDT',
                  amount: '2',
                  fiatCurrency: 'USD',
                  fiatAmount: '2',
                  price: '1',
                  method: 'isolated-method',
                  status: 'released',
                  resolution: 'released',
                  deadlineAt: null,
                  createdAt: '2026-10-10T00:00:00Z',
                  escrowedAt: '2026-10-10T00:01:00Z',
                  resolvedAt: '2026-10-10T00:02:00Z',
                  settledAt: '2026-10-10T00:03:00Z',
                },
          );
        },
      });
      const pay = createPersonalPayApi(api, userId, guard);
      const reconcile = () => (feature === 'offer' ? pay.reconcileOffer(requestedId) : pay.reconcileTrade(requestedId));
      expect(await reconcile()).toMatchObject({ ok: false, reason: 'invalid_response', code: `pay.${feature}_original_mismatch` });
      expect([values.get(storageKey), guard.status(key), posts]).toEqual([original, 'uncertain', 0]);
      returnedId = requestedId;
      expect(await reconcile()).toMatchObject({ ok: true, data: { id: requestedId } });
      expect([values.has(storageKey), guard.status(key), posts]).toEqual([false, null, 0]);
    });
  }
});

describe('adding a P2P payment method (P-ads-merchant-18)', () => {
  const instrumentId = '55555555-5555-4555-8555-555555555555';
  const input = { instrumentId, methodId: 'test-bank-transfer', country: 'DE', fiatCurrency: 'EUR', label: '', details: { iban: 'X' } };
  const header = {
    id: instrumentId,
    methodId: 'test-bank-transfer',
    country: 'DE',
    fiatCurrency: 'EUR',
    label: '',
    status: 'active',
    createdAt: '2026-10-24T22:00:00Z',
    updatedAt: '2026-10-24T22:00:00Z',
    removedAt: null,
  };
  const lostAnswer = (listed: unknown[]) =>
    createApiClient({
      fetch: async (_url, options) =>
        options?.method === 'POST'
          ? new Response(JSON.stringify({ error: { message: 'Connection ended' } }), { status: 503 })
          : response(listed),
    });

  it('settles a lost answer from the person’s own list: found means saved', async () => {
    const pay = createPersonalPayApi(lostAnswer([header]), userId, createPayMutationGuard());
    expect(await pay.addInstrument(input)).toEqual({ ok: true, data: header });
  });

  it('keeps a lost answer unconfirmed when the id is not listed, and holds nothing back for the resend', async () => {
    const pay = createPersonalPayApi(lostAnswer([]), userId, createPayMutationGuard());
    expect(await pay.addInstrument(input)).toMatchObject({ ok: false, reason: 'uncertain' });
    // The same id goes again rather than being held as an unresolved operation.
    expect(await pay.addInstrument(input)).toMatchObject({ ok: false, reason: 'uncertain' });
  });

  it('passes a refusal through with its code and field', async () => {
    const api = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'x',
              data: { code: 'BAD_REQUEST', cause: { code: 'p2p.account_format_invalid' }, p2pLimit: { until: null, field: 'iban' } },
            },
          }),
          { status: 400 },
        ),
    });
    expect(await createPersonalPayApi(api, userId, createPayMutationGuard()).addInstrument(input)).toMatchObject({
      ok: false,
      code: 'p2p.account_format_invalid',
      p2pLimit: { until: null, field: 'iban' },
    });
  });
  it('sends the person’s confirmation with a save and a removal only when there is one', async () => {
    const sent: unknown[] = [];
    const api = createApiClient({
      fetch: async (_url, options) => {
        sent.push(JSON.parse(String(options?.body)));
        return response(header);
      },
    });
    const pay = createPersonalPayApi(api, userId, createPayMutationGuard());
    await pay.addInstrument({ ...input, stepUpApprovalId: 'approval-1' });
    await pay.addInstrument(input);
    await pay.removeInstrument(instrumentId, 'approval-2');
    await pay.removeInstrument(instrumentId);
    expect(sent).toEqual([
      { ...input, stepUpApprovalId: 'approval-1' },
      input,
      { instrumentId, stepUpApprovalId: 'approval-2' },
      { instrumentId },
    ]);
  });

  it('reads saved details masked through the logged read and refuses an answer without them', async () => {
    const urls: string[] = [];
    const answer = (body: unknown) =>
      createApiClient({
        fetch: async (url) => {
          urls.push(String(url));
          return response(body);
        },
      });
    const shown = await createPersonalPayApi(
      answer({ ...header, details: { iban: '•••• 3000' } }),
      userId,
      createPayMutationGuard(),
    ).maskedInstrument(instrumentId);
    expect(shown).toEqual({ ok: true, data: { ...header, details: { iban: '•••• 3000' } } });
    expect(urls[0]).toContain('instruments.revealMasked');
    expect(await createPersonalPayApi(answer(header), userId, createPayMutationGuard()).maskedInstrument(instrumentId)).toMatchObject({
      ok: false,
    });
  });

  // P-ads-merchant-18 (J-p2p-04 #4): the warning lists the ads, the removal says it may pause them, the paused ads are listed.
  it('reads what a removal does to the ads, and sends the pause confirmation only when the person gave it', async () => {
    const offerId = '66666666-6666-4666-8666-666666666666';
    const impact = {
      instrumentId,
      methodId: 'test-bank-transfer',
      fiatCurrency: 'EUR',
      ads: [{ offerId, asset: 'USDT', fiatCurrency: 'EUR', pauses: true }],
    };
    const urls: string[] = [];
    const sent: unknown[] = [];
    const api = createApiClient({
      fetch: async (url, options) => {
        urls.push(String(url));
        if (options?.method === 'POST') {
          sent.push(JSON.parse(String(options.body)));
          return response(header);
        }
        return response(impact);
      },
    });
    const pay = createPersonalPayApi(api, userId, createPayMutationGuard());
    expect(await pay.methodRemovalImpact(instrumentId)).toEqual({ ok: true, data: impact });
    expect(urls[0]).toContain('instruments.removalImpact');
    await pay.removeInstrument(instrumentId, 'approval-3', [offerId]);
    await pay.removeInstrument(instrumentId, 'approval-4', []);
    expect(sent).toEqual([
      { instrumentId, stepUpApprovalId: 'approval-3', pauseOfferIds: [offerId] },
      { instrumentId, stepUpApprovalId: 'approval-4' },
    ]);
  });

  it('lists the person’s paused ads with the reason, and refuses a list holding someone else’s ad', async () => {
    const ad = {
      id: '66666666-6666-4666-8666-666666666666',
      makerId: userId,
      side: 'sell',
      asset: 'USDT',
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: '1',
      minAmount: '1',
      maxAmount: '2',
      remainingAmount: '2',
      methods: ['test-bank-transfer'],
      terms: '',
      status: 'paused',
      pauseReason: 'method_removed',
      createdAt: '2026-10-25T00:00:00Z',
    };
    const urls: string[] = [];
    const answer = (body: unknown) =>
      createApiClient({
        fetch: async (url) => {
          urls.push(decodeURIComponent(String(url)));
          return response(body);
        },
      });
    expect(await createPersonalPayApi(answer([ad]), userId, createPayMutationGuard()).pausedOffers()).toEqual({ ok: true, data: [ad] });
    expect(urls[0]).toContain('offers.mine');
    expect(urls[0]).toContain('"status":"paused"');
    const other = { ...ad, makerId: '77777777-7777-4777-8777-777777777777' };
    expect(await createPersonalPayApi(answer([other]), userId, createPayMutationGuard()).pausedOffers()).toMatchObject({ ok: false });
  });
});

describe('reporting a sensitive payment-note remark (P-ads-merchant-19, J-p2p-04 #5)', () => {
  const tradeId = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';
  const caseId = '88888888-8888-4888-8888-888888888888';
  const opened = {
    id: caseId,
    tradeId,
    reporterId: userId,
    reportedId: '22222222-2222-4222-8222-222222222222',
    reporterRole: 'seller',
    remark: 'USDT for order 12',
    status: 'open',
    openedAt: '2026-10-25T10:00:00.000Z',
  };
  it('sends the case id, the order and the quote, and reads the open case back', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const api = createApiClient({
      fetch: async (url, options) => {
        sent.push({ url: String(url), body: JSON.parse(String(options?.body)) });
        return response(opened);
      },
    });
    const pay = createPersonalPayApi(api, userId, createPayMutationGuard());
    expect(await pay.reportSensitiveRemark(tradeId, caseId, 'USDT for order 12')).toEqual({ ok: true, data: opened });
    expect(sent).toEqual([
      { url: expect.stringContaining('trades.reportSensitiveRemark'), body: { caseId, tradeId, remark: 'USDT for order 12' } },
    ]);
  });

  it('passes a refusal through with its code, and refuses an answer that is not a case', async () => {
    const refusing = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { message: 'exists', data: { code: 'CONFLICT', cause: { code: 'p2p.remark_case_exists' } } } }),
          {
            status: 409,
          },
        ),
    });
    expect(
      await createPersonalPayApi(refusing, userId, createPayMutationGuard()).reportSensitiveRemark(tradeId, caseId, 'x'),
    ).toMatchObject({
      ok: false,
      code: 'p2p.remark_case_exists',
    });
    const odd = createApiClient({ fetch: async () => response({ ...opened, status: 'closed' }) });
    expect(await createPersonalPayApi(odd, userId, createPayMutationGuard()).reportSensitiveRemark(tradeId, caseId, 'x')).toMatchObject({
      ok: false,
    });
  });
});

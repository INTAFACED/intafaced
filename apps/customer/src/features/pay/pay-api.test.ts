import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { createPersonalPayApi, createBusinessPayApi, createPayMutationGuard, createCheckoutApi } from './pay-api';
import { z } from 'zod';
import { paymentSchema } from './schemas';

const userId = '11111111-1111-4111-8111-111111111111';
const spaceId = '22222222-2222-4222-8222-222222222222';
const merchantId = '33333333-3333-4333-8333-333333333333';
const transferId = '44444444-4444-4444-8444-444444444444';
function response(data: unknown) {
  return new Response(JSON.stringify({ result: { data } }));
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
    const guard = createPayMutationGuard(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('Storage blocked');
        },
        removeItem: () => {},
      },
      true,
    );
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

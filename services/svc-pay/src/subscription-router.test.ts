import { beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createSubscriptionRouter } from './subscription-router.js';
import { PayError, type PayService } from './payment-service.js';
import type { SubscriptionService } from './subscriptions/subscription-service.js';
import { SubMerchantError } from './submerchants.js';

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const MERCHANT = '55555555-5555-4555-8555-555555555555';
const MANDATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

async function ctx(scopes: string[], userId = USER): Promise<Context> {
  const { token } = await issueAccessToken(
    {
      userId,
      sessionId: '77777777-7777-4777-8777-777777777777',
      scopes,
      tier: 'full',
      mfa: true,
    },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-sub' };
}

function mandateRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: MANDATE,
    merchantId: MERCHANT,
    customerId: 'cust-1',
    assetId: 'USDT',
    amount: amt('10'),
    ceiling: null,
    cadence: 'monthly' as const,
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: null,
    railAdapter: null,
    railMandateRef: null,
    status: 'active' as const,
    cancelledAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function subRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    mandateId: MANDATE,
    merchantId: MERCHANT,
    customerId: 'cust-1',
    nextRunAt: new Date('2026-08-01T00:00:00.000Z'),
    status: 'active' as const,
    cancelledAt: null,
    path: 'crypto_invoice',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    anchorAt: null,
    anchorOccurrence: 0,
    pausedAt: null,
    resumedAt: null,
    stalledAt: null,
    stallReason: null,
    ...overrides,
  };
}

describe('subscription merchant surface', () => {
  let owner = USER;
  let subs: SubscriptionService;
  let pay: PayService;
  let router: ReturnType<typeof createSubscriptionRouter>;
  let calls: string[];

  beforeEach(() => {
    owner = USER;
    calls = [];
    pay = {
      getMerchant: async (id: string) => {
        if (id !== MERCHANT) throw new PayError('nf', 'pay.merchant_not_found');
        return { id: MERCHANT, userId: owner } as never;
      },
      getMerchantByUserId: async (userId: string) => {
        if (userId === owner) return { id: MERCHANT } as never;
        return null;
      },
    } as unknown as PayService;

    subs = {
      createMandate: async () => {
        calls.push('createMandate');
        return mandateRecord();
      },
      getMandate: async () => mandateRecord(),
      cancelMandate: async () => {
        calls.push('cancelMandate');
        return mandateRecord({ status: 'cancelled', cancelledAt: new Date('2026-08-09T00:00:00.000Z') });
      },
      createSubscription: async () => {
        calls.push('createSubscription');
        return subRecord();
      },
      getSubscription: async () => subRecord(),
      cancelSubscription: async () => {
        calls.push('cancelSubscription');
        return subRecord({ status: 'cancelled', cancelledAt: new Date('2026-08-09T00:00:00.000Z') });
      },
      listExecutions: async () => {
        calls.push('listExecutions');
        return [
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            subscriptionId: SUB,
            occurrence: 0,
            amount: amt('10'),
            status: 'settled' as const,
            paymentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            rejectionCode: null,
            attemptedAt: new Date('2026-08-01T00:00:00.000Z'),
            settledAt: new Date('2026-08-01T01:00:00.000Z'),
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
            notifyStatus: 'skipped_unwired' as const,
            notifyCode: 'pay.subscription_notify_unwired',
          },
        ];
      },
      listMandates: async () => {
        calls.push('listMandates');
        return { items: [mandateRecord()], nextCursor: null };
      },
      listSubscriptions: async () => {
        calls.push('listSubscriptions');
        return { items: [subRecord()], nextCursor: null };
      },
      setCollectionMethod: async () => {
        calls.push('setCollectionMethod');
        return subRecord();
      },
    } as unknown as SubscriptionService;

    router = createSubscriptionRouter(subs, pay, null);
  });

  const caller = async (scopes: string[], userId?: string) => router.createCaller(await ctx(scopes, userId));

  it('owner can create a mandate (no charge)', async () => {
    const api = await caller(['pay:write']);
    const m = await api.mandate.create({
      merchantId: MERCHANT,
      customerId: 'cust-1',
      assetId: 'USDT',
      amount: '10',
      cadence: 'monthly',
      startsAt: '2026-08-01T00:00:00.000Z',
    });
    expect(m.id).toBe(MANDATE);
    expect(m.amount).toBe('10');
    expect(calls).toContain('createMandate');
  });

  it('stranger cannot get a mandate', async () => {
    owner = OTHER;
    const api = await caller(['pay:read'], USER);
    await expect(api.mandate.get({ mandateId: MANDATE })).rejects.toThrow(/mandate_not_found/);
  });

  it('owner can create, get, and cancel a subscription', async () => {
    const api = await caller(['pay:write', 'pay:read']);
    const created = await api.subscription.create({ mandateId: MANDATE });
    expect(created.path).toBe('crypto_invoice');
    const got = await api.subscription.get({ subscriptionId: SUB });
    expect(got.id).toBe(SUB);
    const cancelled = await api.subscription.cancel({ subscriptionId: SUB });
    expect(cancelled.status).toBe('cancelled');
    expect(calls).toEqual(expect.arrayContaining(['createSubscription', 'cancelSubscription']));
  });

  it('owner can cancel a mandate (cascades; no charge reverse)', async () => {
    const api = await caller(['pay:write']);
    const cancelled = await api.mandate.cancel({ mandateId: MANDATE });
    expect(cancelled.status).toBe('cancelled');
    expect(calls).toContain('cancelMandate');
  });

  it('subscription.create accepts card_mandate path (fire refuses separately)', async () => {
    const api = await caller(['pay:write']);
    // Router must keep the enum value that fireOccurrence refuses by name.
    const created = await api.subscription.create({ mandateId: MANDATE, path: 'card_mandate' });
    expect(created).toBeDefined();
    expect(calls).toContain('createSubscription');
  });

  it('owner can list executions (firing history)', async () => {
    const api = await caller(['pay:read']);
    const rows = await api.subscription.listExecutions({ subscriptionId: SUB });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('settled');
    expect(rows[0]!.amount).toBe('10');
    expect(calls).toContain('listExecutions');
  });

  it('stranger cannot list executions', async () => {
    owner = OTHER;
    const api = await caller(['pay:read'], USER);
    await expect(api.subscription.listExecutions({ subscriptionId: SUB })).rejects.toThrow(/subscription_not_found/);
    expect(calls).not.toContain('listExecutions');
  });

  it('owner can list mandates for a merchant', async () => {
    const api = await caller(['pay:read']);
    const rows = await api.mandate.list({ merchantId: MERCHANT });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]!.id).toBe(MANDATE);
    expect(rows.items[0]!.amount).toBe('10');
    expect(calls).toContain('listMandates');
  });

  it('stranger cannot list mandates', async () => {
    owner = OTHER;
    const api = await caller(['pay:read'], USER);
    await expect(api.mandate.list({ merchantId: MERCHANT })).rejects.toThrow(/merchant_not_found/);
    expect(calls).not.toContain('listMandates');
  });

  it('owner can list subscriptions for a merchant', async () => {
    const api = await caller(['pay:read']);
    const rows = await api.subscription.list({ merchantId: MERCHANT, status: 'active' });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]!.id).toBe(SUB);
    expect(rows.items[0]!.path).toBe('crypto_invoice');
    expect(calls).toContain('listSubscriptions');
  });

  it('stranger cannot list subscriptions', async () => {
    owner = OTHER;
    const api = await caller(['pay:read'], USER);
    await expect(api.subscription.list({ merchantId: MERCHANT })).rejects.toThrow(/merchant_not_found/);
    expect(calls).not.toContain('listSubscriptions');
  });

  it('parent without payment area cannot cancel (PayFac fence)', async () => {
    const trees = {
      async assertHolds() {
        throw new SubMerchantError('no', 'pay.submerchant_permission_denied', { area: 'payment' });
      },
    };
    owner = OTHER;
    const parentPay = {
      getMerchant: async () => ({ id: MERCHANT, userId: OTHER }) as never,
      getMerchantByUserId: async (userId: string) => {
        if (userId === USER) return { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } as never;
        return null;
      },
    } as unknown as PayService;
    const fenced = createSubscriptionRouter(subs, parentPay, trees);
    const api = fenced.createCaller(await ctx(['pay:write'], USER));
    await expect(api.subscription.cancel({ subscriptionId: SUB })).rejects.toThrow(/submerchant_permission_denied|FORBIDDEN/i);
    expect(calls).not.toContain('cancelSubscription');
  });

  it('owner can set the collection method to send invoice (M-bill-01)', async () => {
    const api = await caller(['pay:write']);
    const out = await api.subscription.setCollectionMethod({ subscriptionId: SUB, method: 'send_invoice' });
    expect(out.collectionMethod).toBe('send_invoice');
    expect(out.subscription.id).toBe(SUB);
    expect(calls).toContain('setCollectionMethod');
  });

  it('stranger cannot set the collection method: reads as not found (ownership fence)', async () => {
    owner = OTHER;
    const api = await caller(['pay:write'], USER);
    await expect(api.subscription.setCollectionMethod({ subscriptionId: SUB, method: 'send_invoice' })).rejects.toThrow(
      /subscription_not_found/,
    );
    expect(calls).not.toContain('setCollectionMethod');
  });

  it('parent without payment area cannot set the collection method (PayFac fence)', async () => {
    const trees = {
      async assertHolds() {
        throw new SubMerchantError('no', 'pay.submerchant_permission_denied', { area: 'payment' });
      },
    };
    owner = OTHER;
    const parentPay = {
      getMerchant: async () => ({ id: MERCHANT, userId: OTHER }) as never,
      getMerchantByUserId: async (userId: string) => {
        if (userId === USER) return { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } as never;
        return null;
      },
    } as unknown as PayService;
    const api = createSubscriptionRouter(subs, parentPay, trees).createCaller(await ctx(['pay:write'], USER));
    await expect(api.subscription.setCollectionMethod({ subscriptionId: SUB, method: 'send_invoice' })).rejects.toThrow(
      /submerchant_permission_denied|FORBIDDEN/i,
    );
    expect(calls).not.toContain('setCollectionMethod');
  });

  it('a read-only token cannot set the collection method (scope refusal)', async () => {
    const api = await caller(['pay:read']);
    await expect(api.subscription.setCollectionMethod({ subscriptionId: SUB, method: 'send_invoice' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(calls).not.toContain('setCollectionMethod');
  });

  it('charge automatically refuses NotLiveCard rail.card and the method is not written', async () => {
    subs.setCollectionMethod = async (_id: string, method: string) => {
      calls.push('setCollectionMethod');
      const { assertCollectionMethodAvailable } = await import('./subscriptions/merchant-disp-bill-rep-collection-method.js');
      assertCollectionMethodAvailable(method as 'charge_automatically');
      return subRecord() as never;
    };
    const api = await caller(['pay:write']);
    const err = await api.subscription.setCollectionMethod({ subscriptionId: SUB, method: 'charge_automatically' }).then(
      () => null,
      (e: unknown) => e as { message: string; cause?: { code?: string; blockers?: unknown } },
    );
    expect(err?.message).toMatch(/pay\.mandate_rail_absent/);
    expect(err?.cause?.blockers).toEqual([{ code: 'rail.card' }]);
  });

  it('forwards Idempotency-Key to createSubscription', async () => {
    let seen: string | undefined;
    subs.createSubscription = async (input: { idempotencyKey?: string }) => {
      seen = input.idempotencyKey;
      calls.push('createSubscription');
      return subRecord();
    };
    router = createSubscriptionRouter(subs, pay, null);
    const api = await caller(['pay:write']);
    await api.subscription.create({ mandateId: MANDATE, idempotencyKey: 'sub-create-1' });
    expect(seen).toBe('sub-create-1');
  });

  it('refuses a blank Idempotency-Key before creating', async () => {
    const api = await caller(['pay:write']);
    await expect(api.subscription.create({ mandateId: MANDATE, idempotencyKey: '   ' })).rejects.toMatchObject({
      message: expect.stringContaining('pay.idempotency_required'),
      cause: expect.objectContaining({ code: 'pay.idempotency_required' }),
    });
    expect(calls).not.toContain('createSubscription');
  });

  it('maps an open mandate and an idempotency conflict to CONFLICT', async () => {
    const apiFor = async (code: 'pay.subscription_mandate_open' | 'pay.idempotency_conflict') => {
      subs.createSubscription = async () => {
        throw new PayError(code, code);
      };
      return createSubscriptionRouter(subs, pay, null).createCaller(await ctx(['pay:write']));
    };
    const open = await apiFor('pay.subscription_mandate_open');
    await expect(open.subscription.create({ mandateId: MANDATE })).rejects.toMatchObject({ code: 'CONFLICT' });
    const conflict = await apiFor('pay.idempotency_conflict');
    await expect(conflict.subscription.create({ mandateId: MANDATE, idempotencyKey: 'k' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createPayRouter } from './router.js';
import { PayError, type PayService, type PaymentView } from './payment-service.js';
import type { UserMoneyService } from './user-money-service.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import type { MerchantAreaFence } from './merchant-ownership.js';
import { SubMerchantError, type PermissionArea } from './submerchants.js';

/**
 * Gateway tRPC money doors must use the shared PayFac area map, not ownership
 * alone. A descendant without `payment` / `payment.refund` is refused; an
 * ancestor with the area (or the leaf owner) still works. Actor identity is
 * the principal — `actorMerchantId` on the wire cannot widen scope.
 */

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const ROOT = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const LEAF = '33333333-3333-4333-8333-333333333333';
const ROOT_USER = '44444444-4444-4444-8444-444444444444';
const MID_USER = '55555555-5555-4555-8555-555555555555';
const LEAF_USER = '66666666-6666-4666-8666-666666666666';
const PAYMENT = '77777777-7777-4777-8777-777777777777';

function codeOf(err: unknown) {
  return (err as { code?: string }).code;
}

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken(
    {
      userId,
      sessionId: '88888888-8888-4888-8888-888888888888',
      scopes,
      tier: 'full',
      mfa: true,
    },
    authConfig,
  );
  return {
    principal: await verifyAccessToken(token, authConfig),
    service: null,
    region: 'DE',
    requestId: 'req-payfac-area',
  };
}

function paymentView(overrides: Partial<PaymentView> = {}): PaymentView {
  return {
    id: PAYMENT,
    merchantId: LEAF,
    profileId: null,
    amount: amt('10'),
    assetId: 'USDT',
    method: 'card',
    railAdapter: 'card-sandbox',
    railRef: 'ch_1',
    status: 'authorized',
    capturedAmount: 0n,
    refundedAmount: 0n,
    createdAt: new Date('2026-08-16T12:00:00.000Z'),
    ...overrides,
  };
}

function payStub() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const merchants = {
    [ROOT]: { id: ROOT, userId: ROOT_USER },
    [MID]: { id: MID, userId: MID_USER },
    [LEAF]: { id: LEAF, userId: LEAF_USER },
  };
  const byUser: Record<string, string> = {
    [ROOT_USER]: ROOT,
    [MID_USER]: MID,
    [LEAF_USER]: LEAF,
  };
  const record = <T>(method: string, result: (...args: never[]) => T) =>
    ((...args: never[]) => {
      calls.push({ method, args });
      return Promise.resolve(result(...args));
    }) as never;

  const service = {
    getMerchant: record('getMerchant', (id: string) => {
      const m = merchants[id as keyof typeof merchants];
      if (!m) throw new PayError('not found', 'pay.merchant_not_found');
      return m as never;
    }),
    getMerchantByUserId: record('getMerchantByUserId', (userId: string) => {
      const id = byUser[userId];
      return id ? (merchants[id as keyof typeof merchants] as never) : null;
    }),
    createPayment: record('createPayment', () => paymentView({ status: 'created', railRef: null })),
    capture: record('capture', () => paymentView({ status: 'captured', capturedAmount: amt('10') })),
    refund: record('refund', () => paymentView({ status: 'refunded', capturedAmount: amt('10'), refundedAmount: amt('10') })),
    getPayment: record('getPayment', () => paymentView()),
  } as unknown as PayService;

  return { service, calls };
}

function fence(held: PermissionArea[]): MerchantAreaFence {
  return {
    async assertHolds(actor: string, subject: string, area: PermissionArea) {
      if (actor === subject) return;
      if (actor === ROOT && subject === LEAF) return;
      if (actor === MID && subject === LEAF && held.includes(area)) return;
      if (actor === MID && subject === LEAF) {
        throw new SubMerchantError(`no ${area}`, 'pay.submerchant_permission_denied', { area });
      }
      throw new SubMerchantError('out', 'pay.submerchant_out_of_scope');
    },
  };
}

const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'router-payfac-area-secret-at-least-32', toleranceSeconds: 300 })]);
const money = {} as UserMoneyService;

const createBody = {
  merchantId: LEAF,
  amount: '10',
  assetId: 'USDT',
  method: 'card',
  railAdapter: 'card-sandbox',
};

describe('tRPC PayFac area map on gateway money doors', () => {
  it('refuses a descendant without payment on payment.create / capture / refund', async () => {
    const stub = payStub();
    const api = createPayRouter(stub.service, rails, money, fence([])).createCaller(await ctx(MID_USER, ['pay:write', 'pay:refund']));

    expect(codeOf(await api.payment.create(createBody).catch((e: unknown) => e))).toBe('FORBIDDEN');
    expect(stub.calls.filter((c) => c.method === 'createPayment')).toHaveLength(0);

    expect(codeOf(await api.payment.capture({ paymentId: PAYMENT }).catch((e: unknown) => e))).toBe('FORBIDDEN');
    expect(stub.calls.filter((c) => c.method === 'capture')).toHaveLength(0);

    expect(codeOf(await api.payment.refund({ paymentId: PAYMENT, amount: '10', refundId: 'r-test-1' }).catch((e: unknown) => e))).toBe(
      'FORBIDDEN',
    );
    expect(stub.calls.filter((c) => c.method === 'refund')).toHaveLength(0);
  });

  it('lets an ancestor with the area create and capture; refund needs payment.refund', async () => {
    const stub = payStub();
    const withPayment = createPayRouter(stub.service, rails, money, fence(['payment'])).createCaller(
      await ctx(MID_USER, ['pay:write', 'pay:refund']),
    );

    await expect(withPayment.payment.create(createBody)).resolves.toMatchObject({ merchantId: LEAF });
    await expect(withPayment.payment.capture({ paymentId: PAYMENT })).resolves.toMatchObject({ status: 'captured' });
    expect(
      codeOf(await withPayment.payment.refund({ paymentId: PAYMENT, amount: '10', refundId: 'r-test-1' }).catch((e: unknown) => e)),
    ).toBe('FORBIDDEN');
    expect(stub.calls.filter((c) => c.method === 'refund')).toHaveLength(0);

    const withRefund = createPayRouter(stub.service, rails, money, fence(['payment.refund'])).createCaller(
      await ctx(MID_USER, ['pay:write', 'pay:refund']),
    );
    await expect(withRefund.payment.refund({ paymentId: PAYMENT, amount: '10', refundId: 'area-rf-1' })).resolves.toMatchObject({
      status: 'refunded',
    });
    expect(stub.calls.find((c) => c.method === 'refund')?.args[2]).toEqual({ refundId: 'area-rf-1' });
  });

  it('lets the leaf owner and the tree root act without an extra grant', async () => {
    const stub = payStub();
    const owner = createPayRouter(stub.service, rails, money, fence([])).createCaller(await ctx(LEAF_USER, ['pay:write', 'pay:refund']));
    await expect(owner.payment.create(createBody)).resolves.toMatchObject({ merchantId: LEAF });

    const root = createPayRouter(stub.service, rails, money, fence([])).createCaller(await ctx(ROOT_USER, ['pay:write']));
    await expect(root.payment.capture({ paymentId: PAYMENT })).resolves.toMatchObject({ status: 'captured' });
  });

  it('ignores actorMerchantId on the wire — actor is the principal', async () => {
    const stub = payStub();
    const holds: PermissionArea[][] = [];
    const trees: MerchantAreaFence = {
      async assertHolds(actor, subject, area) {
        holds.push([area]);
        if (actor !== MID || subject !== LEAF) {
          throw new SubMerchantError('out', 'pay.submerchant_out_of_scope');
        }
        throw new SubMerchantError(`no ${area}`, 'pay.submerchant_permission_denied', { area });
      },
    };
    const api = createPayRouter(stub.service, rails, money, trees).createCaller(await ctx(MID_USER, ['pay:write']));

    const err = await api.payment
      .create({ ...createBody, actorMerchantId: ROOT } as typeof createBody & { actorMerchantId: string })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    const create = stub.calls.find((c) => c.method === 'createPayment');
    expect(create).toBeUndefined();
    const actorLookups = stub.calls.filter((c) => c.method === 'getMerchantByUserId').map((c) => c.args[0]);
    expect(actorLookups).toContain(MID_USER);
    expect(actorLookups).not.toContain(ROOT_USER);
    expect(holds.length).toBeGreaterThan(0);
  });

  it('does not area-gate hosted checkout.open — that door has no merchant principal', async () => {
    const holds: string[] = [];
    const trees: MerchantAreaFence = {
      async assertHolds() {
        holds.push('called');
      },
    };
    const pay = {
      ...payStub().service,
      openCheckoutSession: async () => ({
        sessionToken: 'cs_public',
        session: {
          id: PAYMENT,
          status: 'open' as const,
          label: 'Invoice',
          amount: '10',
          currency: 'USDT',
          method: 'crypto',
          expiresAt: '2026-08-16T12:15:00.000Z',
          instruction: { reference: '0x1', amount: '10', currency: 'USDT' },
        },
      }),
    } as unknown as PayService;
    const api = createPayRouter(pay, rails, money, trees).createCaller({
      principal: null,
      service: null,
      region: 'DE',
      requestId: 'anon',
    });
    await expect(api.checkout.open({ token: 'pl_public_token_xx' })).resolves.toMatchObject({ sessionToken: 'cs_public' });
    expect(holds).toEqual([]);
  });
});

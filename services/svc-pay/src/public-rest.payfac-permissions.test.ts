import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayError, type PayService } from './payment-service.js';
import { registerPublicPayRest } from './public-rest.js';
import { PERMISSION_AREAS, SubMerchantError, assertPermissionHistoryLimit, assertPermissionListLimit } from './submerchants.js';
import type { MerchantAreaFence } from './merchant-ownership.js';
import type { PayfacPermissionPort } from './payfac-permissions.js';

/**
 * D26-P1-P2 — REST permission product path.
 * Actor comes from the principal's merchant node; grant/list call the tree port.
 */

const SECRET = 'a-pay-public-rest-edge-secret-long-enough-x';
const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const ROOT = '33333333-3333-4333-8333-333333333333';
const MID = '44444444-4444-4444-8444-444444444444';
const LEAF = '55555555-5555-4555-8555-555555555555';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OWNER,
    userId: OWNER,
    sid: '66666666-6666-4666-8666-666666666666',
    scopes: ['pay:read', 'pay:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function stubPay(userToMerchant: Record<string, string>): PayService {
  return {
    getMerchant: async () => {
      throw new PayError('unused', 'pay.merchant_not_found');
    },
    getMerchantByUserId: async (userId: string) => {
      const id = userToMerchant[userId];
      return id ? ({ id, userId } as never) : null;
    },
  } as unknown as PayService;
}

function stubPermissions(over: Partial<PayfacPermissionPort> = {}): PayfacPermissionPort {
  return {
    assertHolds: vi.fn(async () => undefined),
    grantPermission: vi.fn(async (input) => ({
      id: '77777777-7777-4777-8777-777777777777',
      seq: '1',
      granteeMerchantId: input.granteeMerchantId,
      subjectMerchantId: input.subjectMerchantId,
      area: input.area,
      action: 'grant' as const,
      reason: input.reason,
      actorId: input.actorId,
      actorMerchantId: input.actorMerchantId,
      actorScope: input.actorScope,
      createdAt: new Date('2026-08-12T00:00:00.000Z'),
    })),
    revokePermission: vi.fn(async (input) => ({
      id: '88888888-8888-4888-8888-888888888888',
      seq: '2',
      granteeMerchantId: input.granteeMerchantId,
      subjectMerchantId: input.subjectMerchantId,
      area: input.area,
      action: 'revoke' as const,
      reason: input.reason,
      actorId: input.actorId,
      actorMerchantId: input.actorMerchantId,
      actorScope: input.actorScope,
      createdAt: new Date('2026-08-12T00:01:00.000Z'),
    })),
    listPermissions: vi.fn(async () => [
      {
        granteeMerchantId: MID,
        subjectMerchantId: LEAF,
        area: 'payment.refund' as const,
        reason: 'mid handles first-line refunds',
        actorId: OWNER,
        actorMerchantId: ROOT,
        grantedAt: new Date('2026-08-12T00:00:00.000Z'),
      },
    ]),
    permissionHistory: vi.fn(async () => []),
    ...over,
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(trees: MerchantAreaFence | PayfacPermissionPort | null) {
  const instance = Fastify({ logger: false });
  await registerPublicPayRest(instance, {
    edgeSecret: SECRET,
    serviceName: 'svc-pay-test',
    pay: stubPay({ [OWNER]: ROOT }),
    trees,
  });
  return instance;
}

describe('REST PayFac permissions (D26-P1-P2)', () => {
  it('refuses pay:read when the owner grant no longer includes it', async () => {
    const instance = Fastify({ logger: false });
    await registerPublicPayRest(instance, {
      edgeSecret: SECRET,
      serviceName: 'svc-pay-test',
      pay: stubPay({ [OWNER]: ROOT }),
      trees: stubPermissions(),
      recheckOwnerPayScope: async () => {
        throw new Error('pay.owner_grant_withdrawn');
      },
    });
    app = instance;
    const res = await app.inject({ method: 'GET', url: '/v1/submerchant-permissions/areas', headers: signed() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('pay.owner_grant_withdrawn');
  });

  it('exposes the eleven-area vocabulary under pay:read', async () => {
    app = await build(stubPermissions());
    const res = await app.inject({ method: 'GET', url: '/v1/submerchant-permissions/areas', headers: signed() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([...PERMISSION_AREAS]);
    expect(res.json()).toHaveLength(11);
    expect(res.json()).not.toHaveLength(14);
    expect(res.json()).not.toContain('underwriting');
  });

  it('grant schema refuses an invented fourteenth area and underwriting', async () => {
    const trees = stubPermissions();
    app = await build(trees);
    for (const area of ['underwriting', 'area.14', 'everything'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/submerchant-permissions/grant',
        headers: signed(),
        payload: {
          granteeMerchantId: MID,
          subjectMerchantId: LEAF,
          area,
          reason: 'must not invent a fourteenth permission area',
        },
      });
      expect(res.statusCode, area).not.toBe(200);
      expect(trees.grantPermission).not.toHaveBeenCalled();
    }
  });

  it('does not mount permission routes when trees is only an assertHolds fence', async () => {
    app = await build({ assertHolds: async () => undefined });
    const res = await app.inject({ method: 'GET', url: '/v1/submerchant-permissions/areas', headers: signed() });
    expect(res.statusCode).toBe(404);
  });

  it('lists grants with actor resolved from the principal — never from the body', async () => {
    const trees = stubPermissions();
    app = await build(trees);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/submerchant-permissions?subjectMerchantId=${LEAF}&limit=50`,
      headers: signed(),
    });
    expect(res.statusCode).toBe(200);
    expect(trees.listPermissions).toHaveBeenCalledWith(ROOT, LEAF, 50);
    expect(res.json()[0].area).toBe('payment.refund');
  });

  it('refuses grant until the named account consents, and does not call the journal', async () => {
    const trees = stubPermissions();
    app = await build(trees);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/submerchant-permissions/grant',
      headers: signed(),
      payload: {
        granteeMerchantId: MID,
        subjectMerchantId: LEAF,
        area: 'payment',
        reason: 'mid runs capture for this cohort',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('pay.submerchant_consent_required');
    expect(trees.grantPermission).not.toHaveBeenCalled();
  });

  it('refuses revoke the same way', async () => {
    const trees = stubPermissions();
    app = await build(trees);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/submerchant-permissions/revoke',
      headers: signed(),
      payload: {
        granteeMerchantId: MID,
        subjectMerchantId: LEAF,
        area: 'payment',
        reason: 'take the capture grant back',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('pay.submerchant_consent_required');
    expect(trees.revokePermission).not.toHaveBeenCalled();
  });

  it('maps SubMerchantError permission_denied to 403 with pay.* code', async () => {
    const trees = stubPermissions({
      listPermissions: async () => {
        throw new SubMerchantError('no', 'pay.submerchant_permission_denied', { area: 'payment' });
      },
    });
    app = await build(trees);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/submerchant-permissions?subjectMerchantId=${LEAF}&limit=50`,
      headers: signed(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('pay.submerchant_permission_denied');
  });

  it('refuses a principal with no merchant node', async () => {
    app = Fastify({ logger: false });
    await registerPublicPayRest(app, {
      edgeSecret: SECRET,
      serviceName: 'svc-pay-test',
      pay: stubPay({}),
      trees: stubPermissions(),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/submerchant-permissions?subjectMerchantId=${LEAF}`,
      headers: signed(principal({ sub: STRANGER, userId: STRANGER })),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('pay.submerchant_not_onboarded');
  });

  it('REFUSES live grants list when limit is omitted — never invents 50; owner may pass 50', async () => {
    const trees = stubPermissions({
      listPermissions: async (_actor, _subject, limit) => {
        assertPermissionListLimit(limit);
        return [];
      },
    });
    app = await build(trees);

    const omitted = await app.inject({
      method: 'GET',
      url: `/v1/submerchant-permissions?subjectMerchantId=${LEAF}`,
      headers: signed(),
    });
    expect(omitted.statusCode).toBe(400);
    expect(omitted.json().error.code).toBe('pay.submerchant_permission_list_limit_unset');

    const explicit = await app.inject({
      method: 'GET',
      url: `/v1/submerchant-permissions?subjectMerchantId=${LEAF}&limit=50`,
      headers: signed(),
    });
    expect(explicit.statusCode).toBe(200);
  });

  it('REFUSES permission history when limit is omitted — never invents 50; owner may pass 50', async () => {
    const trees = stubPermissions({
      permissionHistory: async (_actor, _subject, limit) => {
        assertPermissionHistoryLimit(limit);
        return [];
      },
    });
    app = await build(trees);

    const omitted = await app.inject({
      method: 'GET',
      url: `/v1/submerchant-permissions/history?subjectMerchantId=${LEAF}`,
      headers: signed(),
    });
    expect(omitted.statusCode).toBe(400);
    expect(omitted.json().error.code).toBe('pay.submerchant_permission_history_limit_unset');

    const explicit = await app.inject({
      method: 'GET',
      url: `/v1/submerchant-permissions/history?subjectMerchantId=${LEAF}&limit=50`,
      headers: signed(),
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toEqual([]);
  });
});

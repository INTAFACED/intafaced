import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSubMerchantRouter, type ActorMerchantLookup } from './submerchant-router.js';
import { PERMISSION_AREAS, SubMerchantError, type SubMerchantService } from './submerchants.js';

/**
 * THE PAYFAC BOUNDARY.
 *
 * No database and no tree: `submerchants.test.ts` owns the fence itself against
 * real Postgres. What this file protects is the property the fence depends on
 * and cannot check for itself —
 *
 *   **WHICH NODE THE CALLER IS ACTING AS COMES FROM THE TOKEN, NEVER THE BODY.**
 *
 * `pay:write` is a merchant's own scope; every merchant on the platform holds
 * it. So if `actorMerchantId` could be supplied by the caller, the subtree fence
 * would still work perfectly and would be measuring the wrong actor — a merchant
 * could name a payfac as the node it was acting as and inherit that payfac's
 * whole subtree. That is not a bug the tree suite can catch, because the tree
 * would be behaving exactly as designed.
 *
 * The second thing here is REFUSAL SHAPE. A merchant's engineer has to be able
 * to tell "not yours" from "malformed" from "we are broken" — `router.ts` makes
 * the same distinction for rail failures, for the same reason: collapsing them
 * costs somebody an afternoon.
 */

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const PLATFORM_USER = '11111111-1111-4111-8111-111111111111';
const STRANGER_USER = '22222222-2222-4222-8222-222222222222';
const PLATFORM_MERCHANT = '33333333-3333-4333-8333-333333333333';
const OTHER_MERCHANT = '44444444-4444-4444-8444-444444444444';
const SUB_MERCHANT = '55555555-5555-4555-8555-555555555555';

/**
 * `pay` is `OPEN_FULL` in the jurisdiction matrix — `full` verification is the
 * floor. `service: null` on both branches, always: a service credential is
 * orthogonal to a principal, and this whole surface is judged on WHICH MERCHANT
 * the caller is, which no service call carries.
 */
async function ctx(scopes: string[], userId = PLATFORM_USER): Promise<Context> {
  if (scopes.length === 0) return { principal: null, service: null, region: 'DE', requestId: 'req-1' };
  const { token } = await issueAccessToken(
    { userId, sessionId: '77777777-7777-4777-8777-777777777777', scopes, tier: 'full', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
}

function record(over: Record<string, unknown> = {}) {
  return {
    id: SUB_MERCHANT,
    userId: 'sub-account',
    parentMerchantId: PLATFORM_MERCHANT,
    mode: 'payfac' as const,
    status: 'pending' as const,
    kybStatus: 'none' as const,
    settlingParty: 'self',
    feeBps: 150,
    depth: 1,
    createdAt: new Date('2026-08-08T10:00:00.000Z'),
    ...over,
  };
}

/** What the service was actually asked, so the boundary can be measured. */
interface Seen {
  createActorMerchantId?: string;
  createActorId?: string;
  getActorMerchantId?: string;
  grantActorMerchantId?: string;
}

function harness(
  opts: {
    merchantForUser?: Record<string, { id: string } | null>;
    throws?: SubMerchantError;
  } = {},
) {
  const seen: Seen = {};
  const byUser = opts.merchantForUser ?? { [PLATFORM_USER]: { id: PLATFORM_MERCHANT } };

  const merchants: ActorMerchantLookup = {
    getMerchantByUserId: async (userId) => byUser[userId] ?? null,
  };

  const service = {
    createSubMerchant: async (input: { actorMerchantId: string; actorId: string }) => {
      if (opts.throws) throw opts.throws;
      seen.createActorMerchantId = input.actorMerchantId;
      seen.createActorId = input.actorId;
      return record();
    },
    listSubMerchants: async () => {
      if (opts.throws) throw opts.throws;
      return [record()];
    },
    getSubMerchant: async (actorMerchantId: string) => {
      if (opts.throws) throw opts.throws;
      seen.getActorMerchantId = actorMerchantId;
      return record();
    },
    grantPermission: async (input: { actorMerchantId: string }) => {
      if (opts.throws) throw opts.throws;
      seen.grantActorMerchantId = input.actorMerchantId;
      return {
        id: '66666666-6666-4666-8666-666666666666',
        seq: '1',
        granteeMerchantId: OTHER_MERCHANT,
        subjectMerchantId: SUB_MERCHANT,
        area: 'payment',
        action: 'grant' as const,
        reason: 'first-line disputes',
        actorId: PLATFORM_USER,
        actorMerchantId: PLATFORM_MERCHANT,
        actorScope: 'pay:write',
        createdAt: new Date('2026-08-08T10:00:00.000Z'),
      };
    },
    revokePermission: async () => {
      throw opts.throws ?? new Error('not exercised');
    },
    listPermissions: async () => {
      if (opts.throws) throw opts.throws;
      return [];
    },
    permissionHistory: async () => {
      if (opts.throws) throw opts.throws;
      return [];
    },
  } as unknown as SubMerchantService;

  return { caller: createSubMerchantRouter(service, merchants).createCaller, seen };
}

const createInput = {
  parentMerchantId: PLATFORM_MERCHANT,
  userId: 'a-brand-new-account',
  pricing: { feeBps: 150 },
};

describe('the acting node comes from the principal', () => {
  it('refuses submerchant.create until the named account consents', async () => {
    const { caller, seen } = harness();
    await expect(caller(await ctx(['pay:write'])).submerchant.create(createInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('pay.submerchant_consent_required'),
    });
    expect(seen.createActorMerchantId).toBeUndefined();
    expect(seen.createActorId).toBeUndefined();
  });

  it('does not adopt a smuggled actor on submerchant.create', async () => {
    const { caller, seen } = harness();
    await expect(
      caller(await ctx(['pay:write'])).submerchant.create({
        ...createInput,
        ...({ actorMerchantId: OTHER_MERCHANT } as Record<string, unknown>),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(seen.createActorMerchantId).toBeUndefined();
  });

  it('resolves a DIFFERENT principal to a different node — two merchants are never conflated', async () => {
    const { caller, seen } = harness({
      merchantForUser: { [PLATFORM_USER]: { id: PLATFORM_MERCHANT }, [STRANGER_USER]: { id: OTHER_MERCHANT } },
    });

    await caller(await ctx(['pay:read'], STRANGER_USER)).submerchant.get({ merchantId: SUB_MERCHANT });
    expect(seen.getActorMerchantId).toBe(OTHER_MERCHANT);
  });

  it('REFUSES A PRINCIPAL THAT IS NOT A MERCHANT — no standing in any tree', async () => {
    const { caller } = harness({ merchantForUser: {} });

    await expect(caller(await ctx(['pay:read'])).submerchant.list({ merchantId: PLATFORM_MERCHANT })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses an anonymous caller before any lookup happens', async () => {
    const { caller } = harness();
    await expect(caller(await ctx([])).submerchant.list({ merchantId: PLATFORM_MERCHANT })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses a merchant scope the procedure does not carry — reads may not write', async () => {
    const { caller } = harness();
    await expect(caller(await ctx(['pay:read'])).submerchant.create(createInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('refusals a merchant’s engineer can act on', () => {
  const cases: Array<[string, string]> = [
    ['pay.submerchant_out_of_scope', 'FORBIDDEN'],
    ['pay.submerchant_permission_denied', 'FORBIDDEN'],
    ['pay.submerchant_grant_lateral', 'FORBIDDEN'],
    ['pay.submerchant_too_deep', 'BAD_REQUEST'],
    ['pay.submerchant_settling_party_unsupported', 'BAD_REQUEST'],
    ['pay.submerchant_area_unknown', 'BAD_REQUEST'],
    ['pay.submerchant_user_already_merchant', 'CONFLICT'],
    ['pay.merchant_not_found', 'NOT_FOUND'],
  ];

  for (const [code, http] of cases) {
    it(`renders ${code} as ${http}`, async () => {
      const { caller } = harness({ throws: new SubMerchantError('refused', code) });
      await expect(caller(await ctx(['pay:read'])).submerchant.get({ merchantId: SUB_MERCHANT })).rejects.toMatchObject({
        code: http,
      });
    });
  }

  it('does NOT dress an unknown failure up as a caller mistake', async () => {
    // An unmapped code is a server fault. Reporting it as BAD_REQUEST would send
    // a merchant hunting for a bug in their integration that is not there.
    const { caller } = harness({ throws: new SubMerchantError('the tree walk exploded', 'pay.something_new') });
    await expect(caller(await ctx(['pay:read'])).submerchant.get({ merchantId: SUB_MERCHANT })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});

describe('the wire shape', () => {
  it('publishes the area vocabulary so a console does not keep its own stale copy', async () => {
    const { caller } = harness();
    const areas = await caller(await ctx(['pay:read'])).submerchantPermission.areas();
    expect(areas).toEqual([...PERMISSION_AREAS]);
  });

  it('refuses submerchant.create before a fee the caller chose can be stored', async () => {
    const { caller, seen } = harness();
    await expect(caller(await ctx(['pay:write'])).submerchant.create(createInput)).rejects.toMatchObject({
      message: expect.stringContaining('pay.submerchant_consent_required'),
    });
    expect(seen.createActorMerchantId).toBeUndefined();
  });

  it('requires a reason of substance on a grant — one character answers nothing', async () => {
    const { caller } = harness();
    await expect(
      caller(await ctx(['pay:write'])).submerchantPermission.grant({
        granteeMerchantId: OTHER_MERCHANT,
        subjectMerchantId: SUB_MERCHANT,
        area: 'payment',
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses an area outside the published vocabulary at the schema, before the service is called', async () => {
    const { caller } = harness();
    await expect(
      caller(await ctx(['pay:write'])).submerchantPermission.grant({
        granteeMerchantId: OTHER_MERCHANT,
        subjectMerchantId: SUB_MERCHANT,
        area: 'everything' as never,
        reason: 'because I said so',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses grant and revoke until the named account consents', async () => {
    const { caller, seen } = harness();
    const body = {
      granteeMerchantId: OTHER_MERCHANT,
      subjectMerchantId: SUB_MERCHANT,
      area: 'payment' as const,
      reason: 'first-line disputes for this cohort',
    };
    await expect(caller(await ctx(['pay:write'])).submerchantPermission.grant(body)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('pay.submerchant_consent_required'),
    });
    await expect(caller(await ctx(['pay:write'])).submerchantPermission.revoke(body)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('pay.submerchant_consent_required'),
    });
    expect(seen.grantActorMerchantId).toBeUndefined();
  });
});

import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { registerOwnerPayScopeRoute } from './merchant-owner-pay-scopes.js';
import type { OwnerPayScopeMerchant } from './merchant-pay-grant-path.js';

const SECRET = 'internal-secret-for-owner-grant-route-test';
const OWNER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';

const ELIGIBLE = { accountStatus: 'active', emailVerified: true, secondFactorEnrolled: true };

async function appFor(merchant: OwnerPayScopeMerchant | null) {
  const app = Fastify();
  registerOwnerPayScopeRoute(app, {
    internalSecret: SECRET,
    findOwnedMerchant: async (userId) => (merchant && merchant.userId === userId ? merchant : null),
  });
  await app.ready();
  return app;
}

function post(body: unknown) {
  const payload = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: '/internal/merchant-owner-pay-scopes',
    payload,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', SECRET, payload) },
  };
}

describe('POST /internal/merchant-owner-pay-scopes', () => {
  it('returns pay:read and pay:write for the approved owner of that merchant', async () => {
    const app = await appFor({ id: MERCHANT, userId: OWNER, kybStatus: 'approved', status: 'active' });
    const res = await app.inject(post({ userId: OWNER }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ merchantId: MERCHANT, scopes: ['pay:read', 'pay:write'] });
    await app.close();
  });

  it('returns no scopes when KYB is pending, the merchant is suspended, or the user owns nothing', async () => {
    const pending = await appFor({ id: MERCHANT, userId: OWNER, kybStatus: 'pending', status: 'active' });
    expect((await pending.inject(post({ userId: OWNER }))).json()).toEqual({ merchantId: MERCHANT, scopes: [] });
    await pending.close();

    const suspended = await appFor({ id: MERCHANT, userId: OWNER, kybStatus: 'approved', status: 'suspended' });
    expect((await suspended.inject(post({ userId: OWNER }))).json()).toEqual({ merchantId: MERCHANT, scopes: [] });
    await suspended.close();

    const none = await appFor(null);
    expect((await none.inject(post({ userId: OWNER }))).json()).toEqual({ merchantId: null, scopes: [] });
    await none.close();
  });

  it('refuses a caller without service credentials and a body that is not a user id', async () => {
    const app = await appFor(null);
    const open = await app.inject({ method: 'POST', url: '/internal/merchant-owner-pay-scopes', payload: { userId: OWNER } });
    expect(open.statusCode).toBe(401);
    const bad = await app.inject(post({ userId: 'not-a-user' }));
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('refuses a signed service other than svc-identity', async () => {
    const app = await appFor(null);
    const payload = JSON.stringify({ userId: OWNER, user: ELIGIBLE });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/merchant-owner-pay-scopes',
      payload,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-ledger', SECRET, payload) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('pay.owner_grant_service_forbidden');
    await app.close();
  });

  it('adds pay:onboard for an eligible user with no merchant, and for an approved root owner', async () => {
    const none = await appFor(null);
    const open = await none.inject(post({ userId: OWNER, user: ELIGIBLE }));
    expect(open.json()).toEqual({ merchantId: null, scopes: ['pay:onboard'] });
    await none.close();

    const approved = await appFor({
      id: MERCHANT,
      userId: OWNER,
      kybStatus: 'approved',
      status: 'active',
      parentMerchantId: null,
    });
    const both = await approved.inject(post({ userId: OWNER, user: ELIGIBLE }));
    expect(both.json().scopes).toEqual(['pay:read', 'pay:write', 'pay:onboard']);
    await approved.close();
  });

  it('does not add pay:onboard for a child, a suspended merchant, an ineligible user, or a missing snapshot', async () => {
    const child = await appFor({
      id: MERCHANT,
      userId: OWNER,
      kybStatus: 'approved',
      status: 'active',
      parentMerchantId: '33333333-3333-4333-8333-333333333333',
    });
    expect((await child.inject(post({ userId: OWNER, user: ELIGIBLE }))).json().scopes).toEqual(['pay:read', 'pay:write']);
    await child.close();

    const suspended = await appFor({
      id: MERCHANT,
      userId: OWNER,
      kybStatus: 'approved',
      status: 'suspended',
      parentMerchantId: null,
    });
    expect((await suspended.inject(post({ userId: OWNER, user: ELIGIBLE }))).json().scopes).toEqual([]);
    await suspended.close();

    const cold = await appFor(null);
    expect((await cold.inject(post({ userId: OWNER, user: { ...ELIGIBLE, secondFactorEnrolled: false } }))).json().scopes).toEqual([]);
    expect((await cold.inject(post({ userId: OWNER }))).json().scopes).toEqual([]);
    await cold.close();
  });
});

import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { registerOwnerPayScopeRoute } from './merchant-owner-pay-scopes.js';

const SECRET = 'internal-secret-for-owner-grant-route-test';
const OWNER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';

async function appFor(merchant: { id: string; userId: string; kybStatus: 'approved' | 'pending'; status: 'active' | 'suspended' } | null) {
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
});

import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { payStepUpPermissions, type MerchantRole } from './merchant-ops/roles.js';
import { registerPayStepUpGrantRoute } from './merchant-pay-step-up-grant.js';

const SECRET = 'internal-secret-for-pay-step-up-grant-test';
const OWNER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';

describe('pay step-up permissions', () => {
  it('gives refunds.create and payout.send to owner, admin, and finance only', () => {
    for (const role of ['owner', 'admin', 'finance'] as const) {
      expect(payStepUpPermissions(role)).toEqual({ 'refunds.create': true, 'payout.send': true });
    }
    for (const role of ['developer', 'viewer', null] as const) {
      expect(payStepUpPermissions(role)).toEqual({ 'refunds.create': false, 'payout.send': false });
    }
  });
});

async function appFor(role: MerchantRole | null) {
  const app = Fastify();
  registerPayStepUpGrantRoute(app, {
    internalSecret: SECRET,
    findRole: async () => role,
  });
  await app.ready();
  return app;
}

function post(body: unknown, service = 'svc-identity') {
  const payload = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: '/internal/merchant-pay-step-up-grant',
    payload,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
  };
}

describe('POST /internal/merchant-pay-step-up-grant', () => {
  it('returns the role permissions for the named merchant', async () => {
    const app = await appFor('finance');
    const res = await app.inject(post({ userId: OWNER, merchantId: MERCHANT }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      role: 'finance',
      permissions: { 'refunds.create': true, 'payout.send': true },
    });
    await app.close();
  });

  it('answers false for a viewer and for no seat, without saying which', async () => {
    const viewer = await appFor('viewer');
    expect((await viewer.inject(post({ userId: OWNER, merchantId: MERCHANT }))).json().permissions).toEqual({
      'refunds.create': false,
      'payout.send': false,
    });
    await viewer.close();
    const none = await appFor(null);
    expect((await none.inject(post({ userId: OWNER, merchantId: MERCHANT }))).json()).toEqual({
      role: null,
      permissions: { 'refunds.create': false, 'payout.send': false },
    });
    await none.close();
  });

  it('refuses an unsigned caller, another service, and a body that is not two uuids', async () => {
    const app = await appFor('owner');
    const open = await app.inject({
      method: 'POST',
      url: '/internal/merchant-pay-step-up-grant',
      payload: { userId: OWNER, merchantId: MERCHANT },
    });
    expect(open.statusCode).toBe(401);
    const other = await app.inject(post({ userId: OWNER, merchantId: MERCHANT }, 'svc-ledger'));
    expect(other.statusCode).toBe(403);
    const bad = await app.inject(post({ userId: OWNER, merchantId: 'not-a-merchant' }));
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});

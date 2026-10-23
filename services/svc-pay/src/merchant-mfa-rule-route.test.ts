import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { registerMerchantMfaRuleRoute } from './merchant-mfa-rule-route.js';
import type { MfaRuleForUser } from './merchant-ops/security.js';

const SECRET = 'internal-secret-for-merchant-mfa-rule-test';
const USER = '22222222-2222-4222-8222-222222222222';

async function appFor(rule: MfaRuleForUser, seen: string[] = []) {
  const app = Fastify();
  registerMerchantMfaRuleRoute(app, {
    internalSecret: SECRET,
    read: async (userId) => {
      seen.push(userId);
      return rule;
    },
  });
  await app.ready();
  return app;
}

function post(body: unknown, service = 'svc-identity') {
  const payload = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: '/internal/merchant-mfa-rule',
    payload,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
  };
}

describe('POST /internal/merchant-mfa-rule', () => {
  it('answers the rule for the named user, for each value', async () => {
    for (const rule of ['required', 'not_required', 'unset', 'none'] as const) {
      const seen: string[] = [];
      const app = await appFor(rule, seen);
      const res = await app.inject(post({ userId: USER }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ rule });
      expect(seen).toEqual([USER]);
      await app.close();
    }
  });

  it('refuses an unsigned caller, another service, and a userId that is not a uuid, without reading', async () => {
    const seen: string[] = [];
    const app = await appFor('required', seen);
    const open = await app.inject({ method: 'POST', url: '/internal/merchant-mfa-rule', payload: { userId: USER } });
    expect(open.statusCode).toBe(401);
    expect(open.json().error).toBe('pay.unauthenticated');
    const other = await app.inject(post({ userId: USER }, 'svc-ledger'));
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe('pay.mfa_rule_service_forbidden');
    const bad = await app.inject(post({ userId: 'not-a-user' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('pay.mfa_rule_invalid');
    const missing = await app.inject(post({}));
    expect(missing.statusCode).toBe(400);
    expect(seen).toEqual([]);
    await app.close();
  });
});

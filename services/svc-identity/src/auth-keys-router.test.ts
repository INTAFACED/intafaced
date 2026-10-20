import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { createAuthKeysRouter } from './auth-keys-router.js';
import type { AuthKeyRing } from './auth/auth-key-ring.js';

const config = {
  secret: 'an-auth-keys-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const ME = '11111111-1111-4111-8111-111111111111';
const SID = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const state = { activeKeyId: 'legacy', previousKeyIds: [], activatedAt: null, nextRemoval: null, availableKeyIds: ['legacy'] };
const ring = {
  state: async () => state,
  rotate: async () => state,
  removeOld: async () => state,
} as unknown as AuthKeyRing;

async function caller(opts: { mfa: boolean; founder: boolean; apiKey?: boolean }) {
  const { token } = await issueAccessToken(
    { userId: ME, sessionId: SID, scopes: ['identity:read'], tier: 'none', mfa: opts.mfa, ...(opts.apiKey ? { apiKeyId: KEY } : {}) },
    config,
  );
  const ctx = { principal: await verifyAccessToken(token, config), service: null, region: 'DE', requestId: 'r' };
  return createAuthKeysRouter(ring, { isFounder: async () => opts.founder }).createCaller(ctx as never);
}

describe('authKeys router door', () => {
  it('a live founder on a second-factor session reads state and no key material', async () => {
    const out = await (await caller({ mfa: true, founder: true })).authKeys.state();
    expect(out.activeKeyId).toBe('legacy');
  });

  it('refuses a non-founder, a session without a second factor and an API key', async () => {
    for (const c of [
      await caller({ mfa: true, founder: false }),
      await caller({ mfa: false, founder: true }),
      await caller({ mfa: true, founder: true, apiKey: true }),
    ]) {
      await expect(c.authKeys.state()).rejects.toMatchObject({ message: 'operator.denied' });
      await expect(c.authKeys.rotate({ keyId: 'k2', approvalId: 'a', operationId: 'o' })).rejects.toMatchObject({
        message: 'operator.denied',
      });
      await expect(c.authKeys.removeOld({ approvalId: 'a', operationId: 'o' })).rejects.toMatchObject({ message: 'operator.denied' });
    }
  });
});

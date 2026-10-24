import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from './tokens.js';

const config = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const FAMILY = '66666666-6666-4666-8666-666666666666';
const DEVICE = '77777777-7777-4777-8777-777777777777';

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (payload === undefined) throw new Error('JWT missing payload segment');
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
}

describe('fam and dev on access tokens', () => {
  it('carries the session family and the trusted device when given', async () => {
    const { token } = await issueAccessToken(
      { userId: USER, sessionId: SESSION, scopes: ['trade:read'], familyId: FAMILY, trustedDeviceId: DEVICE },
      config,
    );
    const principal = await verifyAccessToken(token, config);
    expect(principal.fam).toBe(FAMILY);
    expect(principal.dev).toBe(DEVICE);
  });

  it('leaves both out when not given or null, so absence never reads as a match', async () => {
    for (const extra of [{}, { familyId: null, trustedDeviceId: null }]) {
      const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'], ...extra }, config);
      const raw = decodePayload(token);
      expect(Object.prototype.hasOwnProperty.call(raw, 'fam')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(raw, 'dev')).toBe(false);
      const principal = await verifyAccessToken(token, config);
      expect(principal.fam).toBeUndefined();
      expect(principal.dev).toBeUndefined();
    }
  });

  it('refuses to mint a fam or dev that is not a UUID, or either one on an API-key token', async () => {
    const base = { userId: USER, sessionId: SESSION, scopes: ['trade:read'] };
    for (const extra of [{ familyId: '' }, { familyId: 'not-a-uuid' }, { trustedDeviceId: 'abc' }]) {
      await expect(issueAccessToken({ ...base, ...extra }, config)).rejects.toMatchObject({ code: 'token.invalid' });
    }
    const apiKeyId = '55555555-5555-4555-8555-555555555555';
    for (const extra of [{ familyId: FAMILY }, { trustedDeviceId: DEVICE }]) {
      await expect(issueAccessToken({ ...base, apiKeyId, ...extra }, config)).rejects.toMatchObject({ code: 'token.invalid' });
    }
  });

  it('refuses a token whose fam or dev is not a UUID', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [{ fam: 'not-a-uuid' }, { dev: 42 }]) {
      const token = await new SignJWT({ scopes: [], tier: 'none', mfa: false, sid: SESSION, ...bad })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(USER)
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(new TextEncoder().encode(config.secret));
      await expect(verifyAccessToken(token, config)).rejects.toMatchObject({ code: 'token.malformed' });
    }
  });
});

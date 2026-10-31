import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { STAFF_AREA_VERBS } from './staff-permissions.js';
import { issueAccessToken, verifyAccessToken } from './tokens.js';

const config = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const SUB = '66666666-6666-4666-8666-666666666666';

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (payload === undefined) throw new Error('JWT missing payload segment');
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
}

async function signRaw(extra: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scopes: [], tier: 'none', mfa: true, sid: SESSION, ...extra })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(USER)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(config.secret));
}

describe('staffPermissions and staffEnv on access tokens', () => {
  const base = { userId: USER, sessionId: SESSION, scopes: ['identity:read'] };

  it('carries the one-environment snapshot on an interactive session', async () => {
    const staffPermissions = ['accounts:read', 'staff:read'];
    const { token } = await issueAccessToken({ ...base, mfa: true, staffPermissions, staffEnv: 'production' }, config);
    const principal = await verifyAccessToken(token, config);
    expect(principal.staffPermissions).toEqual(staffPermissions);
    expect(principal.staffEnv).toBe('production');
  });

  it('leaves both claims out when the list is absent or empty, so absence means none', async () => {
    for (const extra of [{}, { staffPermissions: [] }, { staffPermissions: [], staffEnv: 'staging' }]) {
      const { token } = await issueAccessToken({ ...base, ...extra }, config);
      const raw = decodePayload(token);
      expect(Object.prototype.hasOwnProperty.call(raw, 'staffPermissions')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(raw, 'staffEnv')).toBe(false);
      const principal = await verifyAccessToken(token, config);
      expect(principal.staffPermissions).toBeUndefined();
      expect(principal.staffEnv).toBeUndefined();
    }
  });

  it('refuses to mint malformed or repeated entries, or a list without a valid staffEnv', async () => {
    for (const extra of [
      { staffPermissions: ['staff:accounts:read:production'], staffEnv: 'production' },
      { staffPermissions: ['accounts:all'], staffEnv: 'production' },
      { staffPermissions: ['accounts:read', 'accounts:read'], staffEnv: 'production' },
      { staffPermissions: [...STAFF_AREA_VERBS, 'accounts:read'], staffEnv: 'production' },
      { staffPermissions: ['accounts:read'] },
      { staffPermissions: ['accounts:read'], staffEnv: 'prod' },
    ]) {
      await expect(issueAccessToken({ ...base, ...extra }, config)).rejects.toMatchObject({ code: 'token.invalid' });
    }
  });

  it('refuses to mint it on an API-key or sub-account token', async () => {
    const staff = { staffPermissions: ['accounts:read'], staffEnv: 'production' };
    await expect(issueAccessToken({ ...base, apiKeyId: KEY, ...staff }, config)).rejects.toMatchObject({ code: 'token.invalid' });
    await expect(issueAccessToken({ ...base, subAccountId: SUB, ...staff }, config)).rejects.toMatchObject({ code: 'token.invalid' });
  });

  it('accepts every <area>:<verb> once and nothing more', async () => {
    const { token } = await issueAccessToken({ ...base, staffPermissions: [...STAFF_AREA_VERBS], staffEnv: 'local' }, config);
    expect((await verifyAccessToken(token, config)).staffPermissions).toHaveLength(STAFF_AREA_VERBS.length);
  });

  it('refuses a token whose claim is malformed, repeated or not a list', async () => {
    for (const bad of [
      { staffPermissions: ['ledger:all'], staffEnv: 'production' },
      { staffPermissions: ['staff:ledger:read:production'], staffEnv: 'production' },
      { staffPermissions: ['ledger:read', 'ledger:read'], staffEnv: 'production' },
      { staffPermissions: 'ledger:read', staffEnv: 'production' },
      { staffPermissions: [42], staffEnv: 'production' },
      { staffPermissions: ['ledger:read'], staffEnv: 'prod' },
    ]) {
      await expect(verifyAccessToken(await signRaw(bad), config)).rejects.toMatchObject({ code: 'token.malformed' });
    }
  });

  it('refuses staffPermissions without staffEnv, and staffEnv without staffPermissions', async () => {
    for (const bad of [{ staffPermissions: ['ledger:read'] }, { staffEnv: 'production' }]) {
      await expect(verifyAccessToken(await signRaw(bad), config)).rejects.toMatchObject({ code: 'token.malformed' });
    }
  });

  it('refuses the claim on a token that also carries kid or sub_account', async () => {
    const staff = { staffPermissions: ['ledger:read'], staffEnv: 'production' };
    for (const extra of [{ kid: KEY }, { sub_account: SUB }]) {
      await expect(verifyAccessToken(await signRaw({ ...staff, ...extra }), config)).rejects.toMatchObject({ code: 'token.malformed' });
      // The same token without the staff claim verifies, so the refusal is the combination.
      await expect(verifyAccessToken(await signRaw(extra), config)).resolves.toMatchObject({ userId: USER });
    }
  });
});

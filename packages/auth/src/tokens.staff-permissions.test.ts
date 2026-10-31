import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { STAFF_PERMISSIONS } from './staff-permissions.js';
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

describe('staffPermissions on access tokens', () => {
  const base = { userId: USER, sessionId: SESSION, scopes: ['identity:read'] };

  it('carries the snapshot on an interactive session', async () => {
    const staffPermissions = ['staff:accounts:read:production', 'staff:staff:read:production'];
    const { token } = await issueAccessToken({ ...base, mfa: true, staffPermissions }, config);
    const principal = await verifyAccessToken(token, config);
    expect(principal.staffPermissions).toEqual(staffPermissions);
  });

  it('leaves the claim out when none is given or the list is empty, so absence means none', async () => {
    for (const extra of [{}, { staffPermissions: [] }]) {
      const { token } = await issueAccessToken({ ...base, ...extra }, config);
      expect(Object.prototype.hasOwnProperty.call(decodePayload(token), 'staffPermissions')).toBe(false);
      expect((await verifyAccessToken(token, config)).staffPermissions).toBeUndefined();
    }
  });

  it('refuses to mint malformed or repeated entries', async () => {
    for (const staffPermissions of [
      ['staff:accounts:read'],
      ['admin:write'],
      ['staff:accounts:read:production', 'staff:accounts:read:production'],
      [...STAFF_PERMISSIONS, 'staff:accounts:read:production'],
    ]) {
      await expect(issueAccessToken({ ...base, staffPermissions }, config)).rejects.toMatchObject({ code: 'token.invalid' });
    }
  });

  it('refuses to mint it on an API-key or sub-account token', async () => {
    const staffPermissions = ['staff:accounts:read:production'];
    await expect(issueAccessToken({ ...base, apiKeyId: KEY, staffPermissions }, config)).rejects.toMatchObject({ code: 'token.invalid' });
    await expect(issueAccessToken({ ...base, subAccountId: SUB, staffPermissions }, config)).rejects.toMatchObject({
      code: 'token.invalid',
    });
  });

  it('accepts the whole catalogue and nothing more', async () => {
    const { token } = await issueAccessToken({ ...base, staffPermissions: [...STAFF_PERMISSIONS] }, config);
    expect((await verifyAccessToken(token, config)).staffPermissions).toHaveLength(STAFF_PERMISSIONS.length);
  });

  it('refuses a token whose claim is malformed, repeated or not a list', async () => {
    for (const bad of [
      { staffPermissions: ['staff:ledger:all:production'] },
      { staffPermissions: ['staff:ledger:read:production', 'staff:ledger:read:production'] },
      { staffPermissions: 'staff:ledger:read:production' },
      { staffPermissions: [42] },
    ]) {
      await expect(verifyAccessToken(await signRaw(bad), config)).rejects.toMatchObject({ code: 'token.malformed' });
    }
  });
});

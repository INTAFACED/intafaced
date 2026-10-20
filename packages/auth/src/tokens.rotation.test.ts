import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken, type TokenConfig } from './tokens.js';

const base = { issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };
const OLD = 'old-signing-secret-that-is-long-enough-xx';
const NEW = 'new-signing-secret-that-is-long-enough-xx';
const input = {
  userId: '33333333-3333-4333-8333-333333333333',
  sessionId: '44444444-4444-4444-8444-444444444444',
  scopes: ['trade:read'],
};

function header(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;
}

describe('access-token signing-key rotation', () => {
  const before: TokenConfig = { ...base, secret: OLD, keyId: 'k1' };
  const during: TokenConfig = { ...base, secret: NEW, keyId: 'k2', verifyOnly: [{ keyId: 'k1', secret: OLD }] };
  const after: TokenConfig = { ...base, secret: NEW, keyId: 'k2' };

  it('new tokens carry the new key id and old tokens still verify during the overlap', async () => {
    const oldToken = (await issueAccessToken(input, before)).token;
    const newToken = (await issueAccessToken(input, during)).token;
    expect(header(newToken).kid).toBe('k2');
    await expect(verifyAccessToken(oldToken, during)).resolves.toMatchObject({ userId: input.userId });
    await expect(verifyAccessToken(newToken, during)).resolves.toMatchObject({ userId: input.userId });
  });

  it('after the old key is removed, its tokens fail', async () => {
    const oldToken = (await issueAccessToken(input, before)).token;
    await expect(verifyAccessToken(oldToken, after)).rejects.toMatchObject({ code: 'token.invalid' });
  });

  it('a token signed before ids existed verifies against a verify-only key', async () => {
    const legacy = (await issueAccessToken(input, { ...base, secret: OLD })).token;
    expect(header(legacy).kid).toBeUndefined();
    await expect(verifyAccessToken(legacy, { ...during, verifyOnly: [{ keyId: 'k1', secret: OLD }] })).resolves.toBeDefined();
    await expect(verifyAccessToken(legacy, after)).rejects.toMatchObject({ code: 'token.invalid' });
  });

  it('a token naming an unknown key id is refused, and a short key is refused', async () => {
    const t = (await issueAccessToken(input, { ...base, secret: NEW, keyId: 'ghost' })).token;
    await expect(verifyAccessToken(t, during)).rejects.toMatchObject({ code: 'token.invalid' });
    await expect(verifyAccessToken(t, { ...base, secret: 'short', keyId: 'ghost' })).rejects.toMatchObject({ code: 'token.invalid' });
  });

  it('an expired token still reports expiry under a ring', async () => {
    const t = (await issueAccessToken(input, { ...during, accessTtlSeconds: -10 })).token;
    await expect(verifyAccessToken(t, during)).rejects.toMatchObject({ code: 'token.expired' });
  });
});

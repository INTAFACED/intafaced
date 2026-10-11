import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER } from '@intafaced/contracts';
import { exchangePrincipal } from './principal-exchange.js';
import { recoveredMintKeyRevokeRefusesSession } from './recovery-mint-key-revoke-session.js';
import { currentAuthorityInputSchema } from '@intafaced/contracts';
import { currentAuthorityTestReply } from './test-current-authority.js';

const tokens: TokenConfig = {
  secret: 'edge-test-jwt-signing-secret-32-chars',
  issuer: 'intafaced',
  audience: 'intafaced',
  accessTtlSeconds: 900,
};

const EDGE_SECRET = 'edge-test-principal-secret-32-chars!';
const OWNERSHIP_SECRET = 'edge-test-identity-ownership-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const KEEP = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

const options = {
  tokens,
  edgeSecret: EDGE_SECRET,
  region: 'GB',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: OWNERSHIP_SECRET,
};

const liveOpts = {
  identityUrl: 'http://identity.test',
  apiKeyId: KEY,
  userId: USER,
  identityOwnershipSecret: OWNERSHIP_SECRET,
};

async function access(apiKeyId?: string): Promise<string> {
  const issued = await issueAccessToken(
    { userId: USER, sessionId: KEEP, scopes: ['trade:read'], tier: 'basic', mfa: false, ...(apiKeyId ? { apiKeyId } : {}) },
    tokens,
  );
  return issued.token;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recoveredMintFetch(): { fetch: typeof fetch; revokeKey: () => void } {
  const state = { keyRevoked: false };
  return {
    revokeKey() {
      state.keyRevoked = true;
    },
    fetch: async (input, init) => {
      if (String(input).endsWith('/trpc/accountControls.currentAuthority')) {
        const subject = currentAuthorityInputSchema.parse(JSON.parse(String(init?.body)) as unknown);
        const expectedCredentialId = subject.credential.kind === 'session' ? KEEP : KEY;
        const authority = currentAuthorityTestReply(input, init, {
          expectedUserId: USER,
          expectedCredentialId,
          credentialRevoked: subject.credential.kind === 'api_key' && state.keyRevoked,
        });
        if (authority) return authority;
      }
      const url = String(input);
      if (url.includes('/internal/account/')) {
        return json({ userId: USER, status: 'active', kycTier: 'none', lastVerifiedAt: '2026-08-25T00:00:00.000Z' });
      }
      if (url.includes('/internal/api-keys/')) {
        return json({ id: KEY, userId: USER, revoked: state.keyRevoked });
      }
      return json({ id: KEEP, userId: USER, revoked: false });
    },
  };
}

describe('revoked recovered-session API key is refused at the HTTP session door', () => {
  it('refuses the door drop while the recovered-session key is still live', async () => {
    const seats = recoveredMintFetch();
    await expect(recoveredMintKeyRevokeRefusesSession({ ...liveOpts, fetch: seats.fetch })).rejects.toMatchObject({
      code: 'auth.api_key_live',
    });
  });

  it('recovered session stays admitted; the minted key is refused after it is revoked', async () => {
    const seats = recoveredMintFetch();
    const sessionToken = await access();
    const keyToken = await access(KEY);
    const keepLive = await exchangePrincipal({ authorization: `Bearer ${sessionToken}` }, { ...options, fetch: seats.fetch });
    const keyLive = await exchangePrincipal({ authorization: `Bearer ${keyToken}` }, { ...options, fetch: seats.fetch });
    expect(keepLive.rejected).toBeNull();
    expect(keepLive.principal?.userId).toBe(USER);
    expect(keepLive.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
    expect(keyLive.rejected).toBeNull();
    expect(keyLive.principal?.kid).toBe(KEY);
    expect(keyLive.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();

    seats.revokeKey();
    await expect(recoveredMintKeyRevokeRefusesSession({ ...liveOpts, fetch: seats.fetch })).resolves.toBeUndefined();

    const keepAfter = await exchangePrincipal({ authorization: `Bearer ${sessionToken}` }, { ...options, fetch: seats.fetch });
    const keyAfter = await exchangePrincipal({ authorization: `Bearer ${keyToken}` }, { ...options, fetch: seats.fetch });
    expect(keepAfter.rejected).toBeNull();
    expect(keepAfter.principal?.userId).toBe(USER);
    expect(keepAfter.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
    expect(keyAfter.rejected).toBe('invalid');
    expect(keyAfter.principal).toBeNull();
    expect(keyAfter.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });
});

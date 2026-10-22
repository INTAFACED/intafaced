import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER } from '@intafaced/contracts';
import { exchangePrincipal } from './principal-exchange.js';

const tokens: TokenConfig = {
  secret: 'edge-test-jwt-signing-secret-32-chars',
  issuer: 'intafaced',
  audience: 'intafaced',
  accessTtlSeconds: 900,
};

const EDGE_SECRET = 'edge-test-principal-secret-32-chars!';
const OWNERSHIP_SECRET = 'edge-test-identity-ownership-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const VERIFIED_AT = '2026-08-25T00:00:00.000Z';

const options = {
  tokens,
  edgeSecret: EDGE_SECRET,
  region: 'GB',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: OWNERSHIP_SECRET,
};

async function accessToken(apiKeyId?: string): Promise<string> {
  const issued = await issueAccessToken(
    { userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false, ...(apiKeyId ? { apiKeyId } : {}) },
    tokens,
  );
  return issued.token;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchIdentity(account: Record<string, unknown>, accountHttp = 200): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/internal/account/')) {
      if (accountHttp !== 200) return new Response(null, { status: accountHttp });
      return json({ userId: USER, status: 'active', kycTier: 'none', ...account });
    }
    expect(url).toContain(`/internal/sessions/${SESSION}`);
    return json({ id: SESSION, userId: USER, revoked: false });
  };
}

describe('enrolled passkey at the HTTP session door', () => {
  it('lastVerifiedAt on account places', async () => {
    const token = await accessToken();
    const live = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchIdentity({ lastVerifiedAt: VERIFIED_AT }) },
    );
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
  });

  it('empty webauthnCreds cannot place', async () => {
    const token = await accessToken();
    const dead = await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...options, fetch: fetchIdentity({ webauthnCreds: [] }) });
    expect(dead.rejected).toBe('invalid');
    expect(dead.principal).toBeNull();
    expect(dead.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('account without passkey fields refuses as verify unavailable', async () => {
    const token = await accessToken();
    const dead = await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...options, fetch: fetchIdentity({}) });
    expect(dead.rejected).toBe('invalid');
    expect(dead.principal).toBeNull();
    expect(dead.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity 500 on account cannot place', async () => {
    const token = await accessToken();
    const dead = await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...options, fetch: fetchIdentity({}, 500) });
    expect(dead.rejected).toBe('invalid');
    expect(dead.principal).toBeNull();
    expect(dead.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('an API-key bearer still places without passkey fields', async () => {
    const keyJwt = await accessToken(KEY);
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_live' },
      {
        ...options,
        fetch: async (input) => {
          expect(String(input)).toContain('/trpc/apiKeys.exchange');
          expect(String(input)).not.toContain('/internal/sessions/');
          expect(String(input)).not.toContain('/internal/account/');
          return json({ result: { data: { json: { accessToken: keyJwt } } } });
        },
      },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
  });

  it('missing ownership secret stays on JWT (no invented live-check)', async () => {
    const token = await accessToken();
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { tokens, edgeSecret: EDGE_SECRET, region: 'GB', identityUrl: 'http://identity.test' },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });
});

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

function fetchIdentity(opts: { sessionRevoked?: boolean; keyRevoked?: boolean; status?: string; accountHttp?: number }): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/internal/account/')) {
      expect(url).toContain(`/internal/account/${USER}`);
      if (opts.accountHttp) return new Response(null, { status: opts.accountHttp });
      return json({ userId: USER, status: opts.status ?? 'active', kycTier: 'none', lastVerifiedAt: '2026-08-25T00:00:00.000Z' });
    }
    if (url.includes('/internal/api-keys/')) {
      return json({ id: KEY, userId: USER, revoked: opts.keyRevoked === true });
    }
    expect(url).toContain(`/internal/sessions/${SESSION}`);
    return json({ id: SESSION, userId: USER, revoked: opts.sessionRevoked === true });
  };
}

describe('disabled / panic-revoked user at the HTTP session door', () => {
  it('active user proceeds; frozen and closed cannot open a NEW session', async () => {
    const token = await accessToken();
    const live = await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...options, fetch: fetchIdentity({ status: 'active' }) });
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();

    const frozen = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchIdentity({ status: 'frozen' }) },
    );
    expect(frozen.rejected).toBe('invalid');
    expect(frozen.principal).toBeNull();
    expect(frozen.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();

    const closed = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchIdentity({ status: 'closed' }) },
    );
    expect(closed.rejected).toBe('invalid');
    expect(closed.principal).toBeNull();
  });

  it('panic-revoked session cannot open a NEW session (consume identity revoked)', async () => {
    const token = await accessToken();
    const dead = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchIdentity({ sessionRevoked: true, status: 'active' }) },
    );
    expect(dead.rejected).toBe('invalid');
    expect(dead.principal).toBeNull();
    expect(dead.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity freeze refuse (403) cannot open a NEW session', async () => {
    const token = await accessToken();
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchIdentity({ accountHttp: 403 }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
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

  it('a key-minted JWT also consumes identity status', async () => {
    const token = await accessToken(KEY);
    const frozen = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchIdentity({ keyRevoked: false, status: 'frozen' }) },
    );
    expect(frozen.rejected).toBe('invalid');
    expect(frozen.principal).toBeNull();

    const live = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchIdentity({ keyRevoked: false, status: 'active' }) },
    );
    expect(live.rejected).toBeNull();
    expect(live.principal?.kid).toBe(KEY);
  });
});

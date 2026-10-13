import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER } from '@intafaced/contracts';
import { exchangePrincipal } from './principal-exchange.js';
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

function fetchSession(opts: { revoked: boolean; expectPath?: string }): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, {
      expectedUserId: USER,
      expectedCredentialId: SESSION,
      credentialRevoked: opts.revoked,
    });
    if (authority) return authority;
    const url = String(input);
    if (url.includes('/internal/account/')) {
      return new Response(JSON.stringify({ userId: USER, status: 'active', kycTier: 'none', lastVerifiedAt: '2026-08-25T00:00:00.000Z' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (opts.expectPath) expect(url).toContain(opts.expectPath);
    return new Response(JSON.stringify({ id: SESSION, userId: USER, revoked: opts.revoked }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('revoked session at the HTTP session door', () => {
  it('active session proceeds; revoked cannot open a session', async () => {
    const token = await accessToken();
    const live = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchSession({ revoked: false, expectPath: `/internal/sessions/${SESSION}` }) },
    );
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();

    const dead = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchSession({ revoked: true, expectPath: `/internal/sessions/${SESSION}` }) },
    );
    expect(dead.rejected).toBe('invalid');
    expect(dead.principal).toBeNull();
    expect(dead.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity revoke refuse (401) cannot open a session', async () => {
    const token = await accessToken();
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: async () => new Response(JSON.stringify({ error: { message: 'Session is revoked' } }), { status: 401 }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity 403 cannot open a session', async () => {
    const token = await accessToken();
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: async () => new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
  });

  it('missing dedicated authority key refuses authenticated forwarding', async () => {
    const token = await accessToken();
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { tokens, edgeSecret: EDGE_SECRET, region: 'GB', identityUrl: 'http://identity.test' },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
  });

  it('an API-key bearer is not refused when the session snapshot is revoked', async () => {
    const keyJwt = await accessToken(KEY);
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_live' },
      {
        ...options,
        fetch: async (input, init) => {
          const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: KEY });
          if (authority) return authority;
          if (String(input).includes('/internal/api-keys/')) {
            return new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          expect(String(input)).toContain('/trpc/apiKeys.exchange');
          return new Response(JSON.stringify({ result: { data: { json: { accessToken: keyJwt } } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
  });
});

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
const LISTED = '203.0.113.10';
const FOREIGN = '198.51.100.9';

const options = {
  tokens,
  edgeSecret: EDGE_SECRET,
  region: 'GB',
  identityUrl: 'https://identity.test',
  identityOwnershipSecret: OWNERSHIP_SECRET,
};

async function accessToken(apiKeyId?: string): Promise<string> {
  const issued = await issueAccessToken(
    { userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false, ...(apiKeyId ? { apiKeyId } : {}) },
    tokens,
  );
  return issued.token;
}

function fetchWith(ipAllowlist?: string[]): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
    if (authority) return authority;
    const token = await accessToken();
    const json: Record<string, unknown> = { accessToken: token };
    if (ipAllowlist !== undefined) json.ipAllowlist = ipAllowlist;
    return new Response(JSON.stringify({ result: { data: { json } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('API key IP allowlist at the session door', () => {
  it('strips a client-supplied x-forwarded-for / x-real-ip', async () => {
    const result = await exchangePrincipal(
      {
        authorization: 'Bearer ifc_stolen',
        'x-forwarded-for': FOREIGN,
        'x-real-ip': FOREIGN,
      },
      { ...options, fetch: async () => new Response(null, { status: 401 }) },
    );
    expect(result.headers['x-forwarded-for']).toBeUndefined();
    expect(result.headers['x-real-ip']).toBeUndefined();
    expect(result.rejected).toBe('invalid');
  });

  it('forwards the server-resolved IP to identity exchange, never the client spoof', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await exchangePrincipal(
      {
        authorization: 'Bearer ifc_live_secret',
        'x-forwarded-for': FOREIGN,
        origin: 'https://app.example.com',
      },
      {
        ...options,
        clientIp: LISTED,
        fetch: async (input, init) => {
          seen.url = String(input);
          seen.headers = new Headers(init?.headers);
          return new Response(null, { status: 401 });
        },
      },
    );
    expect(seen.url).toContain('/trpc/apiKeys.exchange');
    expect(seen.headers?.get('x-forwarded-for')).toBe(LISTED);
    expect(seen.headers?.get('x-real-ip')).toBe(LISTED);
    expect(seen.headers?.get('origin')).toBe('https://app.example.com');
  });

  it('rewrites forwarded IP from options.clientIp and drops a forged hop', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_live_secret', 'x-forwarded-for': FOREIGN },
      { ...options, clientIp: LISTED, fetch: async () => new Response(null, { status: 401 }) },
    );
    expect(result.headers['x-forwarded-for']).toBe(LISTED);
    expect(result.headers['x-real-ip']).toBe(LISTED);
  });

  it('refuses an invented CIDR as clientIp', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_live_secret' },
      { ...options, clientIp: '10.0.0.0/8', fetch: async () => new Response(null, { status: 401 }) },
    );
    expect(result.headers['x-forwarded-for']).toBeUndefined();
  });

  it('matching IP proceeds; foreign IP cannot open a session', async () => {
    const live = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound' },
      { ...options, clientIp: LISTED, fetch: fetchWith([LISTED]) },
    );
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();

    const foreign = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound' },
      { ...options, clientIp: FOREIGN, fetch: fetchWith([LISTED]) },
    );
    expect(foreign.rejected).toBe('invalid');
    expect(foreign.principal).toBeNull();
    expect(foreign.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('empty list stays open (no invented loopback)', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_open' }, { ...options, clientIp: FOREIGN, fetch: fetchWith([]) });
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
    expect(result.headers['x-forwarded-for']).toBe(FOREIGN);
    expect(result.headers['x-forwarded-for']).not.toBe('127.0.0.1');
  });

  it('missing list stays open (identity omits it on a live exchange)', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_open' }, { ...options, fetch: fetchWith() });
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });

  it('missing IP when the list is set refuses', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_bound' }, { ...options, fetch: fetchWith([LISTED]) });
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity IP refuse (401) cannot open a session', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound' },
      {
        ...options,
        clientIp: FOREIGN,
        fetch: async () => new Response(JSON.stringify({ error: { message: 'API key is not allowed from this IP' } }), { status: 401 }),
      },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('client x-forwarded-for cannot stand in for the server IP', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_stolen', 'x-forwarded-for': LISTED },
      { ...options, fetch: fetchWith([LISTED]) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers['x-forwarded-for']).toBeUndefined();
  });

  it('a key-minted JWT consumes identity ipAllowlist on the ownership snapshot', async () => {
    const token = await accessToken(KEY);
    const live = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      {
        ...options,
        clientIp: LISTED,
        identityOwnershipSecret: OWNERSHIP_SECRET,
        fetch: async (input, init) => {
          const url = String(input);
          const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: KEY });
          if (authority) return authority;
          if (url.includes('/internal/api-keys/'))
            return new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false, ipAllowlist: [LISTED] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          if (url.includes('/internal/account/')) {
            return new Response(JSON.stringify({ userId: USER, status: 'active', kycTier: 'none' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          expect(url).toContain(`/internal/api-keys/${KEY}`);
          return new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false, ipAllowlist: [LISTED] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    expect(live.rejected).toBeNull();
    expect(live.principal?.kid).toBe(KEY);

    const foreign = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      {
        ...options,
        clientIp: FOREIGN,
        identityOwnershipSecret: OWNERSHIP_SECRET,
        fetch: async (input, init) => {
          const url = String(input);
          const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: KEY });
          if (authority) return authority;
          if (url.includes('/internal/api-keys/'))
            return new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false, ipAllowlist: [LISTED] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          if (url.includes('/internal/account/')) {
            return new Response(JSON.stringify({ userId: USER, status: 'active', kycTier: 'none' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false, ipAllowlist: [LISTED] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    expect(foreign.rejected).toBe('invalid');
    expect(foreign.principal).toBeNull();
    expect(foreign.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });
});

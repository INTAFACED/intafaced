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
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const LISTED = 'trade';
const FOREIGN = 'pay';

const options = {
  tokens,
  edgeSecret: EDGE_SECRET,
  region: 'GB',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: 'edge-test-identity-authority-secret-32',
};

async function accessToken(): Promise<string> {
  const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false }, tokens);
  return issued.token;
}

function fetchWith(opts: { productScopes?: string[]; expectPath?: string; expectProduct?: string } = {}): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
    if (authority) return authority;
    if (opts.expectPath) expect(String(input)).toContain(opts.expectPath);
    const body = JSON.parse(String(init?.body)) as { json?: { key?: string; product?: string } };
    if (opts.expectProduct !== undefined) expect(body.json?.product).toBe(opts.expectProduct);
    const token = await accessToken();
    const json: Record<string, unknown> = { accessToken: token };
    if (opts.productScopes !== undefined) json.productScopes = opts.productScopes;
    return new Response(JSON.stringify({ result: { data: { json } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('API key product/module scope at the session door', () => {
  it('matching product proceeds; foreign product cannot open a session', async () => {
    const live = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', 'x-product': LISTED },
      { ...options, fetch: fetchWith({ productScopes: [LISTED], expectPath: '/trpc/exchangeApiKeyForProduct', expectProduct: LISTED }) },
    );
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();

    const foreign = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', 'x-product': FOREIGN },
      { ...options, fetch: fetchWith({ productScopes: [LISTED], expectPath: '/trpc/exchangeApiKeyForProduct', expectProduct: FOREIGN }) },
    );
    expect(foreign.rejected).toBe('invalid');
    expect(foreign.principal).toBeNull();
    expect(foreign.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('empty list stays grantor intersection (no invented default product)', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_open', 'x-product': FOREIGN },
      { ...options, fetch: fetchWith({ productScopes: [], expectPath: '/trpc/exchangeApiKeyForProduct', expectProduct: FOREIGN }) },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
    expect(result.headers['x-product']).toBe(FOREIGN);
    expect(result.headers['x-product']).not.toBe('trade');
  });

  it('missing list stays open (identity omits it on a live exchange)', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_open' },
      { ...options, fetch: fetchWith({ expectPath: '/trpc/apiKeys.exchange' }) },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });

  it('missing product when the list is set refuses', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound' },
      { ...options, fetch: fetchWith({ productScopes: [LISTED], expectPath: '/trpc/apiKeys.exchange' }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity product refuse (401) cannot open a session', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', 'x-product': FOREIGN },
      {
        ...options,
        fetch: async () => new Response(JSON.stringify({ error: { message: 'API key is not allowed for this product' } }), { status: 401 }),
      },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('client x-intafaced-product cannot stand in for x-product', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_stolen', 'x-intafaced-product': LISTED },
      { ...options, fetch: fetchWith({ productScopes: [LISTED], expectPath: '/trpc/apiKeys.exchange' }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers['x-intafaced-product']).toBeUndefined();
  });

  it('forwards x-product to identity exchange; never a reserved header', async () => {
    const seen: { url?: string; headers?: Headers; body?: { json?: { product?: string } } } = {};
    await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', 'x-product': LISTED, 'x-intafaced-product': FOREIGN },
      {
        ...options,
        fetch: async (input, init) => {
          seen.url = String(input);
          seen.headers = new Headers(init?.headers);
          seen.body = JSON.parse(String(init?.body)) as { json?: { product?: string } };
          return new Response(null, { status: 401 });
        },
      },
    );
    expect(seen.url).toContain('/trpc/exchangeApiKeyForProduct');
    expect(seen.headers?.get('x-product')).toBe(LISTED);
    expect(seen.headers?.get('x-intafaced-product')).toBeNull();
    expect(seen.body?.json?.product).toBe(LISTED);
  });

  it('unbound key with a named product still proceeds (does not invent a bind)', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_open', 'x-product': LISTED },
      { ...options, fetch: fetchWith({ expectPath: '/trpc/exchangeApiKeyForProduct', expectProduct: LISTED }) },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });
});

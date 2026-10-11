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
const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

function fetchOk(opts: { accountId?: string; expectPath?: string; expectAccount?: string }): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
    if (authority) return authority;
    if (opts.expectPath) expect(String(input)).toContain(opts.expectPath);
    const body = JSON.parse(String(init?.body)) as { json?: { key?: string; accountId?: string } };
    if (opts.expectAccount !== undefined) expect(body.json?.accountId).toBe(opts.expectAccount);
    const token = await accessToken();
    const json: Record<string, unknown> = { accessToken: token };
    if (opts.accountId) json.accountId = opts.accountId;
    return new Response(JSON.stringify({ result: { data: { json } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('API key account bind at the session door', () => {
  it('matching account proceeds via exchangeApiKeyForAccount', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', 'x-account-id': ACC },
      { ...options, fetch: fetchOk({ accountId: ACC, expectPath: '/trpc/exchangeApiKeyForAccount', expectAccount: ACC }) },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
  });

  it('bound key + a different account refuses', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', 'x-account-id': OTHER },
      { ...options, fetch: fetchOk({ accountId: ACC, expectPath: '/trpc/exchangeApiKeyForAccount', expectAccount: OTHER }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity mismatch (401) refuses', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', 'x-account-id': OTHER },
      { ...options, fetch: async () => new Response(null, { status: 401 }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
  });

  it('missing account when the key is bound refuses', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound' },
      { ...options, fetch: fetchOk({ accountId: ACC, expectPath: '/trpc/apiKeys.exchange' }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('unbound keys keep prior behavior (apiKeys.exchange, no invented bind)', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_open' },
      { ...options, fetch: fetchOk({ expectPath: '/trpc/apiKeys.exchange' }) },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });

  it('unbound key with a named account still proceeds (does not invent a bind)', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_open', 'x-account-id': ACC },
      { ...options, fetch: fetchOk({ expectPath: '/trpc/exchangeApiKeyForAccount', expectAccount: ACC }) },
    );
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });
});

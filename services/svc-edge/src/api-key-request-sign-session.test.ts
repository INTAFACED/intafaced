import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER } from '@intafaced/contracts';
import { exchangePrincipal } from './principal-exchange.js';
import { currentAuthorityTestReply } from './test-current-authority.js';
import { REQUEST_NONCE_HEADER, REQUEST_SIGNATURE_HEADER, REQUEST_TIMESTAMP_HEADER } from './api-key-request-sign.js';

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
  identityUrl: 'https://identity.test',
  identityOwnershipSecret: OWNERSHIP_SECRET,
};

async function accessToken(apiKeyId?: string): Promise<string> {
  const issued = await issueAccessToken(
    { userId: USER, sessionId: SESSION, scopes: ['pay:read'], tier: 'basic', mfa: false, ...(apiKeyId ? { apiKeyId } : {}) },
    tokens,
  );
  return issued.token;
}

function fetchExchange(json: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
    if (authority) return authority;
    const token = await accessToken();
    return new Response(JSON.stringify({ result: { data: { json: { accessToken: token, ...json } } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('API key request signature at the session door', () => {
  it('accepts an unsigned key that has not opted in', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_open' }, { ...options, fetch: fetchExchange({}) });
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });

  it('refuses an unsigned call when the exchange says the key requires a signature', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_signed' },
      { ...options, fetch: fetchExchange({ requireSignature: true }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('sends the request signature to identity and accepts when the headers are present', async () => {
    let seen: unknown;
    const result = await exchangePrincipal(
      {
        authorization: 'Bearer ifc_signed',
        [REQUEST_TIMESTAMP_HEADER]: '1700000000',
        [REQUEST_NONCE_HEADER]: 'nonce-fresh-1',
        [REQUEST_SIGNATURE_HEADER]: 'ab'.repeat(32),
      },
      {
        ...options,
        request: { method: 'POST', path: '/api/pay/v1/payments', body: '{"amount":"1.10"}' },
        fetch: async (input, init) => {
          const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
          if (authority) return authority;
          seen = JSON.parse(String(init?.body));
          const token = await accessToken();
          return new Response(JSON.stringify({ result: { data: { json: { accessToken: token, requireSignature: true } } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    expect(result.rejected).toBeNull();
    const body = seen as { request: { method: string; path: string; bodyHash: string; signature: string } };
    expect(body.request.method).toBe('POST');
    expect(body.request.path).toBe('/api/pay/v1/payments');
    expect(body.request.signature).toBe('ab'.repeat(32));
    expect(body.request.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('attests the signed request as svc-edge when the ownership key is configured', async () => {
    let service = '';
    await exchangePrincipal(
      {
        authorization: 'Bearer ifc_signed',
        [REQUEST_TIMESTAMP_HEADER]: '1700000000',
        [REQUEST_NONCE_HEADER]: 'nonce-fresh-1',
        [REQUEST_SIGNATURE_HEADER]: 'ab'.repeat(32),
      },
      {
        ...options,
        request: { method: 'POST', path: '/api/pay/v1/payments', body: '{"amount":"1.10"}' },
        fetch: async (input, init) => {
          const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
          if (authority) return authority;
          const headers = new Headers(init?.headers);
          service = headers.get('x-intafaced-service') ?? '';
          const token = await accessToken();
          return new Response(JSON.stringify({ result: { data: { json: { accessToken: token, requireSignature: true } } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );
    expect(service).toBe('svc-edge');
  });

  it('refuses a key that requires a non-empty IP allowlist when the list is empty', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_open' },
      { ...options, clientIp: '203.0.113.10', fetch: fetchExchange({ requireNonEmptyIpAllowlist: true, ipAllowlist: [] }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
  });

  it('refuses a pre-minted JWT for a key that requires a signature', async () => {
    const token = await accessToken(KEY);
    const result = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      {
        ...options,
        fetch: async (input, init) => {
          const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: KEY });
          if (authority) return authority;
          if (String(input).includes('/internal/api-keys/')) {
            return new Response(
              JSON.stringify({
                id: KEY,
                userId: USER,
                revoked: false,
                requireSignature: true,
                ipAllowlist: [],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response('no', { status: 500 });
        },
      },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });
});

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
const LISTED = 'https://app.example.com';
const FOREIGN = 'https://evil.example';

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

function fetchWith(originAllowlist?: string[]): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
    if (authority) return authority;
    const token = await accessToken();
    const json: Record<string, unknown> = { accessToken: token };
    if (originAllowlist !== undefined) json.originAllowlist = originAllowlist;
    return new Response(JSON.stringify({ result: { data: { json } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('API key origin allowlist at the session door', () => {
  it('matching origin proceeds; foreign Origin cannot open a session', async () => {
    const live = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', origin: LISTED },
      { ...options, fetch: fetchWith(['app.example.com']) },
    );
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();

    const foreign = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', origin: FOREIGN },
      { ...options, fetch: fetchWith(['app.example.com']) },
    );
    expect(foreign.rejected).toBe('invalid');
    expect(foreign.principal).toBeNull();
    expect(foreign.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('empty list stays open (no invented localhost)', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_open', origin: FOREIGN }, { ...options, fetch: fetchWith([]) });
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
    expect(result.headers.origin).toBe(FOREIGN);
    expect(result.headers.origin).not.toBe('http://localhost');
  });

  it('missing list stays open (identity omits it on a live exchange)', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_open' }, { ...options, fetch: fetchWith() });
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });

  it('missing Origin when the list is set refuses', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_bound' }, { ...options, fetch: fetchWith(['app.example.com']) });
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('identity origin refuse (401) cannot open a session', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_bound', origin: FOREIGN },
      {
        ...options,
        fetch: async () => new Response(JSON.stringify({ error: { message: 'API key is not allowed from this origin' } }), { status: 401 }),
      },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('client x-forwarded-origin cannot stand in for Origin', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_stolen', 'x-forwarded-origin': LISTED },
      { ...options, fetch: fetchWith(['app.example.com']) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers['x-forwarded-origin']).toBeUndefined();
  });
});

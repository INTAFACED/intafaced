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
const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const NOW = new Date('2026-08-25T00:00:00.000Z');

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

function fetchWith(expiresAt?: Date): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION });
    if (authority) return authority;
    const token = await accessToken();
    const json: Record<string, unknown> = { accessToken: token };
    if (expiresAt) json.expiresAt = expiresAt.toISOString();
    return new Response(JSON.stringify({ result: { data: { json } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('API key expiresAt at the session door', () => {
  it('future expiresAt places; past expiresAt cannot', async () => {
    const live = await exchangePrincipal({ authorization: 'Bearer ifc_live' }, { ...options, fetch: fetchWith(FUTURE) }, NOW);
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);

    const dead = await exchangePrincipal({ authorization: 'Bearer ifc_dead' }, { ...options, fetch: fetchWith(PAST) }, NOW);
    expect(dead.rejected).toBe('expired');
    expect(dead.principal).toBeNull();
    expect(dead.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('missing expiresAt stays open', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_open' }, { ...options, fetch: fetchWith() }, NOW);
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });

  it('refuses when the clock is missing', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_live' },
      { ...options, fetch: fetchWith(FUTURE) },
      new Date('not-a-date'),
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });
});

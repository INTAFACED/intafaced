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

function fetchWith(status?: string): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, {
      expectedUserId: USER,
      expectedCredentialId: SESSION,
      accountStatus: status ?? 'active',
    });
    if (authority) return authority;
    const token = await accessToken();
    const json: Record<string, unknown> = { accessToken: token };
    if (status) json.status = status;
    return new Response(JSON.stringify({ result: { data: { json } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('frozen user at the session door', () => {
  it('active user proceeds; frozen and closed cannot open a session', async () => {
    const live = await exchangePrincipal({ authorization: 'Bearer ifc_live' }, { ...options, fetch: fetchWith('active') });
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();

    const frozen = await exchangePrincipal({ authorization: 'Bearer ifc_frozen' }, { ...options, fetch: fetchWith('frozen') });
    expect(frozen.rejected).toBe('invalid');
    expect(frozen.principal).toBeNull();
    expect(frozen.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();

    const closed = await exchangePrincipal({ authorization: 'Bearer ifc_closed' }, { ...options, fetch: fetchWith('closed') });
    expect(closed.rejected).toBe('invalid');
    expect(closed.principal).toBeNull();
  });

  it('missing status stays open (identity omits it on a live exchange)', async () => {
    const result = await exchangePrincipal({ authorization: 'Bearer ifc_open' }, { ...options, fetch: fetchWith() });
    expect(result.rejected).toBeNull();
    expect(result.principal?.userId).toBe(USER);
  });

  it('identity freeze refuse (403) cannot open a session', async () => {
    const result = await exchangePrincipal(
      { authorization: 'Bearer ifc_frozen' },
      { ...options, fetch: async () => new Response(JSON.stringify({ error: { message: 'Account is frozen' } }), { status: 403 }) },
    );
    expect(result.rejected).toBe('invalid');
    expect(result.principal).toBeNull();
    expect(result.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });
});

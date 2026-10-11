import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER } from '@intafaced/contracts';
import { exchangePrincipal } from './principal-exchange.js';
import { recoveryCodeAdmitsRecoveredSession } from './recovery-admit-recovered.js';
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
const KEEP = '22222222-2222-4222-8222-222222222222';
const CODE = 'A1B2C-D3E4F';

const options = {
  tokens,
  edgeSecret: EDGE_SECRET,
  region: 'GB',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: OWNERSHIP_SECRET,
};

async function access(): Promise<string> {
  const issued = await issueAccessToken({ userId: USER, sessionId: KEEP, scopes: ['trade:read'], tier: 'basic', mfa: false }, tokens);
  return issued.token;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recoveredFetch(): typeof fetch {
  return async (input, init) => {
    const authority = currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: KEEP });
    if (authority) return authority;
    const url = String(input);
    if (url.includes('/internal/account/')) {
      return json({ userId: USER, status: 'active', kycTier: 'none', lastVerifiedAt: '2026-08-25T00:00:00.000Z' });
    }
    return json({ id: KEEP, userId: USER, revoked: false });
  };
}

describe('recovered session is admitted after a recovery redeem', () => {
  it('spent or missing recovery code refuses before the recovered session is admitted', () => {
    expect(() => recoveryCodeAdmitsRecoveredSession({ code: '', recoveryCodeHashes: ['h'] })).toThrow(/missing/);
    expect(() => recoveryCodeAdmitsRecoveredSession({ code: CODE, recoveryCodeHashes: [] })).toThrow(/spent/);
  });

  it('recovered session is admitted after a remaining recovery code', async () => {
    recoveryCodeAdmitsRecoveredSession({ code: CODE, recoveryCodeHashes: ['h'] });
    const token = await access();
    const live = await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...options, fetch: recoveredFetch() });
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
  });
});

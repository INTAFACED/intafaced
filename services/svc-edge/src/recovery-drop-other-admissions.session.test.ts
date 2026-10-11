import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER } from '@intafaced/contracts';
import { exchangePrincipal } from './principal-exchange.js';
import { recoveryCodeDropsOtherAdmissions } from './recovery-drop-other-admissions.js';
import { currentAuthorityInputSchema } from '@intafaced/contracts';
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
const OTHER = '44444444-4444-4444-8444-444444444444';
const CODE = 'A1B2C-D3E4F';

const options = {
  tokens,
  edgeSecret: EDGE_SECRET,
  region: 'GB',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: OWNERSHIP_SECRET,
};

async function access(sessionId: string): Promise<string> {
  const issued = await issueAccessToken({ userId: USER, sessionId, scopes: ['trade:read'], tier: 'basic', mfa: false }, tokens);
  return issued.token;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function twoSeatFetch(): { fetch: typeof fetch; dropOthers: () => void } {
  const revoked = new Set<string>();
  return {
    dropOthers() {
      revoked.add(OTHER);
    },
    fetch: async (input, init) => {
      if (String(input).endsWith('/trpc/accountControls.currentAuthority')) {
        const subject = currentAuthorityInputSchema.parse(JSON.parse(String(init?.body)) as unknown);
        const credentialId = subject.credential.kind === 'session' ? subject.credential.sessionId : subject.credential.apiKeyId;
        const expectedCredentialId = credentialId === KEEP ? KEEP : credentialId === OTHER ? OTHER : 'unrecognized-test-credential';
        const authority = currentAuthorityTestReply(input, init, {
          expectedUserId: USER,
          expectedCredentialId,
          credentialRevoked: revoked.has(expectedCredentialId),
        });
        if (authority) return authority;
      }
      const url = String(input);
      if (url.includes('/internal/account/')) {
        return json({ userId: USER, status: 'active', kycTier: 'none', lastVerifiedAt: '2026-08-25T00:00:00.000Z' });
      }
      const sessionId = url.includes(KEEP) ? KEEP : url.includes(OTHER) ? OTHER : '';
      return json({ id: sessionId, userId: USER, revoked: revoked.has(sessionId) });
    },
  };
}

describe('other private admissions drop after a recovery code; recovered session stays admitted', () => {
  it('spent or missing recovery code refuses before any seat is dropped', () => {
    expect(() => recoveryCodeDropsOtherAdmissions({ code: '', recoveryCodeHashes: ['h'] })).toThrow(/missing/);
    expect(() => recoveryCodeDropsOtherAdmissions({ code: CODE, recoveryCodeHashes: [] })).toThrow(/spent/);
  });

  it('recovered session stays admitted; other live session is refused after the code revokes it', async () => {
    const seats = twoSeatFetch();
    const keepToken = await access(KEEP);
    const otherToken = await access(OTHER);
    const keepLive = await exchangePrincipal({ authorization: `Bearer ${keepToken}` }, { ...options, fetch: seats.fetch });
    const otherLive = await exchangePrincipal({ authorization: `Bearer ${otherToken}` }, { ...options, fetch: seats.fetch });
    expect(keepLive.rejected).toBeNull();
    expect(keepLive.principal?.userId).toBe(USER);
    expect(keepLive.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
    expect(otherLive.rejected).toBeNull();
    expect(otherLive.principal?.userId).toBe(USER);
    expect(otherLive.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();

    recoveryCodeDropsOtherAdmissions({ code: CODE, recoveryCodeHashes: ['h'] });
    seats.dropOthers();

    const keepAfter = await exchangePrincipal({ authorization: `Bearer ${keepToken}` }, { ...options, fetch: seats.fetch });
    const otherAfter = await exchangePrincipal({ authorization: `Bearer ${otherToken}` }, { ...options, fetch: seats.fetch });
    expect(keepAfter.rejected).toBeNull();
    expect(keepAfter.principal?.userId).toBe(USER);
    expect(keepAfter.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
    expect(otherAfter.rejected).toBe('invalid');
    expect(otherAfter.principal).toBeNull();
    expect(otherAfter.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });
});

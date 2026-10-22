import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER } from '@intafaced/contracts';
import { exchangePrincipal } from './principal-exchange.js';

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
const VERIFIED_AT = '2026-08-25T00:00:00.000Z';

const options = {
  tokens,
  edgeSecret: EDGE_SECRET,
  region: 'GB',
  identityUrl: 'http://identity.test',
  identityOwnershipSecret: OWNERSHIP_SECRET,
};

async function accessToken(): Promise<string> {
  const issued = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false }, tokens);
  return issued.token;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchIdentity(account: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes('/internal/account/')) {
      return json({ userId: USER, status: 'active', kycTier: 'none', ...account });
    }
    expect(url).toContain(`/internal/sessions/${SESSION}`);
    return json({ id: SESSION, userId: USER, revoked: false });
  };
}

describe('remaining enrolled passkey opens the HTTP session door', () => {
  it('remaining of two verified creds places on the existing session', async () => {
    const token = await accessToken();
    const live = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      {
        ...options,
        fetch: fetchIdentity({
          webauthnCreds: [{ credentialId: 'cred-2', lastVerifiedAt: VERIFIED_AT }],
        }),
      },
    );
    expect(live.rejected).toBeNull();
    expect(live.principal?.userId).toBe(USER);
    expect(live.headers[EDGE_PRINCIPAL_HEADER]).toBeDefined();
  });

  it('two verified then remaining-only still places; empty remaining cannot', async () => {
    const token = await accessToken();
    const both = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      {
        ...options,
        fetch: fetchIdentity({
          webauthnCreds: [
            { credentialId: 'cred-1', lastVerifiedAt: VERIFIED_AT },
            { credentialId: 'cred-2', lastVerifiedAt: VERIFIED_AT },
          ],
        }),
      },
    );
    expect(both.rejected).toBeNull();
    expect(both.principal?.userId).toBe(USER);

    const remaining = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      {
        ...options,
        fetch: fetchIdentity({
          webauthnCreds: [{ credentialId: 'cred-2', lastVerifiedAt: VERIFIED_AT }],
        }),
      },
    );
    expect(remaining.rejected).toBeNull();
    expect(remaining.principal?.userId).toBe(USER);

    const none = await exchangePrincipal({ authorization: `Bearer ${token}` }, { ...options, fetch: fetchIdentity({ webauthnCreds: [] }) });
    expect(none.rejected).toBe('invalid');
    expect(none.principal).toBeNull();
    expect(none.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });

  it('remaining cred without lastVerifiedAt cannot place', async () => {
    const token = await accessToken();
    const dead = await exchangePrincipal(
      { authorization: `Bearer ${token}` },
      { ...options, fetch: fetchIdentity({ webauthnCreds: [{ credentialId: 'cred-2' }] }) },
    );
    expect(dead.rejected).toBe('invalid');
    expect(dead.principal).toBeNull();
    expect(dead.headers[EDGE_PRINCIPAL_HEADER]).toBeUndefined();
  });
});

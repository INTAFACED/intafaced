import { describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { EDGE_PRINCIPAL_HEADER, EDGE_SIGNATURE_HEADER, generateEdgePrincipalKeyPair, verifyForwardedPrincipal } from '@intafaced/contracts';
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
  fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    currentAuthorityTestReply(input, init, { expectedUserId: USER, expectedCredentialId: SESSION }) ?? new Response(null, { status: 404 }),
};

async function bearer() {
  const { token } = await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'], tier: 'basic', mfa: false }, tokens);
  return { authorization: `Bearer ${token}` };
}

describe('the exchange with an edge signing key configured', () => {
  const pair = generateEdgePrincipalKeyPair();
  const limits = { maxLifetimeSeconds: 60, clockSkewSeconds: 5 };

  it('signs the forwarded principal with Ed25519 that a public-key verifier accepts', async () => {
    const result = await exchangePrincipal(await bearer(), {
      ...options,
      ed25519: { privateKey: pair.privateKey, maxLifetimeSeconds: 60 },
    });
    expect(result.rejected).toBeNull();
    const raw = result.headers[EDGE_PRINCIPAL_HEADER];
    const signature = result.headers[EDGE_SIGNATURE_HEADER];
    expect(signature).toMatch(/^ed25519:/);

    const verified = verifyForwardedPrincipal(raw, signature, { publicKey: pair.publicKey, limits }, new Date(), 'GB');
    expect(verified.rejected).toBeNull();
    expect(verified.principal?.userId).toBe(USER);

    const wire = JSON.parse(raw!) as { iat: number; expiresAt: string };
    expect((Date.parse(wire.expiresAt) - wire.iat * 1000) / 1000).toBeLessThanOrEqual(60);
  });

  it('is refused by a shared-secret verifier, so a holder of that secret gains nothing from this signature', async () => {
    const result = await exchangePrincipal(await bearer(), {
      ...options,
      ed25519: { privateKey: pair.privateKey, maxLifetimeSeconds: 60 },
    });
    const verified = verifyForwardedPrincipal(
      result.headers[EDGE_PRINCIPAL_HEADER],
      result.headers[EDGE_SIGNATURE_HEADER],
      EDGE_SECRET,
      new Date(),
      'GB',
    );
    expect(verified.principal).toBeNull();
  });

  it('keeps signing with the shared secret when no key is configured', async () => {
    const result = await exchangePrincipal(await bearer(), options);
    expect(result.headers[EDGE_SIGNATURE_HEADER]).not.toMatch(/^ed25519:/);
  });
});

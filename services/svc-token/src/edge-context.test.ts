/**
 * The edge principal is verified with the shared secret AND, when configured, the edge's public key.
 * The context comes from the same `buildEdgeContext` the service boots with, over real headers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  encodePrincipal,
  createServiceSigner,
  type Keyring,
  createServiceVerifier,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
  serviceAuthHeadersForBody,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';

type Principal = Parameters<typeof encodeForwardedPrincipal>[0];

const SECRET = 's'.repeat(32);
const edge = generateEdgePrincipalKeyPair();
const LIMITS = { EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120', EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10' };
const USER = '11111111-1111-4111-8111-111111111111';

const principal = (lifetimeMs = 600_000): Principal =>
  ({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + lifetimeMs),
  }) as Principal;

async function contextWith(
  overrides: Record<string, string | undefined>,
  s2s?: Parameters<typeof import('./edge-context.js').buildEdgeContext>[1],
) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('EDGE_PRINCIPAL_PUBLIC_KEY', undefined);
  vi.stubEnv('EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS', undefined);
  vi.stubEnv('EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS', undefined);
  for (const [key, value] of Object.entries({
    EDGE_PRINCIPAL_SECRET: SECRET,
    DATABASE_URL: 'postgres://u:p@localhost:5432/token',
    INTERNAL_SERVICE_SECRET: 'i'.repeat(32),
    DATABASE_POOL_MAX: '5',
    ...overrides,
  }))
    vi.stubEnv(key, value);
  const { env } = await import('./env.js');
  const { buildEdgeContext } = await import('./edge-context.js');
  return buildEdgeContext(env, s2s);
}

const request = (raw: string, signature: string) => ({
  headers: { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signature, 'x-intafaced-region': 'DE' },
});

const edgeSigned = (privateKey = edge.privateKey, maxLifetimeSeconds = 120) => {
  const raw = encodeForwardedPrincipal(principal(), maxLifetimeSeconds);
  return request(raw, signPrincipalHeaderEd25519(raw, privateKey, 'DE'));
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('edge principal receiver', () => {
  const withKey = { EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey, ...LIMITS };

  it('accepts a principal signed by the edge key when the public key and both limits are set', async () => {
    const ctx = await contextWith(withKey);
    expect(ctx(edgeSigned()).principal?.userId).toBe(USER);
  });

  it('refuses that principal when the public key is unset', async () => {
    const ctx = await contextWith({});
    expect(ctx(edgeSigned()).principal).toBeNull();
  });

  it('refuses a principal signed by another key', async () => {
    const ctx = await contextWith(withKey);
    expect(ctx(edgeSigned(generateEdgePrincipalKeyPair().privateKey)).principal).toBeNull();
  });

  it('refuses a principal whose lifetime exceeds the configured maximum', async () => {
    const ctx = await contextWith(withKey);
    expect(ctx(edgeSigned(edge.privateKey, 300)).principal).toBeNull();
  });

  it('still accepts the shared-secret form', async () => {
    const ctx = await contextWith(withKey);
    const raw = encodePrincipal(principal(60_000));
    expect(ctx(request(raw, signPrincipalHeader(raw, SECRET, 'DE'))).principal?.userId).toBe(USER);
  });
});

describe('service caller on /trpc', () => {
  it('is named by its own key when S2S is wired, and the shared secret is refused in keypair mode', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
    const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    const keyring: Keyring = [{ kid: 'svc-trade.a', svc: 'svc-trade', use: 's2s', x }];
    const signer = createServiceSigner({ service: 'svc-trade', kid: 'svc-trade.a', privateKey: pkcs8, keyring });
    const verifier = createServiceVerifier({ self: 'svc-token', keyring });
    const ctx = await contextWith({}, { verifier, mode: 'keypair' });
    const url = new URL('http://token.test/trpc/health');
    const headers = signer.headers({ audience: 'svc-token', method: 'POST', url, body: '{}' });
    const keyed = ctx({ id: 'r1', method: 'POST', url: url.pathname, headers, body: '{}' } as never);
    expect(keyed.service).toBe('svc-trade');
    const shared = serviceAuthHeadersForBody('svc-trade', 'i'.repeat(32), '{}');
    expect(ctx({ id: 'r2', method: 'POST', url: url.pathname, headers: shared, body: '{}' } as never).service).toBeNull();
  });
});

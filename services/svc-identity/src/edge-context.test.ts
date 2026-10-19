/**
 * The edge principal is verified with the shared secret AND, when configured, the edge's public key.
 * The context comes from the same `buildIdentityRequestContext` the service boots with, over real headers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
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

async function contextWith(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('EDGE_PRINCIPAL_PUBLIC_KEY', undefined);
  vi.stubEnv('EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS', undefined);
  vi.stubEnv('EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS', undefined);
  for (const [key, value] of Object.entries({
    EDGE_PRINCIPAL_SECRET: SECRET,
    DATABASE_URL: 'postgres://u:p@localhost:5432/identity',
    INTERNAL_SERVICE_SECRET: 'i'.repeat(32),
    DATABASE_POOL_MAX: '5',
    JWT_ACCESS_SECRET: 'j'.repeat(32),
    ...overrides,
  }))
    vi.stubEnv(key, value);
  const { env } = await import('./env.js');
  const { createIdentityRequestContext } = await import('./controls/founder-context.js');
  const { edgeTrustFromEnv } = await import('@intafaced/config');
  return createIdentityRequestContext({
    secret: env.EDGE_PRINCIPAL_SECRET,
    ...edgeTrustFromEnv(env),
    serviceName: env.SERVICE_NAME,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    bodyBindMode: 'require',
  });
}

const request = (raw: string, signature: string) => ({
  headers: { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signature, 'x-intafaced-region': 'DE' },
  url: '/trpc/ping',
});

const edgeSigned = (privateKey = edge.privateKey, maxLifetimeSeconds = 120) => {
  const raw = encodeForwardedPrincipal(principal(), maxLifetimeSeconds);
  return request(raw, signPrincipalHeaderEd25519(raw, privateKey, 'DE'));
};

it('index.ts hands the edge trust settings to the identity context', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
  expect(source).toMatch(/createIdentityRequestContext\(\{.*?secret: env\.EDGE_PRINCIPAL_SECRET,\s*\.\.\.edgeTrustFromEnv\(env\),/s);
});

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

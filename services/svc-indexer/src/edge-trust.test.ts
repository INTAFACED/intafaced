/**
 * The edge principal is verified with the shared secret AND, when configured, the edge's public key.
 * The trust settings come from the service's edge env settings through `edgeTrustFromEnv`; the last case boots
 * the real entrypoint (`testing/boot.ts`) and asks the context it hands its /trpc mount.
 */
import { describe, expect, it } from 'vitest';
import { edgeEnvSchema, edgeTrustFromEnv, loadEnv } from '@intafaced/config';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { BOOT_EDGE_SECRET, bootIndexer } from './testing/boot.js';

type Principal = Parameters<typeof encodeForwardedPrincipal>[0];

const SECRET = 's'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const edge = generateEdgePrincipalKeyPair();
const LIMITS = { EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120', EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10' };

const principal = (): Principal =>
  ({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  }) as Principal;

function contextWith(overrides: Record<string, string | undefined>) {
  const env = loadEnv(edgeEnvSchema, { EDGE_PRINCIPAL_SECRET: SECRET, ...overrides });
  return createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: 'svc-indexer' });
}

const request = (raw: string, signature: string) => ({
  headers: { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signature, 'x-intafaced-region': 'DE' },
});

const edgeSigned = (privateKey = edge.privateKey, maxLifetimeSeconds = 120) => {
  const raw = encodeForwardedPrincipal(principal(), maxLifetimeSeconds);
  return request(raw, signPrincipalHeaderEd25519(raw, privateKey, 'DE'));
};

describe('edge principal receiver', () => {
  const withKey = { EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey, ...LIMITS };

  it('accepts a principal signed by the edge key when the public key and both limits are set', () => {
    expect(contextWith(withKey)(edgeSigned()).principal?.userId).toBe(USER);
  });

  it('refuses that principal when the public key is unset', () => {
    expect(contextWith({})(edgeSigned()).principal).toBeNull();
  });

  it('refuses a principal signed by another key', () => {
    expect(contextWith(withKey)(edgeSigned(generateEdgePrincipalKeyPair().privateKey)).principal).toBeNull();
  });

  it('refuses a principal whose lifetime exceeds the configured maximum', () => {
    expect(contextWith(withKey)(edgeSigned(edge.privateKey, 300)).principal).toBeNull();
  });

  it('still accepts the shared-secret form', () => {
    const raw = encodePrincipal(principal());
    expect(contextWith(withKey)(request(raw, signPrincipalHeader(raw, SECRET, 'DE'))).principal?.userId).toBe(USER);
  });

  it('index.ts hands the edge trust settings to the edge context', async () => {
    // The context the booted service hands its /trpc mount, given a principal the edge key signed.
    const principalSeenBy = async (vars: Record<string, string | undefined>) => {
      const booted = await bootIndexer(vars);
      try {
        // Only the request is read; the rest of Fastify's context options are not.
        const context = await booted.publicHttp.createContext({ req: edgeSigned() } as never);
        return context.principal?.userId ?? null;
      } finally {
        await booted.close();
      }
    };
    expect(await principalSeenBy(withKey)).toBe(USER);
    expect(await principalSeenBy({ EDGE_PRINCIPAL_PUBLIC_KEY: undefined })).toBeNull();
  });

  it('index.ts verifies the shared-secret principal with its own EDGE_PRINCIPAL_SECRET', async () => {
    // The same booted context, given a principal signed with the secret the service started with, and another one.
    const booted = await bootIndexer();
    try {
      const raw = encodePrincipal(principal());
      const seenWith = async (secret: string) => {
        const context = await booted.publicHttp.createContext({ req: request(raw, signPrincipalHeader(raw, secret, 'DE')) } as never);
        return context.principal?.userId ?? null;
      };
      expect(await seenWith(BOOT_EDGE_SECRET)).toBe(USER);
      expect(await seenWith('another-edge-secret-that-is-not-the-boot-one')).toBeNull();
    } finally {
      await booted.close();
    }
  });
});

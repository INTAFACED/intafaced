/**
 * The guest ingress door verifies the edge principal with the shared secret AND, when configured, the
 * edge's public key. The last case boots the real entrypoint (`testing/boot.ts`) and asks the context it hands its /trpc mount.
 */
import { describe, expect, it } from 'vitest';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { bootNotify } from '../testing/boot.js';
import { createGuestIngressContext } from './context.js';

type Principal = Parameters<typeof encodeForwardedPrincipal>[0];

const SECRET = 'a-notify-guest-edge-secret-long-enough-x';
const USER = '11111111-1111-4111-8111-111111111111';
const edge = generateEdgePrincipalKeyPair();
const LIMITS = { maxLifetimeSeconds: 120, clockSkewSeconds: 10 };
const trust = { edgePublicKey: edge.publicKey, principalLimits: LIMITS };

const principal = (): Principal =>
  ({
    sub: USER,
    userId: USER,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['notify:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  }) as Principal;

const request = (raw: string, signature: string) => ({
  headers: { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signature, 'x-intafaced-region': 'DE' },
  body: '{}',
});

const edgeSigned = (privateKey = edge.privateKey, maxLifetimeSeconds = LIMITS.maxLifetimeSeconds) => {
  const raw = encodeForwardedPrincipal(principal(), maxLifetimeSeconds);
  return request(raw, signPrincipalHeaderEd25519(raw, privateKey, 'DE'));
};

describe('guest ingress: edge principal', () => {
  it('accepts a principal signed by the edge key when the public key and limits are set', () => {
    const ctx = createGuestIngressContext({ edgeSecret: SECRET, edgeTrust: trust });
    expect(ctx(edgeSigned()).principal?.userId).toBe(USER);
  });

  it('refuses that principal when the public key is unset', () => {
    expect(createGuestIngressContext({ edgeSecret: SECRET })(edgeSigned()).principal).toBeNull();
  });

  it('refuses a principal signed by another key', () => {
    const ctx = createGuestIngressContext({ edgeSecret: SECRET, edgeTrust: trust });
    expect(ctx(edgeSigned(generateEdgePrincipalKeyPair().privateKey)).principal).toBeNull();
  });

  it('refuses a principal whose lifetime exceeds the configured maximum', () => {
    const ctx = createGuestIngressContext({ edgeSecret: SECRET, edgeTrust: trust });
    expect(ctx(edgeSigned(edge.privateKey, 300)).principal).toBeNull();
  });

  it('still accepts the shared-secret form', () => {
    const ctx = createGuestIngressContext({ edgeSecret: SECRET, edgeTrust: trust });
    const raw = encodePrincipal(principal());
    expect(ctx(request(raw, signPrincipalHeader(raw, SECRET, 'DE'))).principal?.userId).toBe(USER);
  });

  it('index.ts hands the edge trust settings to the guest ingress context', async () => {
    // The context the booted service hands its /trpc mount, given a principal the edge key signed.
    const principalSeenBy = async (vars: Record<string, string | undefined>) => {
      const booted = await bootNotify(vars);
      try {
        const context = booted.trpc.createContext({ req: edgeSigned(), res: {} }) as { principal: { userId: string } | null };
        return context.principal?.userId ?? null;
      } finally {
        await booted.close();
      }
    };
    expect(
      await principalSeenBy({
        EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey,
        EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: String(LIMITS.maxLifetimeSeconds),
        EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: String(LIMITS.clockSkewSeconds),
      }),
    ).toBe(USER);
    expect(await principalSeenBy({ EDGE_PRINCIPAL_PUBLIC_KEY: undefined })).toBeNull();
  });
});

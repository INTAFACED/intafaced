/**
 * The guest ingress door verifies the edge principal with the shared secret AND, when configured, the
 * edge's public key. The tRPC mount in index.ts is pinned by source (it boots the whole service).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('index.ts hands the edge trust settings to the guest ingress context', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8');
    expect(source).toMatch(/edgeSecret: env\.EDGE_PRINCIPAL_SECRET,\s*edgeTrust: edgeTrustFromEnv\(env\),/);
  });
});

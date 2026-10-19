/**
 * The mining tRPC door verifies the edge principal with the shared secret AND, when configured, the
 * edge's public key. Driven over real HTTP with real headers.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { edgeTrustFromProcessEnv } from './edge-trust.js';
import { miningHealthHonesty } from './health-honesty.js';
import { createMiningRequestHandler } from './http.js';

type Principal = Parameters<typeof encodeForwardedPrincipal>[0];

const SECRET = 'mining-edge-trust-test-secret-32chars!';
const USER = '11111111-1111-4111-8111-111111111111';
const edge = generateEdgePrincipalKeyPair();
const KEY_ENV = {
  EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey,
  EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120',
  EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10',
};

const principal = (): Principal =>
  ({
    sub: USER,
    userId: USER,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['ledger:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  }) as Principal;

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function call(env: Record<string, string | undefined>, headers: Record<string, string>): Promise<string> {
  const handler = createMiningRequestHandler({
    health: () => miningHealthHonesty({ ledgerConfigured: false, pgConfigured: false, jobs: [] }),
    sql: null,
    internalSecret: SECRET,
    edgeSecret: SECRET,
    edgeTrust: edgeTrustFromProcessEnv(env),
    ledger: null,
  });
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/trpc/workers.mine?input=${encodeURIComponent(JSON.stringify({ windowMinutes: 60 }))}`, {
    headers,
  });
  return res.text();
}

const edgeSigned = (privateKey = edge.privateKey, maxLifetimeSeconds = 120) => {
  const raw = encodeForwardedPrincipal(principal(), maxLifetimeSeconds);
  return { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeaderEd25519(raw, privateKey, 'XX') };
};

describe('mining door: edge principal', () => {
  it('accepts a principal signed by the edge key when the public key and limits are set', async () => {
    expect(await call(KEY_ENV, edgeSigned())).not.toContain('UNAUTHORIZED');
  });

  it('refuses that principal when the public key is unset', async () => {
    expect(await call({}, edgeSigned())).toContain('UNAUTHORIZED');
  });

  it('refuses a principal signed by another key', async () => {
    expect(await call(KEY_ENV, edgeSigned(generateEdgePrincipalKeyPair().privateKey))).toContain('UNAUTHORIZED');
  });

  it('refuses a principal whose lifetime exceeds the configured maximum', async () => {
    expect(await call(KEY_ENV, edgeSigned(edge.privateKey, 300))).toContain('UNAUTHORIZED');
  });

  it('still accepts the shared-secret form', async () => {
    const raw = encodePrincipal(principal());
    const headers = { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'XX') };
    expect(await call(KEY_ENV, headers)).not.toContain('UNAUTHORIZED');
  });
});

describe('edgeTrustFromProcessEnv', () => {
  it('is empty without a key, and never invents a limit', () => {
    expect(edgeTrustFromProcessEnv({})).toEqual({});
    expect(edgeTrustFromProcessEnv({ EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey })).toEqual({ edgePublicKey: edge.publicKey });
    expect(edgeTrustFromProcessEnv({ ...KEY_ENV, EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: 'abc' }).principalLimits).toBeUndefined();
  });
});

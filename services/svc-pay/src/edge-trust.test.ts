/**
 * The merchant REST door and the tRPC mount verify the edge principal with the shared secret AND,
 * when configured, the edge's public key. The REST door is exercised over real headers; the tRPC
 * mount in index.ts is pinned by source (it boots the whole service).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { PayError, type PayService } from './payment-service.js';
import { registerPublicPayRest } from './public-rest.js';
import { MemoryRestIdempotencyStore } from './rest-idempotency.js';

type Principal = Parameters<typeof encodeForwardedPrincipal>[0];

const SECRET = 'a-pay-public-rest-edge-secret-long-enough-x';
const USER = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '44444444-4444-4444-8444-444444444444';
const edge = generateEdgePrincipalKeyPair();
const LIMITS = { maxLifetimeSeconds: 120, clockSkewSeconds: 10 };

const principal = (): Principal =>
  ({
    sub: USER,
    userId: USER,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['pay:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  }) as Principal;

const notFound = new PayError('not found', 'pay.payment_not_found');
const pay = new Proxy({} as PayService, {
  get: () => async () => {
    throw notFound;
  },
});

async function build(edgeTrust?: { edgePublicKey: string; principalLimits: typeof LIMITS }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  await registerPublicPayRest(app, {
    edgeSecret: SECRET,
    ...(edgeTrust ? { edgeTrust } : {}),
    serviceName: 'svc-pay',
    pay,
    idempotency: new MemoryRestIdempotencyStore(),
  });
  await app.ready();
  return app;
}

const edgeSigned = (privateKey = edge.privateKey, maxLifetimeSeconds = LIMITS.maxLifetimeSeconds) => {
  const raw = encodeForwardedPrincipal(principal(), maxLifetimeSeconds);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeaderEd25519(raw, privateKey, 'DE'),
    'x-intafaced-region': 'DE',
  };
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = async (headers: Record<string, string>) =>
  (await app!.inject({ method: 'GET', url: `/v1/payments/${PAYMENT}`, headers })).statusCode;
const trust = { edgePublicKey: edge.publicKey, principalLimits: LIMITS };

describe('merchant REST door: edge principal', () => {
  it('accepts a principal signed by the edge key when the public key and limits are set', async () => {
    app = await build(trust);
    expect(await get(edgeSigned())).not.toBe(401);
  });

  it('refuses that principal when the public key is unset', async () => {
    app = await build();
    expect(await get(edgeSigned())).toBe(401);
  });

  it('refuses a principal signed by another key', async () => {
    app = await build(trust);
    expect(await get(edgeSigned(generateEdgePrincipalKeyPair().privateKey))).toBe(401);
  });

  it('refuses a principal whose lifetime exceeds the configured maximum', async () => {
    app = await build(trust);
    expect(await get(edgeSigned(edge.privateKey, 300))).toBe(401);
  });

  it('still accepts the shared-secret form', async () => {
    app = await build(trust);
    const raw = encodePrincipal(principal());
    const headers = {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    };
    expect(await get(headers)).not.toBe(401);
  });
});

describe('index.ts wiring', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

  it('hands the edge trust settings to the tRPC edge context', () => {
    expect(source).toMatch(/createEdgeContext\(\{ secret: env\.EDGE_PRINCIPAL_SECRET, \.\.\.edgeTrustFromEnv\(env\),/);
  });

  it('hands the edge trust settings to the merchant REST door', () => {
    expect(source).toMatch(/edgeSecret: env\.EDGE_PRINCIPAL_SECRET,\s*edgeTrust: edgeTrustFromEnv\(env\),/);
  });
});

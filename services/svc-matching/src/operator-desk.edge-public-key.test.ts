/**
 * Edge public-key trust, "accept both" step. The founder door verifies the edge's Ed25519 principal signature
 * when the public key and both limits are set, and still accepts the shared-secret form.
 * Keys are generated per run; nothing here is a real key.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import {
  EdgeTrustError,
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';

const SECRET = 'matching-edge-public-key-secret-32ch';
const EDGE_SECRET = 'edge-principal-secret-at-least-32-characters';
const REGION = 'XX';
const LIMITS = { maxLifetimeSeconds: 120, clockSkewSeconds: 10 };
const edge = generateEdgePrincipalKeyPair();
const USER = '11111111-1111-4111-8111-111111111111';

const reader = (): Principal => ({
  sub: USER,
  userId: USER,
  scopes: ['admin:read'],
  tier: 'institutional',
  mfa: false,
  sid: '22222222-2222-4222-8222-222222222222',
  expiresAt: new Date(Date.now() + 3_600_000),
});

async function inFlight(options: Record<string, unknown>, headers: Record<string, string>) {
  const engine = new MatchingEngine({ journal: new MemoryJournal(), bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, options);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/operator/in-flight', headers: { 'x-intafaced-region': REGION, ...headers } });
  await app.close();
  return res.statusCode;
}

const edgeSigned = (privateKey = edge.privateKey, raw = encodeForwardedPrincipal(reader(), LIMITS.maxLifetimeSeconds)) => ({
  'x-intafaced-principal': raw,
  'x-intafaced-principal-sig': signPrincipalHeaderEd25519(raw, privateKey, REGION),
});
const TRUST = { edgePublicKey: edge.publicKey, principalLimits: LIMITS };

describe('svc-matching founder door accepts the edge public key alongside the shared secret', () => {
  it('accepts an Ed25519-signed principal when the public key and limits are set, with no shared secret', async () => {
    expect(await inFlight(TRUST, edgeSigned())).toBe(200);
  });

  it('refuses the same header when the public key is unset', async () => {
    expect(await inFlight({ edgePrincipalSecret: EDGE_SECRET }, edgeSigned())).toBe(401);
  });

  it('refuses a header signed by another key', async () => {
    expect(await inFlight(TRUST, edgeSigned(generateEdgePrincipalKeyPair().privateKey))).toBe(401);
  });

  it('refuses a validly signed principal that lives longer than the maximum lifetime', async () => {
    const stretched = JSON.stringify({ ...(JSON.parse(encodePrincipal(reader())) as object), iat: Math.floor(Date.now() / 1000) });
    expect(await inFlight(TRUST, edgeSigned(edge.privateKey, stretched))).toBe(401);
  });

  it('still accepts the shared-secret form with the public key set', async () => {
    const raw = encodePrincipal(reader());
    const headers = { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, REGION) };
    expect(await inFlight({ ...TRUST, edgePrincipalSecret: EDGE_SECRET }, headers)).toBe(200);
  });

  it('refuses to boot with a public key and no limits', () => {
    expect(() =>
      registerRoutes(
        Fastify(),
        new MatchingEngine({ journal: new MemoryJournal(), bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 }),
        SECRET,
        { edgePublicKey: edge.publicKey },
      ),
    ).toThrow(EdgeTrustError);
  });
});

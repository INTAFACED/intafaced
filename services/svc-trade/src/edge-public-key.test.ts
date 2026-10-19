/**
 * Edge public-key trust, "accept both" step. svc-trade verifies the edge's Ed25519 principal signature when
 * EDGE_PRINCIPAL_PUBLIC_KEY and both limits are set, and still accepts the shared-secret form. The door under
 * test is the outcomes order route, wired exactly as index.ts wires it (`edgeTrust: edgeTrustFromEnv(env)`).
 * Keys and the principal are generated per run; nothing here is a real key.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { edgeEnvSchema, edgeTrustFromEnv, loadEnv } from '@intafaced/config';
import {
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { createOutcomeMarket } from './outcomes/outcome-market.js';
import { memoryOutcomeCatalogue, registerOutcomesRest } from './outcomes-rest.js';
import { fakeOrder } from './private-rest.js';

const SECRET = 'edge-public-key-test-secret-long-enough';
const REGION = 'DE';
const LIMITS = { EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120', EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10' };
const edge = generateEdgePrincipalKeyPair();
const USER = '11111111-1111-4111-8111-111111111111';

const caller = (): Principal =>
  ({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 3_600_000),
  }) as Principal;

async function place(envInput: Record<string, string>, headers: Record<string, string>) {
  const env = loadEnv(edgeEnvSchema, { EDGE_PRINCIPAL_SECRET: SECRET, ...envInput });
  const market = createOutcomeMarket({
    id: 'fixture-outcome',
    question: 'Q?',
    closeAt: '2026-08-24T12:00:00.000Z',
    settlementAssetId: 'a',
    settlementSource: 's',
  });
  const placeOutcomeOrder = vi.fn(async (_p: unknown, input: any) =>
    fakeOrder({ marketId: input.symbol, qty: input.qty, price: input.price ?? null }),
  );
  const app = Fastify();
  registerOutcomesRest(app, {
    edgeSecret: env.EDGE_PRINCIPAL_SECRET,
    edgeTrust: edgeTrustFromEnv(env),
    serviceName: 'svc-trade',
    internalSecret: 'edge-public-key-internal-secret-long-enough',
    catalogue: memoryOutcomeCatalogue([market]),
    placeOutcomeOrder: placeOutcomeOrder as never,
    now: () => Date.parse('2026-08-24T11:00:00.000Z'),
  });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/outcomes/orders',
    headers: { 'x-intafaced-region': REGION, 'content-type': 'application/json', ...headers },
    payload: { symbol: 'fixture-outcome:YES', side: 'buy', type: 'limit', amount: '2', price: '0.4', clientOrderId: 'k1' },
  });
  await app.close();
  return { status: res.statusCode, placed: placeOutcomeOrder.mock.calls.length };
}

const edgeSigned = (privateKey = edge.privateKey, raw = encodeForwardedPrincipal(caller(), 120)) => ({
  'x-intafaced-principal': raw,
  'x-intafaced-principal-sig': signPrincipalHeaderEd25519(raw, privateKey, REGION),
});

const TRUST = { EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey, ...LIMITS };

describe('svc-trade accepts the edge public key alongside the shared secret', () => {
  it('accepts an Ed25519-signed principal when the public key and both limits are set', async () => {
    const out = await place(TRUST, edgeSigned());
    expect(out).toEqual({ status: 200, placed: 1 });
  });

  it('refuses the same header when the public key is unset', async () => {
    expect((await place({}, edgeSigned())).status).toBe(401);
  });

  it('refuses a header signed by another key', async () => {
    const rogue = generateEdgePrincipalKeyPair();
    const out = await place(TRUST, edgeSigned(rogue.privateKey));
    expect(out.status).toBe(401);
    expect(out.placed).toBe(0);
  });

  it('refuses a validly signed principal that lives longer than the maximum lifetime', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stretched = JSON.stringify({ ...(JSON.parse(encodePrincipal(caller())) as object), iat: now });
    const out = await place(TRUST, edgeSigned(edge.privateKey, stretched));
    expect(out.status).toBe(401);
    expect(out.placed).toBe(0);
  });

  it('still accepts the shared-secret form with the public key set', async () => {
    const raw = encodePrincipal(caller());
    const out = await place(TRUST, { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, REGION) });
    expect(out).toEqual({ status: 200, placed: 1 });
  });
});

/**
 * HIGH — tRPC S2S calls must be bound to the body they carry.
 *
 * The tRPC Fastify plugin replaces the JSON content parser inside its own scope
 * (`parseAs: 'string'`), so `retainRawBody`'s parser never runs for /trpc/*. The
 * `onRequest` marker did run, and `rawBodyOf` answered "retained, EMPTY". Two
 * consequences, in `accept-both` AND `require`:
 *
 *   1. an honest v2 tRPC POST was verified against the empty digest (401);
 *   2. an EMPTY-body v2 signature captured from any bodyless GET (svc-trade,
 *      support, agents and academy send them constantly) verified against an
 *      attacker-chosen body, so `rank.awardXp` minted arbitrary XP for any user
 *      for the 300 s skew window.
 *
 * Everything below goes over real HTTP (`inject`) through the real Fastify
 * instance with `retainRawBody` installed on the root, the real tRPC plugin, the
 * real identity context factory and the real `rank.awardXp` procedure.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  rawBodyOf,
  retainRawBody,
  router,
  serviceAuthHeaders,
  serviceAuthHeadersForBody,
  serviceProcedure,
  verifyServiceHeaders,
  type ServiceBodyBindMode,
} from '@intafaced/contracts';
import { createIdentityRouter } from '../router.js';
import type { AuthService } from '../auth/auth-service.js';
import type { RankService } from '../rank/rank-service.js';
import { createIdentityRequestContext } from './founder-context.js';

const EDGE = 'a-body-binding-edge-secret-long-enough-0123';
const INTERNAL = 'a-body-binding-service-secret-long-enough';
const VICTIM = '11111111-1111-4111-8111-111111111111';

const award = JSON.stringify({
  userId: VICTIM,
  sourceModule: 'trade',
  action: 'fill',
  xpDelta: 1_000_000,
  idempotencyKey: 'evil-award-0001',
});

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function mount(bodyBindMode?: ServiceBodyBindMode) {
  const awards: unknown[] = [];
  const rank = {
    async awardXp(input: unknown) {
      awards.push(input);
      return { snapshot: { rank: 1, xp: 5n }, applied: true, rankChanged: false };
    },
  } as unknown as RankService;
  const identity = createIdentityRouter({} as AuthService, rank, { registrationOpen: true });
  // A query twin: the GET path with the input in the URL and an empty body.
  const peek = router({ peek: serviceProcedure.input(z.object({ n: z.number() })).query(({ input }) => ({ n: input.n })) });
  const factory = createIdentityRequestContext({
    secret: EDGE,
    internalSecret: INTERNAL,
    serviceName: 'svc-identity',
    ...(bodyBindMode ? { bodyBindMode } : {}),
  });

  const server = Fastify({ logger: false });
  retainRawBody(server);
  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: identity, createContext: ({ req }: { req: FastifyRequest }) => factory(req) },
  });
  await server.register(fastifyTRPCPlugin, {
    prefix: '/peek',
    trpcOptions: { router: peek, createContext: ({ req }: { req: FastifyRequest }) => factory(req) },
  });
  // A root route guarded exactly as the /internal routes are: raw bytes, verifier.
  for (const mode of ['accept-both', 'require'] as const) {
    server.post(`/raw-${mode}`, async (req, reply) => {
      const verdict = verifyServiceHeaders(req.headers, INTERNAL, { rawBody: rawBodyOf(req), mode });
      return verdict.service ? { accepted: verdict.service } : reply.code(401).send({ rejected: verdict.rejected });
    });
  }
  await server.ready();
  app = server;
  return { server, awards };
}

const json = { 'content-type': 'application/json' };

describe('tRPC serviceProcedure body binding (real HTTP, real plugin)', () => {
  it('accepts an honest v2 call signed over the exact body', async () => {
    const { server, awards } = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/trpc/rank.awardXp',
      headers: { ...json, ...serviceAuthHeadersForBody('svc-trade', INTERNAL, award) },
      payload: award,
    });
    expect(res.statusCode).toBe(200);
    expect(awards).toHaveLength(1);
  });

  it('REFUSES an empty-body signature replayed against an attacker-chosen body', async () => {
    const { server, awards } = await mount();
    // Captured from any bodyless GET svc-trade/support/agents/academy make.
    const captured = serviceAuthHeadersForBody('svc-trade', INTERNAL, '');
    const res = await server.inject({ method: 'POST', url: '/trpc/rank.awardXp', headers: { ...json, ...captured }, payload: award });
    expect(res.statusCode).toBe(401);
    expect(awards).toEqual([]);
  });

  it('refuses a v1-style (unbound) call under require, the default', async () => {
    const { server, awards } = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/trpc/rank.awardXp',
      headers: { ...json, ...serviceAuthHeaders('svc-trade', INTERNAL) },
      payload: award,
    });
    expect(res.statusCode).toBe(401);
    expect(awards).toEqual([]);
  });

  it('refuses a body altered after signing', async () => {
    const { server, awards } = await mount();
    const res = await server.inject({
      method: 'POST',
      url: '/trpc/rank.awardXp',
      headers: { ...json, ...serviceAuthHeadersForBody('svc-trade', INTERNAL, award) },
      payload: award.replace('1000000', '9999999'),
    });
    expect(res.statusCode).toBe(401);
    expect(awards).toEqual([]);
  });

  it('binds the wire text, not a re-serialisation (whitespace and key order matter)', async () => {
    const { server, awards } = await mount();
    const spaced = `{ "idempotencyKey" : "spaced-award-1", "xpDelta":5,"userId":"${VICTIM}","sourceModule":"trade","action":"fill" }`;
    const res = await server.inject({
      method: 'POST',
      url: '/trpc/rank.awardXp',
      headers: { ...json, ...serviceAuthHeadersForBody('svc-trade', INTERNAL, spaced) },
      payload: spaced,
    });
    expect(res.statusCode).toBe(200);
    expect(awards).toHaveLength(1);
    // Signing the compact form of the same JSON does not authorise the spaced one.
    const compact = JSON.stringify(JSON.parse(spaced));
    const swapped = await server.inject({
      method: 'POST',
      url: '/trpc/rank.awardXp',
      headers: { ...json, ...serviceAuthHeadersForBody('svc-trade', INTERNAL, compact) },
      payload: spaced,
    });
    expect(swapped.statusCode).toBe(401);
  });

  it('still accepts an honest bodyless GET signed over the empty body', async () => {
    const { server } = await mount();
    const res = await server.inject({
      method: 'GET',
      url: `/peek/peek?input=${encodeURIComponent(JSON.stringify({ n: 7 }))}`,
      headers: serviceAuthHeadersForBody('svc-edge', INTERNAL, ''),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.data).toEqual({ n: 7 });
  });

  it('refuses a user session with no service credentials', async () => {
    const { server } = await mount();
    const res = await server.inject({ method: 'POST', url: '/trpc/rank.awardXp', headers: json, payload: award });
    expect(res.statusCode).toBe(401);
  });

  it('require is the default; an explicit accept-both downgrade still binds the body it can see', async () => {
    const { server, awards } = await mount('accept-both');
    const replay = await server.inject({
      method: 'POST',
      url: '/trpc/rank.awardXp',
      headers: { ...json, ...serviceAuthHeadersForBody('svc-trade', INTERNAL, '') },
      payload: award,
    });
    expect(replay.statusCode).toBe(401);
    expect(awards).toEqual([]);
  });
});

describe('root routes: a body that no retaining parser kept is not "empty"', () => {
  for (const mode of ['accept-both', 'require'] as const) {
    it(`${mode}: text/plain body with a replayed empty-body signature is refused`, async () => {
      const { server } = await mount();
      const res = await server.inject({
        method: 'POST',
        url: `/raw-${mode}`,
        headers: { 'content-type': 'text/plain', ...serviceAuthHeadersForBody('svc-trade', INTERNAL, '') },
        payload: award,
      });
      expect(res.statusCode).toBe(401);
    });

    it(`${mode}: JSON body with a replayed empty-body signature is refused (body-mismatch)`, async () => {
      const { server } = await mount();
      const res = await server.inject({
        method: 'POST',
        url: `/raw-${mode}`,
        headers: { ...json, ...serviceAuthHeadersForBody('svc-trade', INTERNAL, '') },
        payload: award,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().rejected).toBe('body-mismatch');
    });

    it(`${mode}: honest JSON v2 and honest bodyless v2 are accepted`, async () => {
      const { server } = await mount();
      const honest = await server.inject({
        method: 'POST',
        url: `/raw-${mode}`,
        headers: { ...json, ...serviceAuthHeadersForBody('svc-trade', INTERNAL, award) },
        payload: award,
      });
      expect(honest.statusCode).toBe(200);
      const bodyless = await server.inject({
        method: 'POST',
        url: `/raw-${mode}`,
        headers: serviceAuthHeadersForBody('svc-trade', INTERNAL, ''),
      });
      expect(bodyless.statusCode).toBe(200);
    });
  }
});

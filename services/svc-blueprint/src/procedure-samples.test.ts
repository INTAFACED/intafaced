import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { BLUEPRINT_PROCEDURES } from '@intafaced/contracts/blueprint-procedures';
import { BlueprintService } from './blueprint-service.js';
import { createBlueprintRouter } from './router.js';

/**
 * The mounted side of each svc-blueprint record's samples: sent through the production adapter by a caller the record
 * admits, a refused sample is answered 400 (the input is malformed), an accepted one never is. The record's zod schema
 * and its JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 *
 * No database, engine, bus or renderer: an accepted input reaches the service and fails there, which is not a 400.
 */

const SECRET = 'a-blueprint-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-blueprint' });

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['blueprint:read', 'blueprint:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const absent = (name: string) => () => {
  throw new Error(`samples: no ${name}`);
};
const blueprint = new BlueprintService(
  absent('sql') as never,
  absent('engine') as never,
  absent('bus') as never,
  absent('renderer') as never,
  {},
);
const app = Fastify();

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
});
beforeAll(async () => {
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createBlueprintRouter(blueprint), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(() => app.close());

const cases = BLUEPRINT_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-blueprint's mounted routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    if (record.transport !== 'trpc') throw new Error(`${record.name} is not a tRPC record`);
    const input = sample.input;
    const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
    const res =
      record.kind === 'query'
        ? await app.inject({ method: 'GET', url, headers: signedIn() })
        : await app.inject({
            method: 'POST',
            url,
            headers: { ...signedIn(), 'content-type': 'application/json' },
            payload: input === undefined ? '' : JSON.stringify(input),
          });
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).not.toBe(400);
  });
});

import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { ProcedureRecord, ProcedureSample } from '@intafaced/contracts/procedure';
import { NOTIFY_PROCEDURES } from '@intafaced/contracts/notify-procedures';
import type { NotifyService } from './notify-service.js';
import { createNotifyRouter } from './router.js';

/**
 * The mounted side of each svc-notify record's samples: sent through the production adapter by a caller the record
 * admits, a refused sample is answered 400 (the input is malformed), an accepted one never is. The record's zod schema
 * and its JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 *
 * No database or bus: an accepted input reaches the service and fails there, which is not a 400.
 */

const SECRET = 'a-notify-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

/** Signed in with the notify scopes. */
function signedIn(record: ProcedureRecord): Record<string, string> {
  const admits = record.access.caller === 'scope' ? [record.access.scope] : [];
  const principal = {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: [...new Set(['notify:read', 'notify:write', ...admits])],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

/** Every service call throws: a sample that gets past the input reaches here and fails as a 500, never a 400. */
const absent = (name: string) =>
  new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`samples: no ${name}`);
      },
    },
  );
const app = Fastify();

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'off');
});
beforeAll(async () => {
  const router = createNotifyRouter(absent('notify') as NotifyService);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(() => app.close());

const cases = NOTIFY_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-notify's mounted routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const input = sample.input;
    const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
    const res =
      record.kind === 'query'
        ? await app.inject({ method: 'GET', url, headers: signedIn(record) })
        : await app.inject({
            method: 'POST',
            url,
            headers: { ...signedIn(record), 'content-type': 'application/json' },
            payload: input === undefined ? '' : JSON.stringify(input),
          });
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).not.toBe(400);
  });
});

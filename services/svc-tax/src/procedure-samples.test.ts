import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { TAX_PROCEDURES } from '@intafaced/contracts/tax-procedures';
import { TAX_DATA_LAKE_UNAVAILABLE, TAX_INDEXER_UNAVAILABLE } from './codes.js';
import { createTaxRouter } from './router.js';
import { TaxService } from './tax-service.js';

/**
 * The mounted side of each svc-tax record's samples: sent through the production adapter by a caller the record admits,
 * a refused sample is answered 400 (the input is malformed), an accepted one never is. The record's zod schema and its
 * JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-tax-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-tax' });

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['tax:read', 'tax:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const tax = new TaxService({
  mapRaw: '["DE"]',
  reads: { balances: async () => [], history: async () => [] },
  lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
  indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
  historyYears: 10,
});
const app = Fastify();

beforeAll(async () => {
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createTaxRouter(tax), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(() => app.close());

const cases = TAX_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-tax's mounted routes reach each record sample's verdict", () => {
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

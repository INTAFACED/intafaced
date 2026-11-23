import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  REGION_FAIL_CLOSED_ENV,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
  SCREENING_FAIL_CLOSED_ENV,
  UNSIGNED_SANCTIONS_ROWS_ENV,
} from '@intafaced/config';
import { createEdgeContext } from '@intafaced/contracts';
import {
  DEX_AUTH_CHALLENGE,
  DEX_AUTH_LOGOUT,
  DEX_AUTH_LOGOUT_ALL,
  DEX_AUTH_REFRESH,
  DEX_AUTH_VERIFY,
  DEX_HEALTH,
  DEX_ORDERS_COUNT,
  DEX_QUOTE,
} from '@intafaced/contracts/dex-procedures';
import type { ProcedureRecord, ProcedureSample } from '@intafaced/contracts/procedure';
import { createDexRouter } from './router.js';

/**
 * The mounted side of each svc-dex record's samples, through the production Fastify adapter with the edge context
 * `index.ts` builds, from a served region, every owner value blank (a stack nobody configured). A refused sample is
 * answered 400 naming no refusal code (its input failed the record's schema); an accepted one never is. With
 * `PROCEDURE_REFUSALS_STRICT=1`, a refusal the handler sends that its record does not list, or lists with another
 * status, fails the call. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`
 * (`procedure-registry.test.ts`).
 */

const SECRET = 'a-dex-samples-edge-secret-long-enough';
const RECORDS: readonly ProcedureRecord[] = [
  DEX_HEALTH,
  DEX_QUOTE,
  DEX_AUTH_CHALLENGE,
  DEX_AUTH_VERIFY,
  DEX_AUTH_REFRESH,
  DEX_AUTH_LOGOUT,
  DEX_AUTH_LOGOUT_ALL,
  DEX_ORDERS_COUNT,
];

/** The screening list fixed for the run, as the wire replay fixes it: KP is screened out, DE is served. */
const ENV: Record<string, string | undefined> = {
  APP_ENV: 'test',
  [SANCTIONS_REGIONS_ENV]: 'KP',
  [SANCTIONS_SOURCE_ENV]: 'samples-fixture',
  [UNSIGNED_SANCTIONS_ROWS_ENV]: undefined,
  [SCREENING_FAIL_CLOSED_ENV]: undefined,
  [REGION_FAIL_CLOSED_ENV]: undefined,
  PROCEDURE_REFUSALS_STRICT: '1',
};

const app = Fastify();
beforeAll(async () => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-dex' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createDexRouter({ venues: () => [] }), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

async function send(record: ProcedureRecord, input: unknown) {
  if (record.transport !== 'trpc') throw new Error(`${record.name} is not a tRPC record`);
  const headers = { 'x-intafaced-region': 'DE' };
  const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return record.kind === 'query'
    ? app.inject({ method: 'GET', url, headers })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

const causeCode = (body: string): unknown =>
  (JSON.parse(body) as { error?: { data?: { cause?: { code?: unknown } } } }).error?.data?.cause?.code;

const cases = RECORDS.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({ record, sample, label: `${record.name} #${i} ${sample.verdict}` })),
);

describe("svc-dex's routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    const forInput = res.statusCode === 400 && causeCode(res.body) === undefined;
    expect(forInput, `${res.statusCode} ${res.body}`).toBe(sample.verdict === 'refuse');
    // A server error here is a refusal the record does not list (the strict mount) or a broken handler.
    expect(res.statusCode, res.body).toBeLessThan(500);
  });

  it('answers each accepted sample with a refusal its record lists, or with the reply, never with an unlisted code', async () => {
    for (const record of RECORDS) {
      const sample = record.samples.find((s) => s.verdict === 'accept');
      const res = await send(record, sample?.input);
      const code = res.statusCode === 200 ? undefined : causeCode(res.body);
      if (code !== undefined) expect(Object.keys(record.refusals), `${record.name}: ${res.body}`).toContain(code);
      else expect(res.statusCode, `${record.name}: ${res.body}`).toBe(200);
    }
  });
});

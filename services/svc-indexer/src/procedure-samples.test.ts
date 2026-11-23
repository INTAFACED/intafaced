import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { INDEXER_PROCEDURES } from '@intafaced/contracts/indexer-procedures';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { NullChainSource } from './chain/memory-source.js';
import { Indexer } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { registerIndexerPublicHttp } from './public-http.js';
import { createIndexerRouter } from './router.js';
import { CHAIN_ID } from './testing/conformance.js';

/**
 * The mounted side of each svc-indexer record's samples: sent through the public door `index.ts` mounts, by a caller in a
 * served region, a refused sample is answered 400 (the input is malformed) and an accepted one never is. The record's
 * zod schema and its JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const edgeContext = createEdgeContext({ secret: 'an-indexer-samples-edge-secret-long-enough', serviceName: 'svc-indexer' });
let app: Awaited<ReturnType<typeof mount>>;

async function mount() {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const indexer = new Indexer({ source: new NullChainSource(CHAIN_ID), store, finalityDepth: 64, ingestEnabled: () => true });
  const server = Fastify({ maxParamLength: 5_000 });
  await registerIndexerPublicHttp(server, {
    indexer,
    appRouter: createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 64,
      ingestEnabled: () => true,
      chainSource: 'null',
    }),
    serviceName: 'svc-indexer',
    ingestEnabled: () => true,
    venue: null,
    claimLiveClob: false,
    dbPing: async () => {},
    createContext: ({ req }) => edgeContext(req),
  });
  await server.ready();
  return server;
}

beforeAll(async () => {
  app = await mount();
});
afterAll(async () => {
  await app.close();
});

const cases = INDEXER_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-indexer's mounted routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    const input = sample.input;
    const url = `/trpc/${record.path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
    const res = await app.inject({ method: 'GET', url, headers: { 'x-intafaced-region': 'DE' } });
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).not.toBe(400);
  });
});

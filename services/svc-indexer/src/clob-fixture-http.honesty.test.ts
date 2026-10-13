/**
 * Q-index leftover — Fastify door must not present the fixture ABI as a live CLOB.
 *
 * Comments on abi.ts already say DevVenue is a fixture. This file pins the
 * public door: GET /health, GET /ready, GET /trpc/book, GET /trpc/stream.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { DEV_VENUE_ADDRESS, INDEXER_CLOB_FIXTURE_NOT_LIVE } from './clob-honesty.js';
import { MemoryChainSource } from './chain/memory-source.js';
import { Indexer } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { createIndexerRouter } from './router.js';
import { registerIndexerPublicHttp } from './public-http.js';
import { CHAIN_ID } from './testing/conformance.js';

const SECRET = 'indexer-q-clob-fixture-http-honesty-secret-32';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-indexer' });

type TrpcWire = {
  result?: { data?: { json?: unknown } | unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

async function mount(opts: { venue: string | null; claimLiveClob: boolean; seedBook: boolean }) {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const source = new MemoryChainSource(CHAIN_ID);
  if (opts.seedBook) {
    source.append([
      { kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'bid', price: '100', quantity: '5' },
      { kind: 'book_level', logIndex: 1, market: 'IFC-USD', side: 'ask', price: '101', quantity: '2' },
    ]);
  }
  const indexer = new Indexer({
    source,
    store,
    finalityDepth: 64,
    ingestEnabled: () => true,
    startHeight: 0,
  });
  if (opts.seedBook) await indexer.sync();

  const appRouter = createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 64,
    ingestEnabled: () => true,
    chainSource: 'memory',
    venue: opts.venue,
    rpcUrl: opts.venue ? 'http://127.0.0.1:8545' : null,
    claimLiveClob: opts.claimLiveClob,
  });
  const app = Fastify({ logger: false });
  await registerIndexerPublicHttp(app, {
    indexer,
    appRouter,
    serviceName: 'svc-indexer',
    ingestEnabled: () => true,
    venue: opts.venue,
    claimLiveClob: opts.claimLiveClob,
    dbPing: async () => {
      /* up */
    },
    createContext: ({ req }) => edgeContext(req),
  });
  await app.ready();
  apps.push(app);
  return app;
}

function trpcData(body: TrpcWire): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && data !== null && 'json' in data) {
    return (data as { json: unknown }).json;
  }
  return data;
}

async function trpcGet(app: FastifyInstance, path: string, input?: Record<string, unknown>) {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/${path}${qs}`,
    headers: { 'x-intafaced-region': 'DE' },
  });
  return { statusCode: res.statusCode, body: res.json() as TrpcWire };
}

describe('Q-index HTTP — fixture ABI is not a live CLOB', () => {
  it('GET /health names fixture, never live, never invents reserves', async () => {
    const app = await mount({ venue: DEV_VENUE_ADDRESS, claimLiveClob: false, seedBook: true });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      service: 'svc-indexer',
      clob: { live: false, kind: 'fixture', reserves: false },
    });
    expect(JSON.stringify(body)).not.toMatch(/"live":true/);
    expect(JSON.stringify(body)).not.toMatch(/reserves":\s*[1-9]/);
  });

  it('GET /trpc/book in dev still serves the ladder but labels it fixture not live', async () => {
    const app = await mount({ venue: DEV_VENUE_ADDRESS, claimLiveClob: false, seedBook: true });
    const { statusCode, body } = await trpcGet(app, 'book', { market: 'IFC-USD', depth: 50 });
    expect(statusCode).toBe(200);
    const book = trpcData(body) as { bids: unknown; clob: { live: boolean; kind: string; reserves: boolean } };
    expect(book.bids).toEqual([['100', '5']]);
    expect(book.clob).toEqual({ live: false, kind: 'fixture', reserves: false });
  });

  it('prod claim + DevVenue: /ready 503 and /trpc/book 412 indexer.clob_fixture_not_live', async () => {
    const app = await mount({ venue: DEV_VENUE_ADDRESS, claimLiveClob: true, seedBook: true });

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    const readyBody = ready.json() as { ready: boolean; reason: string; clob: { live: boolean } };
    expect(readyBody.ready).toBe(false);
    expect(readyBody.reason).toBe(INDEXER_CLOB_FIXTURE_NOT_LIVE);
    expect(readyBody.clob.live).toBe(false);

    const book = await trpcGet(app, 'book', { market: 'IFC-USD', depth: 50 });
    expect(book.statusCode).toBe(412);
    expect(book.body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(book.body.error?.message).toBe(INDEXER_CLOB_FIXTURE_NOT_LIVE);
    expect(JSON.stringify(trpcData(book.body) ?? {})).not.toMatch(/"bids"/);

    const stream = await trpcGet(app, 'stream', { depth: 50, marketsLimit: 2 });
    expect(stream.statusCode).toBe(412);
    expect(stream.body.error?.message).toBe(INDEXER_CLOB_FIXTURE_NOT_LIVE);
  });

  it('GET /trpc/health never claims live:true', async () => {
    const app = await mount({ venue: DEV_VENUE_ADDRESS, claimLiveClob: true, seedBook: false });
    const { statusCode, body } = await trpcGet(app, 'health');
    expect(statusCode).toBe(200);
    const data = trpcData(body) as { clob: { live: boolean; kind: string; reserves: boolean } };
    expect(data.clob).toEqual({ live: false, kind: 'fixture', reserves: false });
  });
});

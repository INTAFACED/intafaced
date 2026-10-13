import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { ChainUnavailableError } from './chain/evm/availability.js';
import { MemoryChainSource } from './chain/memory-source.js';
import type { ChainSource } from './chain/source.js';
import { Indexer } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { createIndexerRouter } from './router.js';
import { registerIndexerPublicHttp } from './public-http.js';

/**
 * D26-P1-I3 Done bar — Chain→Postgres honest halt/refuse; no fake live books.
 *
 * Break class: helper-only `readinessOf` / `createCaller` asserts that never
 * cross the mounted Fastify door (`GET /ready`, `GET /trpc/...`). A future
 * edit that keeps the helper green but wires `/ready` to 200, or lets `/trpc/book`
 * return the last ladder after a deep reorg, must fail here.
 */

const CHAIN_ID = 31_337;
const EDGE_SECRET = 'a-indexer-d26-p1-i3-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-indexer' });

type TrpcWire = {
  result?: { data?: { json?: unknown } | unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

class UnreachableChainSource implements ChainSource {
  constructor(readonly chainId: number) {}
  async head(): Promise<never> {
    throw new ChainUnavailableError('indexer.chain_unreachable', 'D26-P1-I3 Fastify refuse');
  }
  async blockAt(_height: number): Promise<never> {
    throw new ChainUnavailableError('indexer.chain_unreachable', 'D26-P1-I3 Fastify refuse');
  }
}

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

async function mountPublicDoor(indexer: Indexer, store: MemoryProjectionStore, chainSource: string) {
  const appRouter = createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 1,
    ingestEnabled: () => true,
    chainSource,
  });
  const app = Fastify({ logger: false });
  await registerIndexerPublicHttp(app, {
    indexer,
    appRouter,
    serviceName: 'svc-indexer',
    ingestEnabled: () => true,
    dbPing: async () => {
      /* Postgres is up — halt must still 503. */
    },
    createContext: ({ req }) => edgeContext(req),
  });
  await app.ready();
  apps.push(app);
  return app;
}

async function haltWithStaleBook() {
  const store = new MemoryProjectionStore(CHAIN_ID);
  const source = new MemoryChainSource(CHAIN_ID);
  source.append([{ kind: 'book_level', logIndex: 0, market: 'IFC-USD', side: 'bid', price: '100', quantity: '5' }]);
  for (let i = 0; i < 5; i++) source.append([]);

  const indexer = new Indexer({ source, store, finalityDepth: 1, ingestEnabled: () => true, startHeight: 0 });
  await indexer.sync();
  expect((await store.book('IFC-USD', 10)).bids).toHaveLength(1);

  source.reorg(0, [[], [], []]);
  await expect(indexer.sync()).rejects.toThrow(/deeper than retained history/);
  expect(indexer.halted).not.toBeNull();
  // Trap: the store still holds the dead-branch ladder. HTTP must not serve it.
  expect((await store.book('IFC-USD', 10)).bids).toHaveLength(1);
  return { indexer, store };
}

function regionHeaders(): Record<string, string> {
  return { 'x-intafaced-region': 'DE' };
}

async function getTrpc(app: ReturnType<typeof Fastify>, path: string, input: Record<string, unknown> = {}) {
  const qs = encodeURIComponent(JSON.stringify(input));
  const res = await app.inject({ method: 'GET', url: `/trpc/${path}?input=${qs}`, headers: regionHeaders() });
  return { statusCode: res.statusCode, body: res.json() as TrpcWire };
}

function trpcErrorCode(body: TrpcWire): string | undefined {
  return body.error?.data?.code;
}

function trpcResultJson(body: TrpcWire): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && data !== null && 'json' in data) {
    return (data as { json: unknown }).json;
  }
  return data;
}

describe('D26-P1-I3 Fastify door — halt refuses fake live books', () => {
  it('GET /ready is 503 with the halt reason; GET /health stays liveness', async () => {
    const { indexer, store } = await haltWithStaleBook();
    const app = await mountPublicDoor(indexer, store, 'memory');

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, service: 'svc-indexer' });
    expect(health.json()).not.toHaveProperty('custodial');

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    const body = ready.json() as { ready: boolean; reason: string; haltedAt?: string };
    expect(body.ready).toBe(false);
    expect(body.reason).toMatch(/re-index|retained history/);
    expect(typeof body.haltedAt).toBe('string');
  });

  it('GET /trpc/book does not return the dead-branch ladder as a live book', async () => {
    const { indexer, store } = await haltWithStaleBook();
    const app = await mountPublicDoor(indexer, store, 'memory');

    const book = await getTrpc(app, 'book', { market: 'IFC-USD', depth: 50 });
    expect(book.statusCode).toBe(503);
    expect(trpcErrorCode(book.body)).toBe('SERVICE_UNAVAILABLE');
    expect(book.body.error?.message).toMatch(/halted/i);
    const payload = JSON.stringify(trpcResultJson(book.body) ?? {});
    expect(payload).not.toMatch(/"bids"/);

    const status = await getTrpc(app, 'status');
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(trpcResultJson(status.body))).toMatch(/re-index|retained history/);
  });

  it('GET /trpc fills, markets, positions refuse — not empty arrays that look live', async () => {
    const { indexer, store } = await haltWithStaleBook();
    const app = await mountPublicDoor(indexer, store, 'memory');
    const account = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    for (const [path, input] of [
      ['fills', { market: 'IFC-USD', limit: 100 }],
      ['markets', {}],
      ['positions', { account }],
      ['accountFills', { account, limit: 100 }],
      ['position', { market: 'IFC-USD', account }],
      ['stream', { depth: 50 }],
    ] as const) {
      const res = await getTrpc(app, path, input);
      expect(res.statusCode, path).toBe(503);
      expect(trpcErrorCode(res.body), path).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.result, path).toBeUndefined();
    }
  });

  it('chain-door lastError: /ready 503 and /trpc/book refuses — status still names the code', async () => {
    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source: new UnreachableChainSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
    });
    await expect(indexer.sync()).rejects.toMatchObject({ code: 'indexer.chain_unreachable' });

    const app = await mountPublicDoor(indexer, store, 'evm');

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    const readyBody = ready.json() as { ready: boolean; reason: string };
    expect(readyBody.ready).toBe(false);
    expect(readyBody.reason).toMatch(/indexer\.chain_unreachable/);

    const book = await getTrpc(app, 'book', { market: 'IFC-USD', depth: 50 });
    expect(book.statusCode).toBe(503);
    expect(trpcErrorCode(book.body)).toBe('SERVICE_UNAVAILABLE');
    expect(book.body.error?.message).toMatch(/indexer\.chain_unreachable/);

    const status = await getTrpc(app, 'status');
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(trpcResultJson(status.body))).toMatch(/indexer\.chain_unreachable/);
  });

  it('venue_not_deployed lastError: /trpc/book 503 — not an empty live ladder', async () => {
    class MissingVenueSource implements ChainSource {
      constructor(readonly chainId: number) {}
      async head(): Promise<never> {
        throw new ChainUnavailableError('indexer.venue_not_deployed', 'no code at venue — would paint empty book');
      }
      async blockAt(_height: number): Promise<never> {
        throw new ChainUnavailableError('indexer.venue_not_deployed', 'no code at venue — would paint empty book');
      }
    }

    const store = new MemoryProjectionStore(CHAIN_ID);
    const indexer = new Indexer({
      source: new MissingVenueSource(CHAIN_ID),
      store,
      finalityDepth: 64,
      ingestEnabled: () => true,
    });
    await expect(indexer.sync()).rejects.toMatchObject({ code: 'indexer.venue_not_deployed' });

    const app = await mountPublicDoor(indexer, store, 'evm');

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect((ready.json() as { reason: string }).reason).toMatch(/indexer\.venue_not_deployed/);

    const book = await getTrpc(app, 'book', { market: 'IFC-USD', depth: 50 });
    expect(book.statusCode).toBe(503);
    expect(trpcErrorCode(book.body)).toBe('SERVICE_UNAVAILABLE');
    expect(book.body.error?.message).toMatch(/indexer\.venue_not_deployed/);
    expect(JSON.stringify(trpcResultJson(book.body) ?? {})).not.toMatch(/"bids"/);
  });
});

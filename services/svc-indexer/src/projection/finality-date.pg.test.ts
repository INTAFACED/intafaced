import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEdgeContext } from '@intafaced/contracts';
import { createDb } from '@intafaced/db';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryChainSource } from '../chain/memory-source.js';
import type { ChainEvent } from '../chain/source.js';
import { Indexer } from '../indexer.js';
import { createIndexerRouter } from '../router.js';
import { CHAIN_ID } from '../testing/conformance.js';
import { PostgresProjectionStore } from './postgres-store.js';

/**
 * Production boot calls `createDb`, and that call hands the same postgres.js
 * client to Drizzle. Drizzle replaces the timestamptz serializer with a
 * pass-through, so a `Date` bind reaches `Buffer.byteLength` and the ingest
 * pass dies before a height exists. `createTestDb` does not call Drizzle, so
 * the conformance suite never sees it. This file uses the production client.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrationFiles = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = migrationFiles.map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const FILL: ChainEvent = {
  kind: 'fill',
  logIndex: 0,
  market: 'IFC-USD',
  price: '100.5',
  quantity: '1.5',
  takerSide: 'buy',
  maker: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  taker: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

describe('svc-indexer finality on the production database client', () => {
  let db: TestDb;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset — shared test Postgres is required');
    db = await createTestDb({
      service: 'indexerdate',
      url,
      migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'indexer', schema)),
    });
    const production = createDb({ url, schema: db.schema, max: 2 }, {});
    close = () => production.close();
    db = { ...db, sql: production.sql };
  }, 120_000);

  afterAll(async () => {
    await close?.();
    await db?.drop();
  });

  it('reports finalized height and blocks behind after a block time is written', async () => {
    const source = new MemoryChainSource(CHAIN_ID);
    const first = source.append([FILL]);
    source.append([]);
    source.append([]);
    const store = new PostgresProjectionStore(db.sql, CHAIN_ID);
    const indexer = new Indexer({
      source,
      store,
      finalityDepth: 1,
      ingestEnabled: () => true,
      startHeight: 0,
    });

    await indexer.sync();
    expect(indexer.lastError).toBeNull();

    const caller = createEdgeContext({ secret: 'an-indexer-finality-date-edge-secret', serviceName: 'svc-indexer' });
    const router = createIndexerRouter({
      store,
      indexer,
      chainId: CHAIN_ID,
      finalityDepth: 1,
      ingestEnabled: () => true,
      chainSource: 'memory',
      chainProbe: async () => ({
        kind: 'null',
        rpcUrl: null,
        venue: null,
        reachable: true,
        observedChainId: CHAIN_ID,
        chainHeight: 5,
        venueDeployed: false,
        refusalCode: null,
        reason: null,
      }),
    });
    const status = await router.createCaller(caller({ headers: { 'x-intafaced-region': 'DE' }, id: 'finality-date' })).status();

    expect(status.indexedHeight).toBe(2);
    expect(status.finalizedHeight).toBe(1);
    expect(status.behindBy).toBe(3);
    expect(status.lastError).toBeNull();

    const fills = await store.recentFills('IFC-USD', 10);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.blockTime).toBeInstanceOf(Date);
    expect(fills[0]?.blockTime.toISOString()).toBe(new Date(first.timestamp * 1000).toISOString());
  });
});

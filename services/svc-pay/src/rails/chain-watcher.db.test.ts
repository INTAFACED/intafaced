/**
 * Dedicated test database — crash replay against real Postgres.
 * createTestDatabase owns a *_test name so this never TRUNCATEs the fleet.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRYPTO_NATIVE_WATCHER_ID,
  CryptoChainWatcher,
  PostgresChainWatcherCursorStore,
  PostgresChainWatcherDeadLetterStore,
  type ChainWatcherChain,
} from './chain-watcher.js';
import type { FinalizedInbound } from './evm-chain.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-pay chain-watcher is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const transfer = {
  txHash: '0xdbdead' as `0x${string}`,
  assetId: 'USDT',
  amount: 2_000_000n,
  from: '0x1111111111111111111111111111111111111111',
  confirmations: 6,
};
const address = '0x4444444444444444444444444444444444444444';
const item: FinalizedInbound = { address, transfer, blockNumber: 99n, logIndex: 1 };

describe('svc-pay chain-watcher (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('PostgresChainWatcherCursorStore — crash replay does not double-credit', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sql) throw new Error('H8a: svc-pay chain-watcher PG was not opened');
    await sql`TRUNCATE pay.chain_watcher_cursors`;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('save/load round-trips last-seen (block, hash, log index)', async () => {
    const store = new PostgresChainWatcherCursorStore(sql);
    expect(await store.load(CRYPTO_NATIVE_WATCHER_ID)).toBeNull();
    await store.save(CRYPTO_NATIVE_WATCHER_ID, { blockNumber: '99', txHash: '0xdbdead', logIndex: 1 });
    expect(await store.load(CRYPTO_NATIVE_WATCHER_ID)).toEqual({
      blockNumber: '99',
      txHash: '0xdbdead',
      logIndex: 1,
    });
  });

  it('a second watcher process sharing the table does not POST twice', async () => {
    const store = new PostgresChainWatcherCursorStore(sql);
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const makeChain = (): ChainWatcherChain & { marked: string[] } => {
      const marked: string[] = [];
      return {
        marked,
        refresh: async () => undefined,
        drainFinalized: () => (marked.length ? [] : [item]),
        markFinalizedEmitted: (addr) => {
          marked.push(addr.toLowerCase());
        },
      };
    };

    const first = makeChain();
    await new CryptoChainWatcher({
      chain: first,
      secret: 'x'.repeat(32),
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      cursorStore: store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const replay = makeChain();
    await new CryptoChainWatcher({
      chain: replay,
      secret: 'x'.repeat(32),
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      cursorStore: store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(replay.marked).toContain(address.toLowerCase());
  });

  it('will not rewind a later cursor', async () => {
    const store = new PostgresChainWatcherCursorStore(sql);
    await store.save(CRYPTO_NATIVE_WATCHER_ID, { blockNumber: '50', txHash: '0xaaa', logIndex: 0 });
    await store.save(CRYPTO_NATIVE_WATCHER_ID, { blockNumber: '40', txHash: '0xbbb', logIndex: 9 });
    expect(await store.load(CRYPTO_NATIVE_WATCHER_ID)).toEqual({
      blockNumber: '50',
      txHash: '0xaaa',
      logIndex: 0,
    });
  });

  it('a failing inbound is dead-lettered once in Postgres after the published attempts and frees the address', async () => {
    await sql`TRUNCATE pay.chain_watcher_dead_letters`;
    const store = new PostgresChainWatcherCursorStore(sql);
    const deadLetters = new PostgresChainWatcherDeadLetterStore(sql);
    const marked: string[] = [];
    const chain: ChainWatcherChain = {
      refresh: async () => undefined,
      drainFinalized: () => (marked.length ? [] : [item]),
      markFinalizedEmitted: (addr) => {
        marked.push(addr.toLowerCase());
      },
    };
    const fetchImpl = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    const watcher = new CryptoChainWatcher({
      chain,
      secret: 'x'.repeat(32),
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      cursorStore: store,
      deadLetters,
      maxDeliveryAttempts: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await watcher.tick();
    expect(await deadLetters.list()).toEqual([]);
    await watcher.tick();
    const rows = await deadLetters.list();
    expect(rows).toEqual([
      expect.objectContaining({ deliveryId: `chain:${transfer.txHash}:${address}:1`, attempts: 2, lastStatus: 502, blockNumber: '99' }),
    ]);
    await deadLetters.record(rows[0]!);
    expect(await deadLetters.list()).toHaveLength(1);
    expect(marked).toEqual([address.toLowerCase()]);
  });
});

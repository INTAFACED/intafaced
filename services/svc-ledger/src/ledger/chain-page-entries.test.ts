import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { verifyChain } from './reconcile.js';
import { truncateBook } from '../db/journal-guards.testkit.js';

/**
 * The hourly chain proof pages `ledger_tx` by seq. Entries for that page are
 * one read. A round trip per transaction is the failure this file refuses.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run schema via `createTestDb`). Local without that env
 * starts Testcontainers `postgres:16-alpine`. Docker/PG down is a failed suite,
 * not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const H8A_IMAGE = 'postgres:16-alpine';
const USER = '99999999-9999-4999-8999-999999999999';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

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
      `H8a: chain page entries is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

/** Counts `ledger_entries` round trips verifyChain issues. Posting is not counted. */
function watchEntryReads(sql: Sql): { sql: Sql; entryReads: () => number } {
  let entryReads = 0;
  const watched = new Proxy(sql, {
    apply(target, _thisArg, args: unknown[]) {
      const head = args[0];
      const text = Array.isArray(head) ? head.join(' ') : '';
      if (text.includes('ledger_entries')) entryReads += 1;
      return Reflect.apply(target, target, args);
    },
  }) as Sql;
  return { sql: watched, entryReads: () => entryReads };
}

describe('chain page entries PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('verifyChain loads a page of entries in one round trip', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  const reset = async () => {
    await truncateBook(db!.sql, 'ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE');
    await db!.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
  };

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'l823page', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('a page of more than one transaction is one ledger_entries query', async () => {
    await reset();
    await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'page-1' }));
    await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('20.5'), rail: 'test', railRef: 'page-2' }));

    const watched = watchEntryReads(db!.sql);
    const pageSize = 2;
    const result = await verifyChain(watched.sql, pageSize);

    expect(result).toEqual({ ok: true, length: pageSize });
    expect(watched.entryReads()).toBe(1);
  });
});

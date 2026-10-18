import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { parseAmount, recipes } from '@intafaced/ledger-client';
import { LedgerService } from '../service.js';
import { runScheduledReconciliation, type ScheduledReconcileResult } from './reconcile.js';
import { runScheduledReconciliationTick } from './scheduled-reconcile-tick.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
let db: TestDb;
let pool: Sql;
beforeAll(async () => {
  db = await createTestDb({
    service: 'reconcile_timeout_regression',
    url: process.env.TEST_DATABASE_URL,
    migrations: readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .sort()
      .map((file) => (schema: string) => rewriteSchemaSql(readFileSync(join(migrationsDir, file), 'utf8'), 'ledger', schema)),
  });
  pool = postgres(db.url, {
    max: 3,
    connection: { search_path: `${db.schema},public`, statement_timeout: 1000 },
    onnotice: () => undefined,
  });
});
afterAll(async () => {
  await pool?.end({ timeout: 1 });
  await db?.drop();
});

it('a real scheduled PostgreSQL statement timeout must not durably freeze posting and a later tick retries successfully', async () => {
  const ledger = new LedgerService(pool, new MemoryEventBus('timeout-regression'));
  await ledger.post(
    recipes.deposit({
      userId: '55555555-5555-4555-8555-555555555555',
      assetId: 'USDT',
      amount: parseAmount('1'),
      rail: 'test',
      railRef: 'timeout-regression',
    }),
  );
  const blocker = await db.sql.reserve();
  const logs: Array<{ errorCode?: string }> = [];
  // This call shape also drives the original scheduled runner: that runner's
  // 1s pool limit cancels the real blocked SQL before it could use arg three.
  const run = runScheduledReconciliation as unknown as (
    sql: Sql,
    ledger: LedgerService,
    options: { statementTimeoutMs: number },
  ) => Promise<ScheduledReconcileResult>;
  try {
    await blocker.unsafe('BEGIN');
    await blocker.unsafe('LOCK TABLE ledger_entries IN ACCESS EXCLUSIVE MODE');
    await runScheduledReconciliationTick(() => run(pool, ledger, { statementTimeoutMs: 1000 }), ledger, {
      fatal(detail) {
        logs.push(detail);
      },
    });
  } finally {
    await blocker.unsafe('ROLLBACK');
    blocker.release();
  }
  // The symptom first: baseline wrongly writes a durable reconciliation freeze.
  await expect(ledger.status()).resolves.toMatchObject({ postingEnabled: true });
  expect(logs).toContainEqual(expect.objectContaining({ outcome: 'incomplete', errorCode: '57014' }));
  expect((await db.sql`SELECT outcome, error_code FROM reconcile_runs`).map((r) => [r.outcome, r.error_code])).toEqual([
    ['incomplete', '57014'],
  ]);
  await runScheduledReconciliationTick(() => run(pool, ledger, { statementTimeoutMs: 1000 }), ledger, { fatal() {} });
  expect((await db.sql`SELECT outcome FROM reconcile_runs ORDER BY id`).map((r) => r.outcome)).toEqual(['incomplete', 'ok']);
  await expect(ledger.status()).resolves.toMatchObject({ postingEnabled: true });
});

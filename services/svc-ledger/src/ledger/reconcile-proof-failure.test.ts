import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { hashTx, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { LedgerService } from '../service.js';
import { runScheduledReconciliation } from './reconcile.js';
import { createReconcileTickState, runScheduledReconciliationTick } from './scheduled-reconcile-tick.js';
import { truncateBook, withJournalGuardsOff } from '../db/journal-guards.testkit.js';

/**
 * Opus review of PR #4819, plus D-128. Real Postgres.
 *
 * A stored sum that does not fit numeric(38,18), a posted_at of infinity, and a
 * non-Postgres throw freeze posting. A Postgres error stays incomplete until
 * three consecutive runs, then freezes as reconcile_unproven.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const USER_A = '55555555-5555-4555-8555-555555555555';
const USER_B = '66666666-6666-4666-8666-666666666666';
/** 20 integer digits: fits numeric(38,18). Twice that does not. */
const FITS = '60000000000000000000';

let db: TestDb;
let seq = 0;

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is required — this file does not start a database');
  db = await createTestDb({ service: 'ledgerprooffail', url, migrations });
}, 120_000);

beforeEach(async () => {
  await truncateBook(
    db.sql,
    'reconcile_runs, ledger_freeze_outbox, ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE',
  );
  await db.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
  await db.sql`UPDATE posting_freeze SET frozen = false, reason = NULL, actor = NULL WHERE id = true`;
});

afterAll(async () => {
  await db?.drop();
}, 30_000);

function connect(): Sql {
  return postgres(db.url, {
    max: 2,
    connection: { search_path: `${db.schema},public`, application_name: `${db.schema}_proof` },
    onnotice: () => undefined,
  });
}

function service(sql: Sql, bus = new MemoryEventBus('proof-failure')) {
  return { svc: new LedgerService(sql, bus), bus };
}

const deposit = (userId: string) =>
  recipes.deposit({ userId, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: `proof-${++seq}` });

async function rehashBook(sql: Sql): Promise<void> {
  const txs = await sql<Array<{ id: string; module: string; reason: string; posted_at: Date }>>`
    SELECT id, module, reason, posted_at FROM ledger_tx ORDER BY seq ASC
  `;
  let previous: string | null = null;
  for (const tx of txs) {
    const entries = await sql<
      Array<{ id: string; account_id: string; asset_id: string; direction: 'debit' | 'credit'; amount: string }>
    >`
      SELECT id::text AS id, account_id, asset_id, direction, amount::text AS amount
        FROM ledger_entries
       WHERE tx_id = ${tx.id}
       ORDER BY id ASC
    `;
    const hash = hashTx(
      {
        id: tx.id,
        module: tx.module,
        reason: tx.reason,
        postedAt: tx.posted_at,
        entries: entries.map((entry) => ({
          id: entry.id,
          txId: tx.id,
          accountId: entry.account_id,
          assetId: entry.asset_id,
          direction: entry.direction,
          amount: amt(entry.amount),
          balanceAfter: 0n,
        })),
      },
      previous,
    );
    await sql`UPDATE ledger_tx SET hash = ${hash}, previous_hash = ${previous} WHERE id = ${tx.id}`;
    await sql`UPDATE ledger_posted_keys SET posted_hash = ${hash} WHERE tx_id = ${tx.id}`;
    previous = hash;
  }
  await sql`UPDATE chain_tip SET hash = ${previous} WHERE id = true`;
}

async function withTamper<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  return withJournalGuardsOff(sql, ['update', 'balance'], async () => {
    await sql.unsafe(`ALTER TABLE ledger_posted_keys DISABLE TRIGGER ledger_posted_keys_immutable`);
    try {
      return await fn();
    } finally {
      await sql.unsafe(`ALTER TABLE ledger_posted_keys ENABLE TRIGGER ledger_posted_keys_immutable`);
    }
  });
}

describe('reconciliation failed proofs — real book', () => {
  it('a per-account replay sum past numeric(38,18) freezes as corruption, with the chain still intact', async () => {
    const sql = connect();
    try {
      const { svc } = service(sql);
      await svc.post(deposit(USER_A));
      await withTamper(sql, async () => {
        await sql`
          UPDATE ledger_entries
             SET amount = ${FITS}::numeric, balance_after = ${FITS}::numeric
           WHERE account_id IN (SELECT id FROM accounts WHERE owner_type = 'user')
        `;
        await sql`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          SELECT tx_id, account_id, asset_id, 'debit', ${FITS}::numeric, ${FITS}::numeric
            FROM ledger_entries
           WHERE account_id IN (SELECT id FROM accounts WHERE owner_type = 'user')
        `;
        await sql`UPDATE accounts SET balance = 0`;
        await rehashBook(sql);
      });
      const result = await runScheduledReconciliation(sql, svc);
      expect(result.outcome).toBe('mismatch');
      if (result.outcome !== 'mismatch') throw new Error('replay overflow was treated as unfinished');
      expect(result.report.chain).toMatchObject({ ok: true });
      expect(result.report.corruptAmountFields).toContain('ledger_entries.amount');
      await expect(svc.status()).resolves.toMatchObject({ postingEnabled: false, frozenReason: 'reconciliation mismatch' });
      expect((await sql`SELECT outcome FROM reconcile_runs`).map((row) => row.outcome)).toEqual(['mismatch']);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('an asset total past numeric(38,18) freezes as corruption when each account still matches its replay', async () => {
    const sql = connect();
    try {
      const { svc } = service(sql);
      await svc.post(deposit(USER_A));
      await svc.post(deposit(USER_B));
      await withTamper(sql, async () => {
        await sql`
          UPDATE ledger_entries AS e
             SET amount = ${FITS}::numeric, balance_after = ${FITS}::numeric
            FROM accounts a
           WHERE e.account_id = a.id AND a.owner_type = 'user' AND e.direction = 'debit'
        `;
        await sql`UPDATE accounts SET balance = ${FITS}::numeric WHERE owner_type = 'user'`;
        await rehashBook(sql);
      });
      const result = await runScheduledReconciliation(sql, svc);
      expect(result.outcome).toBe('mismatch');
      if (result.outcome !== 'mismatch') throw new Error('asset-total overflow was treated as unfinished');
      expect(result.report.balances.ok).toBe(true);
      expect(result.report.chain).toMatchObject({ ok: true });
      expect(result.report.corruptAmountFields).toContain('accounts.balance');
      await expect(svc.status()).resolves.toMatchObject({ postingEnabled: false, frozenReason: 'reconciliation mismatch' });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('posted_at of infinity is a broken chain row and freezes', async () => {
    const sql = connect();
    try {
      const { svc } = service(sql);
      await svc.post(deposit(USER_A));
      const [tx] = await sql<Array<{ id: string }>>`SELECT id FROM ledger_tx`;
      await withTamper(sql, async () => {
        await sql`UPDATE ledger_tx SET posted_at = 'infinity'`;
      });
      const result = await runScheduledReconciliation(sql, svc);
      expect(result.outcome).toBe('mismatch');
      if (result.outcome !== 'mismatch') throw new Error('invalid posted_at was treated as unfinished');
      expect(result.report.chain).toEqual({ ok: false, brokenAt: tx!.id, length: 0 });
      await expect(svc.status()).resolves.toMatchObject({ postingEnabled: false, frozenReason: 'reconciliation mismatch' });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('a non-Postgres error freezes as a failed proof', async () => {
    const sql = connect();
    try {
      const { svc } = service(sql);
      await svc.post(deposit(USER_A));
      const result = await runScheduledReconciliation(sql, svc, {
        async prove() {
          throw new Error('proof blew up');
        },
      });
      expect(result.outcome).toBe('mismatch');
      await expect(svc.status()).resolves.toMatchObject({
        postingEnabled: false,
        frozenReason: 'reconciliation mismatch',
        frozenBy: 'reconciliation',
      });
      expect((await sql`SELECT outcome FROM reconcile_runs`).map((row) => row.outcome)).toEqual(['mismatch']);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('two Postgres errors stay incomplete and the third freezes as reconcile_unproven, alerting each run', async () => {
    const sql = connect();
    try {
      const bus = new MemoryEventBus('proof-failure');
      const { svc } = service(sql, bus);
      await svc.post(deposit(USER_A));
      const state = createReconcileTickState();
      const log = { fatal() {} };
      const fail = () =>
        runScheduledReconciliation(sql, svc, {
          async prove(tx) {
            await tx.unsafe(`SELECT 'not-a-number'::int`);
            throw new Error('expected the cast to fail');
          },
        });
      const tick = () =>
        runScheduledReconciliationTick(fail, svc, log, { state, maxConsecutiveIncomplete: 3 });
      await tick();
      await tick();
      await expect(svc.status()).resolves.toMatchObject({ postingEnabled: true });
      expect(await sql`SELECT count(*)::int AS n FROM reconcile_runs WHERE outcome = 'incomplete'`).toEqual([{ n: 2 }]);
      await tick();
      await expect(svc.status()).resolves.toMatchObject({ postingEnabled: true });
      expect(await sql`SELECT count(*)::int AS n FROM reconcile_runs WHERE outcome = 'incomplete'`).toEqual([{ n: 2 }]);
      await tick();
      await expect(svc.status()).resolves.toMatchObject({
        postingEnabled: false,
        frozenReason: 'reconcile_unproven',
        frozenBy: 'reconciliation',
      });
      const runs = await sql`SELECT outcome, error_code FROM reconcile_runs ORDER BY id`;
      expect(runs.map((row) => [row.outcome, row.error_code])).toEqual([
        ['incomplete', '22P02'],
        ['incomplete', '22P02'],
        ['incomplete', '22P02'],
      ]);
      expect(bus.emitted('ledgerReconciliationRunFailed')).toHaveLength(3);
      expect(bus.emitted('ledgerReconciliationRunFailed').map((event) => event.payload)).toEqual([
        { errorCode: '22P02', phase: 'proof', consecutiveIncomplete: 1, runId: expect.any(String) },
        { errorCode: '22P02', phase: 'proof', consecutiveIncomplete: 2, runId: expect.any(String) },
        { errorCode: '22P02', phase: 'proof', consecutiveIncomplete: 3, runId: expect.any(String) },
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

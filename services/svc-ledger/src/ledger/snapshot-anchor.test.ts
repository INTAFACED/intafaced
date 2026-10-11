import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { runScheduledReconciliation, type ReconciliationReport } from './reconcile.js';

/**
 * A balance snapshot names the chain tip it locked.
 *
 * The hourly job used to read balances under an as_of taken before the query
 * and write no tip. A post could commit between the proof and that insert and
 * be recorded as the anchor. The lock is `SELECT … FOR UPDATE` on the singleton
 * `chain_tip` row, held from before the proof until the insert commits.
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
      `H8a: snapshot anchor is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

function failedReport(): ReconciliationReport {
  return {
    ok: false,
    ranAt: new Date(),
    balances: { ok: false, drift: [], accountsChecked: 1 },
    chain: { ok: true, length: 1 },
    totals: { USDT: '1' },
    unbalancedAssets: ['USDT'],
  };
}

function greenReport(): ReconciliationReport {
  return {
    ok: true,
    ranAt: new Date(),
    balances: { ok: true, accountsChecked: 1 },
    chain: { ok: true, length: 1 },
    totals: { USDT: '0' },
    unbalancedAssets: [],
  };
}

describe('snapshot anchor PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('balance snapshot names the chain tip it locked', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  const reset = async () => {
    await db!.sql`
      TRUNCATE ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE
    `;
    await db!.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
  };

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledgersnap', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const deposit = (railRef: string) => recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('25'), rail: 'test', railRef });

  it('snapshot rows carry the tip seq and hash read under the lock, not a commit that waited on it', async () => {
    await reset();
    await engine.post(deposit('anchor-1'));
    const [tip] = await db!.sql<Array<{ seq: string; hash: string | null }>>`
      SELECT seq::text AS seq, hash FROM chain_tip WHERE id = true
    `;
    expect(tip?.hash).toEqual(expect.any(String));
    expect(tip?.seq).toEqual(expect.any(String));

    let releaseProof: () => void = () => undefined;
    const proofHolding = new Promise<void>((resolve) => {
      releaseProof = resolve;
    });
    let proofEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      proofEntered = resolve;
    });
    let balancesUnderLock: Array<{ id: string; balance: string }> = [];

    const scheduled = runScheduledReconciliation(db!.sql, {
      async reconcile() {
        await expect(db!.sql`SELECT seq FROM chain_tip WHERE id = true FOR UPDATE NOWAIT`).rejects.toMatchObject({
          code: '55P03',
        });
        balancesUnderLock = await db!.sql<Array<{ id: string; balance: string }>>`
          SELECT id::text AS id, balance::text AS balance FROM accounts ORDER BY id
        `;
        proofEntered();
        await proofHolding;
        return greenReport();
      },
    });

    await entered;

    const posting = engine.post(deposit('anchor-2'));
    const deadline = Date.now() + 5_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const [row] = await db!.sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n
          FROM pg_stat_activity
         WHERE application_name = ${db!.schema}
           AND wait_event_type = 'Lock'
           AND query ILIKE '%chain_tip%'
      `;
      if (row?.n !== '0') {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting, 'a post in the gap must queue on the tip lock').toBe(true);

    releaseProof();
    const result = await scheduled;
    await posting;

    expect(result.snapshotted).toBe(true);
    expect(result.report.ok).toBe(true);

    const rows = await db!.sql<
      Array<{
        account_id: string;
        balance: string;
        chain_tip_seq: string;
        chain_tip_hash: string | null;
        through_entry_id: string | null;
        as_of: Date;
      }>
    >`
      SELECT account_id::text AS account_id,
             balance::text AS balance,
             chain_tip_seq::text AS chain_tip_seq,
             chain_tip_hash,
             through_entry_id,
             as_of
        FROM balance_snapshots
       ORDER BY account_id
    `;

    expect(rows.length).toBe(balancesUnderLock.length);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      expect(row.account_id).toBe(balancesUnderLock[i]!.id);
      expect(typeof row.balance).toBe('string');
      expect(row.balance).toBe(balancesUnderLock[i]!.balance);
      expect(row.chain_tip_seq).toBe(tip!.seq);
      expect(row.chain_tip_hash).toBe(tip!.hash);
      expect(row.through_entry_id).toBeNull();
      expect(row.as_of).toBeInstanceOf(Date);
      expect(Math.abs(row.as_of.getTime() - Date.now())).toBeLessThan(60_000);
    }

    const [after] = await db!.sql<Array<{ seq: string; hash: string | null }>>`
      SELECT seq::text AS seq, hash FROM chain_tip WHERE id = true
    `;
    expect(after!.seq).not.toBe(tip!.seq);
    expect(after!.hash).not.toBe(tip!.hash);
  }, 30_000);

  it('a failed proof writes no snapshot', async () => {
    await reset();
    await engine.post(deposit('anchor-fail'));
    const [before] = await db!.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM balance_snapshots`;
    expect(before!.n).toBe('0');

    let locked = false;
    const result = await runScheduledReconciliation(db!.sql, {
      async reconcile() {
        await expect(db!.sql`SELECT seq FROM chain_tip WHERE id = true FOR UPDATE NOWAIT`).rejects.toMatchObject({
          code: '55P03',
        });
        locked = true;
        return failedReport();
      },
    });

    expect(locked).toBe(true);
    expect(result.snapshotted).toBe(false);
    expect(result.report.ok).toBe(false);
    const [after] = await db!.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM balance_snapshots`;
    expect(after!.n).toBe('0');
  });
});

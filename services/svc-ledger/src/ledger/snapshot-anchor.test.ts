import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { runSnapshotReconciliation, type ReconciliationReport } from './reconcile.js';

/**
 * A balance snapshot names the chain tip its own proof read.
 *
 * The hourly job used to read balances under an as_of taken before the query
 * and write no tip. A post could commit between the proof and that insert and
 * be recorded as the anchor. Migration 0015 closed that by holding the
 * `chain_tip` row lock from before the proof until the insert committed.
 *
 * Since #4755 there is no tip lock: the proof, the tip read and the snapshot
 * INSERT..SELECT all run inside ONE REPEATABLE READ snapshot, so the rows are
 * pinned to the proof's tip by construction, and a post that commits meanwhile
 * is neither blocked nor recorded. These tests pin both halves.
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

describe('balance snapshot names the chain tip its own proof read', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  const reset = async () => {
    await db!.sql`
      TRUNCATE reconcile_runs, ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE
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

  it('snapshot rows carry the tip the proof read, even when a post commits between the proof and the insert', async () => {
    await reset();
    await engine.post(deposit('anchor-1'));
    const [tip] = await db!.sql<Array<{ seq: string; hash: string | null; entry: string }>>`
      SELECT seq::text AS seq, hash, (SELECT max(id)::text FROM ledger_entries) AS entry FROM chain_tip WHERE id = true
    `;
    expect(tip?.hash).toEqual(expect.any(String));
    expect(tip?.seq).toEqual(expect.any(String));

    let balancesUnderSnapshot: Array<{ id: string; balance: string }> = [];
    let postedWhileProofOpen = false;

    const run = await runSnapshotReconciliation(db!.sql, {
      async prove(tx) {
        balancesUnderSnapshot = await tx<Array<{ id: string; balance: string }>>`
          SELECT id::text AS id, balance::text AS balance FROM accounts ORDER BY id
        `;
        // A post on ANOTHER connection commits while the proof's snapshot is open. It must neither
        // wait for the proof (no tip lock) nor appear in it.
        await Promise.race([
          engine.post(deposit('anchor-2')),
          new Promise((_, reject) => setTimeout(() => reject(new Error('the post waited for the proof: a lock is held')), 5_000)),
        ]);
        postedWhileProofOpen = true;
        return greenReport();
      },
    });

    expect(postedWhileProofOpen).toBe(true);
    expect(run.outcome).toBe('ok');
    if (run.outcome !== 'ok') return;
    expect(run.snapshotted).toBe(true);
    expect(run.tip).toMatchObject({ seq: tip!.seq, hash: tip!.hash, throughEntryId: tip!.entry });

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

    expect(rows.length).toBe(balancesUnderSnapshot.length);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      expect(row.account_id).toBe(balancesUnderSnapshot[i]!.id);
      expect(typeof row.balance).toBe('string');
      // The balances the proof read, NOT the ones after the in-between post.
      expect(row.balance).toBe(balancesUnderSnapshot[i]!.balance);
      expect(row.chain_tip_seq).toBe(tip!.seq);
      expect(row.chain_tip_hash).toBe(tip!.hash);
      expect(row.through_entry_id).toBe(tip!.entry);
      expect(row.as_of).toBeInstanceOf(Date);
      expect(Math.abs(row.as_of.getTime() - Date.now())).toBeLessThan(60_000);
    }

    const [after] = await db!.sql<Array<{ seq: string; hash: string | null }>>`
      SELECT seq::text AS seq, hash FROM chain_tip WHERE id = true
    `;
    expect(after!.seq).not.toBe(tip!.seq);
    expect(after!.hash).not.toBe(tip!.hash);

    // The run row names the same tip.
    const [recorded] = await db!.sql<
      Array<{ outcome: string; through_seq: string; tip_hash: string | null; through_entry_id: string | null }>
    >`
      SELECT outcome, through_seq::text AS through_seq, tip_hash, through_entry_id FROM reconcile_runs
    `;
    expect(recorded).toEqual({ outcome: 'ok', through_seq: tip!.seq, tip_hash: tip!.hash, through_entry_id: tip!.entry });
  }, 30_000);

  it('a failed proof writes no snapshot, records a mismatch run, and takes no tip lock', async () => {
    await reset();
    await engine.post(deposit('anchor-fail'));
    const [before] = await db!.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM balance_snapshots`;
    expect(before!.n).toBe('0');

    let tipFree = false;
    const run = await runSnapshotReconciliation(db!.sql, {
      async prove() {
        // FOR UPDATE NOWAIT on the singleton succeeds: the proof holds no lock on it.
        await db!.sql`SELECT seq FROM chain_tip WHERE id = true FOR UPDATE NOWAIT`;
        tipFree = true;
        return failedReport();
      },
    });

    expect(tipFree).toBe(true);
    expect(run.outcome).toBe('mismatch');
    if (run.outcome === 'mismatch') expect(run.snapshotted).toBe(false);
    const [after] = await db!.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM balance_snapshots`;
    expect(after!.n).toBe('0');
    const runs = await db!.sql<
      Array<{ outcome: string; through_seq: string }>
    >`SELECT outcome, through_seq::text AS through_seq FROM reconcile_runs`;
    expect(runs).toEqual([{ outcome: 'mismatch', through_seq: '1' }]);
  });

  it('mixed deploy: pre-0015 snapshot rows with no recorded tip are tolerated and left untouched', async () => {
    await reset();
    await engine.post(deposit('anchor-legacy'));
    const [account] = await db!.sql<Array<{ id: string }>>`SELECT id::text AS id FROM accounts WHERE owner_type = 'user'`;
    // A row exactly as an old pod wrote it before 0015: no chain_tip_seq, no chain_tip_hash, no through_entry_id.
    await db!.sql`
      INSERT INTO balance_snapshots (account_id, as_of, balance) VALUES (${account!.id}, now() - interval '2 hours', 25)
    `;

    const run = await runSnapshotReconciliation(db!.sql);
    expect(run.outcome).toBe('ok');

    const rows = await db!.sql<Array<{ chain_tip_seq: string | null; chain_tip_hash: string | null; through_entry_id: string | null }>>`
      SELECT chain_tip_seq::text AS chain_tip_seq, chain_tip_hash, through_entry_id FROM balance_snapshots ORDER BY id
    `;
    expect(rows[0]).toEqual({ chain_tip_seq: null, chain_tip_hash: null, through_entry_id: null });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(1).every((row) => row.chain_tip_seq === '1' && row.chain_tip_hash !== null)).toBe(true);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { LedgerService } from '../service.js';
import { reconcileGauges, registerMetrics } from '../metrics.js';
import { lastVerifiedFields, registerLedgerStatusHttp } from '../status-http.js';
import {
  RECONCILE_LOCK_SQL,
  readLastVerified,
  runReconciliation,
  runScheduledReconciliation,
  runSnapshotReconciliation,
} from './reconcile.js';
import { truncateBook } from '../db/journal-guards.testkit.js';
import type { ReconciliationReport } from './reconcile.js';

/**
 * #4755 — reconciliation proves from one REPEATABLE READ snapshot, takes no
 * chain_tip lock, separates "could not finish" from "found a mismatch", and
 * lets exactly one run go at a time. Real Postgres (TEST_DATABASE_URL); nothing
 * here is stubbed except the `prove` seam where a test needs to act mid-proof.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));
const DOWN_0022 = readFileSync(join(drizzleDir, '0022_reconcile_runs.down.sql'), 'utf8');

const USER = '55555555-5555-4555-8555-555555555555';
let seq = 0;
const deposit = () => recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: `snap-${++seq}` });

const greenReport = (): ReconciliationReport => ({
  ok: true,
  ranAt: new Date(),
  balances: { ok: true, accountsChecked: 1 },
  chain: { ok: true, length: 1 },
  totals: { USDT: '0' },
  unbalancedAssets: [],
});
const failedReport = (): ReconciliationReport => ({
  ok: false,
  ranAt: new Date(),
  balances: { ok: false, drift: [], accountsChecked: 1 },
  chain: { ok: true, length: 1 },
  totals: { USDT: '1' },
  unbalancedAssets: ['USDT'],
});

describe('reconciliation snapshot runner — real book', () => {
  let db: TestDb | undefined;
  let open: Sql[] = [];
  const d = (): TestDb => {
    if (!db) throw new Error('db not open');
    return db;
  };

  function connect(max = 2): Sql {
    const opened = d();
    const sql = postgres(opened.url, {
      max,
      connection: { search_path: `${opened.schema},public`, application_name: `${opened.schema}_snap` },
      onnotice: () => undefined,
    });
    open.push(sql);
    return sql;
  }
  const service = (sql: Sql, options: { reconcileStatementTimeoutMs?: number } = {}) =>
    new LedgerService(sql, new MemoryEventBus('snap'), options);

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is required — this file does not start a database');
    db = await createTestDb({ service: 'ledgersnaprun', url, migrations });
  }, 120_000);

  beforeEach(async () => {
    await truncateBook(
      d().sql,
      'reconcile_runs, ledger_freeze_outbox, ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE',
    );
    await d().sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
    await d().sql`UPDATE posting_freeze SET frozen = false, reason = NULL, actor = NULL WHERE id = true`;
  });

  afterEach(async () => {
    const sqls = open;
    open = [];
    await Promise.all(sqls.map((s) => s.end({ timeout: 5 })));
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('a post commits WHILE the proof runs: no tip lock, the post is not blocked and is not in the verdict', async () => {
    const sql = connect();
    const poster = service(connect());
    await poster.post(deposit());
    let postedMidProof = false;
    const run = await runSnapshotReconciliation(sql, {
      async prove(tx) {
        // The snapshot is open. A post from a second connection must complete (no FOR UPDATE on chain_tip held).
        await Promise.race([
          poster.post(deposit()),
          new Promise((_, reject) => setTimeout(() => reject(new Error('post blocked behind the proof')), 5_000)),
        ]);
        postedMidProof = true;
        const [tip] = await tx<Array<{ seq: string }>>`SELECT seq::text AS seq FROM chain_tip WHERE id = true`;
        expect(tip?.seq).toBe('1'); // the snapshot still sees only the first post
        return greenReport();
      },
    });
    expect(postedMidProof).toBe(true);
    expect(run).toMatchObject({ outcome: 'ok', tip: { seq: '1' } });
    const [now] = await d().sql<Array<{ seq: string }>>`SELECT seq::text AS seq FROM chain_tip WHERE id = true`;
    expect(now?.seq).toBe('2');
  });

  it('the real proof stays ok while posts keep landing (no false ok:false from a tip read after the last page)', async () => {
    const poster = service(connect());
    const prover = service(connect());
    for (let i = 0; i < 5; i++) await poster.post(deposit());
    let stop = false;
    const background = (async () => {
      while (!stop) await poster.post(deposit());
    })();
    try {
      for (let i = 0; i < 3; i++) {
        const report = await prover.reconcile();
        expect(report.ok).toBe(true);
      }
    } finally {
      stop = true;
      await background;
    }
  }, 60_000);

  it('single-flight: a run is SKIPPED, quietly and writing nothing, while another holds the lock', async () => {
    const holder = await d().sql.reserve();
    try {
      // The same key a replica or an operator request takes; held for the whole session here.
      await holder.unsafe(`SELECT pg_advisory_lock(${RECONCILE_LOCK_SQL})`);
      const run = await runSnapshotReconciliation(connect());
      expect(run).toEqual({ outcome: 'skipped' });
      await expect(d().sql`SELECT 1 FROM reconcile_runs`).resolves.toHaveLength(0);
      await expect(d().sql`SELECT 1 FROM balance_snapshots`).resolves.toHaveLength(0);
      // The operator door says so instead of reporting a verdict.
      await expect(service(connect()).reconcile()).rejects.toMatchObject({ code: 'ledger.reconcile_in_progress' });
      await holder.unsafe(`SELECT pg_advisory_unlock(${RECONCILE_LOCK_SQL})`);
    } finally {
      holder.release();
    }
    expect((await runSnapshotReconciliation(connect())).outcome).toBe('ok');
  });

  it('two runs started together: exactly one proves, the other skips', async () => {
    await service(connect()).post(deposit());
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runSnapshotReconciliation(connect(), {
      async prove() {
        enter();
        await gate;
        return greenReport();
      },
    });
    await entered;
    const second = await runSnapshotReconciliation(connect());
    release();
    expect(second.outcome).toBe('skipped');
    expect((await first).outcome).toBe('ok');
  });

  it('single-flight remains held during the short snapshot write after the proof committed', async () => {
    await service(connect()).post(deposit());
    const blocker = await d().sql.reserve();
    let first: Promise<Awaited<ReturnType<typeof runSnapshotReconciliation>>> | undefined;
    let backend: number | undefined;
    try {
      await blocker.unsafe('BEGIN');
      await blocker.unsafe('SELECT id FROM accounts FOR UPDATE');
      first = runSnapshotReconciliation(connect(), {
        async prove(tx) {
          backend = (await tx<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
          return runReconciliation(tx);
        },
      });
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (backend !== undefined) {
          const rows = await d()
            .sql`SELECT 1 FROM pg_stat_activity WHERE pid = ${backend} AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO balance_snapshots%'`;
          if (rows.length) {
            waiting = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(await runSnapshotReconciliation(connect())).toEqual({ outcome: 'skipped' });
    } finally {
      await blocker.unsafe('ROLLBACK');
      blocker.release();
      if (first) expect((await first).outcome).toBe('ok');
    }
    expect((await d().sql`SELECT outcome FROM reconcile_runs`).map((row) => row.outcome)).toEqual(['ok']);
  });

  it('failed advisory unlock closes only the proof session, releases its lock, and leaves the posting pool usable', async () => {
    const postingPool = connect(1);
    const first = await runSnapshotReconciliation(postingPool, {
      async prove(tx) {
        const unsafe = tx.unsafe.bind(tx);
        vi.spyOn(tx, 'unsafe').mockImplementation((...args) => {
          if (args[0].includes('pg_advisory_unlock')) throw new Error('injected unlock connection failure');
          return unsafe(...args);
        });
        return runReconciliation(tx);
      },
    });
    expect(first.outcome).toBe('ok');
    await expect(postingPool`SELECT 1`).resolves.toHaveLength(1);
    await expect(service(postingPool).post(deposit())).resolves.toMatchObject({ module: 'ledger' });
    expect((await runSnapshotReconciliation(postingPool)).outcome).toBe('ok');
  });

  it('a completed structural mismatch commits its halt and outbox even when no caller publishes it', async () => {
    await service(connect()).post(deposit());
    await d().sql`DELETE FROM chain_tip WHERE id = true`;
    try {
      expect((await runSnapshotReconciliation(connect())).outcome).toBe('mismatch');
      expect((await d().sql`SELECT outcome FROM reconcile_runs`).map((row) => row.outcome)).toEqual(['mismatch']);
      expect((await d().sql`SELECT frozen, actor FROM posting_freeze`)[0]).toMatchObject({ frozen: true, actor: 'reconciliation' });
      expect(await d().sql`SELECT 1 FROM ledger_freeze_outbox WHERE published_at IS NULL`).toHaveLength(1);
    } finally {
      await d().sql`INSERT INTO chain_tip (id, hash, seq) VALUES (true, NULL, 0)`;
    }
  });

  it('last verified never moves back to an older prefix if older evidence is recorded later', async () => {
    await d().sql`INSERT INTO reconcile_runs (started_at, outcome, through_seq) VALUES (now(), 'ok', 20), (now(), 'ok', 10)`;
    expect((await readLastVerified(d().sql)).seq).toBe('20');
  });

  it('applies the per-run statement_timeout inside the transaction only (default 10 min, env override)', async () => {
    const seen: string[] = [];
    const probe = (tx: Sql) => tx<Array<{ statement_timeout: string }>>`SHOW statement_timeout`;
    await runSnapshotReconciliation(connect(), {
      async prove(tx) {
        seen.push((await probe(tx as unknown as Sql))[0]!.statement_timeout);
        return greenReport();
      },
    });
    await runSnapshotReconciliation(connect(), {
      statementTimeoutMs: 2_000,
      async prove(tx) {
        seen.push((await probe(tx as unknown as Sql))[0]!.statement_timeout);
        return greenReport();
      },
    });
    expect(seen).toEqual(['10min', '2s']);
    // SET LOCAL: the pool's own setting is untouched afterwards.
    const pool = postgres(d().url, {
      max: 1,
      connection: { search_path: `${d().schema},public`, statement_timeout: 15_000 },
      onnotice: () => undefined,
    });
    open.push(pool);
    await runSnapshotReconciliation(pool);
    expect((await probe(pool))[0]!.statement_timeout).toBe('15s');
  });

  it('refuses a statement timeout that is not a bounded integer before it reaches SQL', async () => {
    for (const bad of [0, 999, 3_600_001, 1.5, Number.NaN]) {
      await expect(runSnapshotReconciliation(connect(), { statementTimeoutMs: bad })).rejects.toBeInstanceOf(RangeError);
    }
    await expect(d().sql`SELECT 1 FROM reconcile_runs`).resolves.toHaveLength(0);
  });

  it('INCOMPLETE on a real timeout: 57014 recorded, rolled back, not frozen, service.reconcile throws the typed error', async () => {
    const opened = d();
    const svc = service(connect(), { reconcileStatementTimeoutMs: 1_000 });
    await svc.post(deposit());
    const blocker = await opened.sql.reserve();
    try {
      await blocker.unsafe('BEGIN');
      await blocker.unsafe(`LOCK TABLE "${opened.schema}".ledger_entries IN ACCESS EXCLUSIVE MODE`);
      await expect(svc.reconcile()).rejects.toMatchObject({ code: 'ledger.reconcile_incomplete' });
    } finally {
      await blocker.unsafe('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    await expect(svc.status()).resolves.toMatchObject({ postingEnabled: true });
    const runs = await opened.sql`SELECT outcome, error_code, through_seq FROM reconcile_runs`;
    expect(runs.map((r) => [r.outcome, r.error_code])).toEqual([['incomplete', '57014']]);
    await expect(opened.sql`SELECT 1 FROM balance_snapshots`).resolves.toHaveLength(0);
    await expect(svc.post(deposit())).resolves.toMatchObject({ module: 'ledger' });
  });

  it('MISMATCH: service.reconcile freezes as before, records the run, writes no snapshot, returns the report', async () => {
    const svc = service(connect());
    await svc.post(deposit());
    await d().sql`UPDATE accounts SET balance = balance + 1 WHERE owner_type = 'user'`;
    const report = await svc.reconcile();
    expect(report.ok).toBe(false);
    expect(report.balances.ok).toBe(false);
    await expect(svc.status()).resolves.toEqual({
      postingEnabled: false,
      frozenReason: 'reconciliation mismatch',
      frozenBy: 'reconciliation',
    });
    const runs = await d().sql`SELECT outcome, through_seq::text AS through_seq FROM reconcile_runs`;
    expect(runs.map((r) => [r.outcome, r.through_seq])).toEqual([['mismatch', '1']]);
    await expect(d().sql`SELECT 1 FROM balance_snapshots`).resolves.toHaveLength(0);
  });

  it('a mismatch verdict survives a failed run-row insert: still reported as mismatch, so the caller still freezes', async () => {
    const svc = service(connect());
    await svc.post(deposit());
    await d().sql`UPDATE accounts SET balance = balance + 1 WHERE owner_type = 'user'`;
    await d().sql.unsafe(
      `CREATE FUNCTION "${d().schema}".refuse_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'run table refused'; END $$;
       CREATE TRIGGER refuse_run BEFORE INSERT ON "${d().schema}".reconcile_runs FOR EACH ROW EXECUTE FUNCTION "${d().schema}".refuse_run();`,
    );
    try {
      const result = await runScheduledReconciliation(connect(), svc);
      expect(result).toMatchObject({ outcome: 'mismatch', run: { runId: null } });
      await expect(svc.status()).resolves.toMatchObject({ postingEnabled: false, frozenReason: 'reconciliation mismatch' });
    } finally {
      await d().sql.unsafe(`DROP TRIGGER refuse_run ON "${d().schema}".reconcile_runs`);
    }
  });

  it('an incomplete run whose own run row cannot be written is still returned, with the record error', async () => {
    const sql = connect();
    await d().sql.unsafe(
      `CREATE FUNCTION "${d().schema}".refuse_run2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'run table refused'; END $$;
       CREATE TRIGGER refuse_run2 BEFORE INSERT ON "${d().schema}".reconcile_runs FOR EACH ROW EXECUTE FUNCTION "${d().schema}".refuse_run2();`,
    );
    try {
      const run = await runSnapshotReconciliation(sql, {
        async prove() {
          throw new Error('proof blew up');
        },
      });
      expect(run).toMatchObject({ outcome: 'incomplete', runId: null, phase: 'proof' });
      if (run.outcome === 'incomplete') expect(run.recordError).toBeInstanceOf(Error);
    } finally {
      await d().sql.unsafe(`DROP TRIGGER refuse_run2 ON "${d().schema}".reconcile_runs`);
    }
  });

  it('lastVerified, /health and the metric all follow the latest ok run, and /health survives an unreadable one', async () => {
    const svc = service(connect());
    await expect(svc.lastVerified()).resolves.toMatchObject({ at: null, seq: null });
    await svc.post(deposit());
    await runSnapshotReconciliation(connect());
    const last = await svc.lastVerified();
    expect(last.seq).toBe('1');
    expect(last.at).toBeInstanceOf(Date);

    const app = Fastify({ logger: false });
    registerLedgerStatusHttp(app, svc, 'svc-ledger');
    registerMetrics(app, { service: 'svc-ledger', gauges: async () => reconcileGauges(await svc.lastVerified()) });
    await app.ready();
    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(health).toMatchObject({ ok: true, postingEnabled: true, lastVerifiedAt: last.at!.toISOString(), lastVerifiedSeq: '1' });
    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toContain('# TYPE ledger_reconcile_last_verified_seq gauge');
    expect(metrics).toContain('ledger_reconcile_last_verified_seq{service="svc-ledger"} 1');
    expect(metrics).toContain(
      `ledger_reconcile_last_verified_timestamp_seconds{service="svc-ledger"} ${Math.floor(last.at!.getTime() / 1000)}`,
    );
    await app.close();

    await expect(
      lastVerifiedFields({
        status: svc.status.bind(svc),
        async lastVerified() {
          throw new Error('reconcile_runs unreadable');
        },
      }),
    ).resolves.toEqual({ lastVerifiedAt: null, lastVerifiedSeq: null });
    await expect(readLastVerified(d().sql)).resolves.toMatchObject({ seq: '1' });
  });

  it('0022 down: refuses while a run is on file, drops the table when it is empty', async () => {
    const opened = d();
    await opened.sql`INSERT INTO reconcile_runs (started_at, outcome, through_seq) VALUES (now(), 'ok', 1)`;
    await expect(opened.sql.unsafe(rewriteSchemaSql(DOWN_0022, 'ledger', opened.schema))).rejects.toMatchObject({ code: 'P0001' });
    await expect(opened.sql`SELECT 1 FROM reconcile_runs`).resolves.toHaveLength(1);
    await opened.sql`DELETE FROM reconcile_runs`;
    await opened.sql.unsafe(rewriteSchemaSql(DOWN_0022, 'ledger', opened.schema));
    const [gone] = await opened.sql<Array<{ name: string | null }>>`SELECT to_regclass(${`${opened.schema}.reconcile_runs`}) AS name`;
    expect(gone?.name).toBeNull();
    // Put it back for the files that follow in this database.
    await opened.sql.unsafe(rewriteSchemaSql(readFileSync(join(drizzleDir, '0022_reconcile_runs.sql'), 'utf8'), 'ledger', opened.schema));
  });

  it('the run table refuses an unknown outcome and an ok row with no tip', async () => {
    await expect(d().sql`INSERT INTO reconcile_runs (started_at, outcome) VALUES (now(), 'fine')`).rejects.toMatchObject({ code: '23514' });
    await expect(d().sql`INSERT INTO reconcile_runs (started_at, outcome) VALUES (now(), 'ok')`).rejects.toMatchObject({ code: '23514' });
    await expect(d().sql`INSERT INTO reconcile_runs (started_at, outcome) VALUES (now(), 'incomplete')`).resolves.toBeDefined();
  });
});

describe('reconciliation source pins', () => {
  const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the proof path takes no chain_tip lock and the tick never freezes on a throw', () => {
    const reconcile = strip(read('reconcile.ts'));
    expect(reconcile).not.toMatch(/FOR UPDATE/);
    expect(reconcile).toContain("begin('REPEATABLE READ')");
    expect(reconcile).toContain('BEGIN ISOLATION LEVEL ${isolation} READ WRITE');
    expect(reconcile).toContain('SET LOCAL statement_timeout');
    const tick = strip(read('scheduled-reconcile-tick.ts'));
    // The only reasons the tick may freeze with: a mismatch whose freeze failed, only.
    const reasons = [...tick.matchAll(/freezeAsReconciliation\(ledger, (\w+)\)/g)].map((m) => m[1]);
    expect(reasons.sort()).toEqual(['RECONCILE_MISMATCH_REASON']);
  });
});

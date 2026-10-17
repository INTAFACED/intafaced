import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { LedgerError, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { LedgerService } from '../service.js';
import {
  backoffTicks,
  createReconcileTickState,
  runScheduledReconciliationTick,
  type ReconcileIncompleteAlert,
  type ReconcileTickLog,
} from './scheduled-reconcile-tick.js';
import { runScheduledReconciliation, type LastVerified, type ReconciliationReport, type ScheduledReconcileResult } from './reconcile.js';
import { truncateBook } from '../db/journal-guards.testkit.js';

/**
 * The hourly timer. A completed mismatch freezes as `reconciliation mismatch`.
 * A Postgres or connection failure is incomplete: it alerts, backs off, and
 * freezes only after N consecutive runs (`reconcile_unproven`, default 3).
 * Any other throw is a failed proof and freezes immediately. Staleness is
 * reported on every tick without changing posting.
 */

const FROZEN_LOG = 'LEDGER RECONCILIATION FAILED — posting frozen, operator attention required';
const INCOMPLETE_LOG = 'LEDGER RECONCILIATION INCOMPLETE — the book was NOT verified and NOT frozen, operator attention required';
const UNPROVEN_LOG =
  'LEDGER RECONCILIATION UNPROVEN — posting frozen after consecutive incomplete runs, operator attention required';
const STALE_LOG = 'LEDGER RECONCILIATION STALE — the book is NOT verified, posting unchanged, operator attention required';

function logSink(): { log: ReconcileTickLog; fatal: Array<{ obj: object; msg: string }>; info: Array<{ obj: object; msg: string }> } {
  const fatal: Array<{ obj: object; msg: string }> = [];
  const info: Array<{ obj: object; msg: string }> = [];
  return {
    fatal,
    info,
    log: {
      fatal(obj, msg) {
        fatal.push({ obj, msg });
      },
      info(obj, msg) {
        info.push({ obj, msg });
      },
    },
  };
}

function failedReport(): ReconciliationReport {
  return {
    ok: false,
    ranAt: new Date('2026-08-26T00:00:00.000Z'),
    balances: { ok: true, accountsChecked: 0 },
    chain: { ok: false, brokenAt: 'chain_tip', length: 0 },
    totals: {},
    unbalancedAssets: [],
  };
}

const mismatchResult = (): ScheduledReconcileResult =>
  ({
    outcome: 'mismatch',
    report: failedReport(),
    snapshotted: false,
    run: { outcome: 'mismatch' },
  }) as unknown as ScheduledReconcileResult;
const okResult = (): ScheduledReconcileResult =>
  ({
    outcome: 'ok',
    report: { ...failedReport(), ok: true, chain: { ok: true, length: 0 } },
    snapshotted: true,
    run: { outcome: 'ok' },
  }) as unknown as ScheduledReconcileResult;
const incompleteResult = (errorCode = '57014'): ScheduledReconcileResult =>
  ({
    outcome: 'incomplete',
    report: null,
    snapshotted: false,
    run: { outcome: 'incomplete', phase: 'proof', error: new Error('canceling statement due to statement timeout'), errorCode, runId: '7' },
  }) as unknown as ScheduledReconcileResult;

/** A ledger that records every freeze it is asked for. */
function recordingLedger(last?: LastVerified): {
  ledger: Parameters<typeof runScheduledReconciliationTick>[1];
  froze: Array<[string, string]>;
  alerted: ReconcileIncompleteAlert[];
} {
  const froze: Array<[string, string]> = [];
  const alerted: ReconcileIncompleteAlert[] = [];
  return {
    froze,
    alerted,
    ledger: {
      async freeze(reason: string, actor: string) {
        froze.push([reason, actor]);
      },
      async alertReconciliationIncomplete(alert) {
        alerted.push(alert);
      },
      ...(last ? { lastVerified: async () => last } : {}),
    },
  };
}

describe('scheduled reconciliation tick — returned result', () => {
  it('pages when the run returns a mismatch and does not freeze again (the run already froze)', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze } = recordingLedger();
    await runScheduledReconciliationTick(async () => mismatchResult(), ledger, log);
    expect(froze).toEqual([]);
    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
    expect(fatal[0]?.obj).toMatchObject({ report: { ok: false }, snapshotted: false });
  });

  it('stays quiet when the run returns a green result', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze } = recordingLedger();
    await runScheduledReconciliationTick(async () => okResult(), ledger, log);
    expect(froze).toEqual([]);
    expect(fatal).toEqual([]);
  });

  it('stays quiet and changes nothing when another run holds the single-flight lock', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze } = recordingLedger();
    const state = createReconcileTickState();
    await runScheduledReconciliationTick(async () => ({ outcome: 'skipped' }), ledger, log, { state });
    expect(froze).toEqual([]);
    expect(fatal).toEqual([]);
    expect(state).toMatchObject({ consecutiveIncomplete: 0, skipTicks: 0 });
  });

  it('an incomplete run pages as INCOMPLETE, alerts, freezes NOTHING, and says it did not freeze', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze, alerted } = recordingLedger();
    await runScheduledReconciliationTick(async () => incompleteResult(), ledger, log);
    expect(froze).toEqual([]);
    expect(alerted).toEqual([{ errorCode: '57014', phase: 'proof', consecutiveIncomplete: 1, runId: '7' }]);
    expect(fatal.map((entry) => entry.msg)).toEqual([INCOMPLETE_LOG]);
    expect(fatal[0]?.obj).toMatchObject({
      outcome: 'incomplete',
      errorCode: '57014',
      phase: 'proof',
      runId: '7',
      consecutiveIncomplete: 1,
    });
  });

  it('a non-Postgres throw is a failed proof and freezes immediately', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze, alerted } = recordingLedger();
    const thrown = new Error('scheduled reconciliation threw');
    await runScheduledReconciliationTick(
      async () => {
        throw thrown;
      },
      ledger,
      log,
    );
    expect(froze).toEqual([['reconciliation mismatch', 'reconciliation']]);
    expect(alerted).toEqual([]);
    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
    expect(fatal[0]?.obj).toMatchObject({ err: thrown });
  });

  it('a connection error stays incomplete below the limit and does not freeze', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze, alerted } = recordingLedger();
    const thrown = Object.assign(new Error('CONNECTION_CLOSED 127.0.0.1:15485'), { code: 'CONNECTION_CLOSED' });
    await runScheduledReconciliationTick(async () => {
      throw thrown;
    }, ledger, log);
    expect(froze).toEqual([]);
    expect(alerted).toEqual([{ errorCode: 'CONNECTION_CLOSED', phase: 'tick', consecutiveIncomplete: 1, runId: null }]);
    expect(fatal.map((entry) => entry.msg)).toEqual([INCOMPLETE_LOG]);
  });

  it('a Postgres-coded throw stays incomplete below the limit and does not freeze', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze, alerted } = recordingLedger();
    const thrown = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    await runScheduledReconciliationTick(
      async () => {
        throw thrown;
      },
      ledger,
      log,
    );
    expect(froze).toEqual([]);
    expect(alerted).toEqual([{ errorCode: '57014', phase: 'tick', consecutiveIncomplete: 1, runId: null }]);
    expect(fatal.map((entry) => entry.msg)).toEqual([INCOMPLETE_LOG]);
  });

  it('freezes as reconcile_unproven on the Nth consecutive incomplete run and alerts every one', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze, alerted } = recordingLedger();
    const state = createReconcileTickState();
    const tick = () =>
      runScheduledReconciliationTick(async () => incompleteResult(), ledger, log, { state, maxConsecutiveIncomplete: 3 });
    await tick();
    await tick();
    expect(froze).toEqual([]);
    expect(alerted.map((alert) => alert.consecutiveIncomplete)).toEqual([1, 2]);
    await tick();
    expect(froze).toEqual([]);
    expect(alerted).toHaveLength(2);
    await tick();
    expect(froze).toEqual([['reconcile_unproven', 'reconciliation']]);
    expect(alerted.map((alert) => alert.consecutiveIncomplete)).toEqual([1, 2, 3]);
    expect(fatal.map((entry) => entry.msg)).toEqual([INCOMPLETE_LOG, INCOMPLETE_LOG, UNPROVEN_LOG]);
  });

  it('backs off ACROSS ticks (skip 0, 1, 3, 7, then 8) and one ok run resets it', async () => {
    expect([1, 2, 3, 4, 5, 6].map(backoffTicks)).toEqual([0, 1, 3, 7, 8, 8]);

    const { log } = logSink();
    const { ledger } = recordingLedger();
    const state = createReconcileTickState();
    let runs = 0;
    const tick = (result: () => ScheduledReconcileResult) =>
      runScheduledReconciliationTick(
        async () => {
          runs += 1;
          return result();
        },
        ledger,
        log,
        { state, maxConsecutiveIncomplete: 100 },
      );

    await tick(incompleteResult); // run 1, fails -> skip 0
    await tick(incompleteResult); // run 2, fails -> skip 1
    expect(runs).toBe(2);
    await tick(okResult); // skipped
    expect(runs).toBe(2);
    await tick(incompleteResult); // run 3, fails -> skip 3
    expect(runs).toBe(3);
    await tick(okResult);
    await tick(okResult);
    await tick(okResult); // three skipped ticks
    expect(runs).toBe(3);
    await tick(okResult); // run 4, ok: backoff resets
    expect(runs).toBe(4);
    expect(state).toMatchObject({ consecutiveIncomplete: 0, skipTicks: 0 });
  });

  it('a mismatch whose freeze did not land tries the freeze once more, as reconciliation', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze } = recordingLedger();
    await runScheduledReconciliationTick(
      async () => {
        throw new LedgerError('found a mismatch, the freeze did not land', 'ledger.reconcile_freeze_failed');
      },
      ledger,
      log,
    );
    expect(froze).toEqual([['reconciliation mismatch', 'reconciliation']]);
    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
  });
});

describe('scheduled reconciliation tick — staleness reporting', () => {
  const HOUR = 3_600_000;
  const now = new Date('2026-10-14T12:00:00.000Z');
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);

  it('reports without freezing when the last ok run is older than the limit', async () => {
    const { log, fatal } = logSink();
    const { ledger, froze } = recordingLedger({ at: at(25), seq: '41', firstAttemptAt: null });
    await runScheduledReconciliationTick(async () => incompleteResult(), ledger, log, { maxStaleHours: 24, now: () => now });
    expect(froze).toEqual([]);
    expect(fatal.map((entry) => entry.msg)).toEqual([INCOMPLETE_LOG, STALE_LOG]);
    expect(fatal[1]?.obj).toMatchObject({ lastVerifiedSeq: '41', maxStaleHours: 24 });
  });

  it('does not freeze while the last ok run is inside the limit, and logs when it was', async () => {
    const { log, fatal, info } = logSink();
    const { ledger, froze } = recordingLedger({ at: at(23), seq: '41', firstAttemptAt: null });
    await runScheduledReconciliationTick(async () => incompleteResult(), ledger, log, { maxStaleHours: 24, now: () => now });
    expect(froze).toEqual([]);
    expect(fatal.map((entry) => entry.msg)).toEqual([INCOMPLETE_LOG]);
    expect(info.find((entry) => entry.msg === 'reconciliation last verified')?.obj).toMatchObject({
      lastVerifiedAt: at(23).toISOString(),
      lastVerifiedSeq: '41',
    });
  });

  it('is checked on a backed-off tick too, so backoff can never outlast the window', async () => {
    const { log } = logSink();
    const { ledger, froze } = recordingLedger({ at: at(30), seq: '41', firstAttemptAt: null });
    const state = createReconcileTickState(now);
    state.skipTicks = 3;
    let ran = false;
    await runScheduledReconciliationTick(
      async () => {
        ran = true;
        return okResult();
      },
      ledger,
      log,
      { maxStaleHours: 24, now: () => now, state },
    );
    expect(ran).toBe(false);
    expect(froze).toEqual([]);
  });

  it('never verified: measures from the first recorded attempt, else from boot', async () => {
    const { log } = logSink();
    const first = recordingLedger({ at: null, seq: null, firstAttemptAt: at(30) });
    await runScheduledReconciliationTick(async () => incompleteResult(), first.ledger, log, { maxStaleHours: 24, now: () => now });
    expect(first.froze).toEqual([]);

    const fresh = recordingLedger({ at: null, seq: null, firstAttemptAt: null });
    await runScheduledReconciliationTick(async () => incompleteResult(), fresh.ledger, log, {
      maxStaleHours: 24,
      now: () => now,
      state: createReconcileTickState(at(1)),
    });
    expect(fresh.froze).toEqual([]);
  });

  it('is off when no limit is passed, and an unreadable last-verified time freezes nothing but pages', async () => {
    const { log, fatal } = logSink();
    const off = recordingLedger({ at: at(500), seq: '1', firstAttemptAt: null });
    await runScheduledReconciliationTick(async () => okResult(), off.ledger, log, { now: () => now });
    expect(off.froze).toEqual([]);

    const froze: string[] = [];
    await runScheduledReconciliationTick(
      async () => okResult(),
      {
        async freeze(reason: string) {
          froze.push(reason);
        },
        async lastVerified() {
          throw new Error('reconcile_runs unreadable');
        },
      },
      log,
      { maxStaleHours: 24, now: () => now },
    );
    expect(froze).toEqual([]);
    expect(fatal.map((entry) => entry.msg)).toEqual(['LEDGER RECONCILIATION STALENESS CHECK FAILED — last verified time unreadable']);
  });

  it('an operator freeze already standing is left standing and the page still goes out', async () => {
    const { log, fatal } = logSink();
    await runScheduledReconciliationTick(
      async () => okResult(),
      {
        async freeze() {
          throw new LedgerError('already frozen by an operator', 'ledger.freeze_attributed');
        },
        async lastVerified() {
          return { at: at(48), seq: '9', firstAttemptAt: null };
        },
      },
      log,
      { maxStaleHours: 24, now: () => now },
    );
    expect(fatal.map((entry) => entry.msg)).toEqual([STALE_LOG]);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const indexSrc = join(here, '..', 'index.ts');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

describe('scheduled reconciliation tick — against a real book', () => {
  let db: TestDb | undefined;
  let replicas: Sql[] = [];
  const USER = '77777777-7777-4777-8777-777777777777';
  const OPERATOR = '11111111-1111-4111-8111-111111111111';
  let seq = 0;
  const deposit = () => recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: `tick-${++seq}` });

  function requireDb(): TestDb {
    if (!db) throw new Error('test db not opened');
    return db;
  }

  function connect(): Sql {
    const opened = requireDb();
    const sql = postgres(opened.url, {
      max: 1,
      connection: { search_path: `${opened.schema},public`, application_name: `${opened.schema}_replica` },
      onnotice: () => undefined,
    });
    replicas.push(sql);
    return sql;
  }

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is required — this file does not start a database');
    db = await createTestDb({
      service: 'ledgertick',
      url,
      migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema)),
    });
  }, 120_000);

  beforeEach(async () => {
    const opened = requireDb();
    await truncateBook(
      opened.sql,
      'reconcile_runs, ledger_freeze_outbox, ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE',
    );
    await opened.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
    await opened.sql`UPDATE posting_freeze SET frozen = false, reason = NULL, actor = NULL WHERE id = true`;
  });

  afterEach(async () => {
    const open = replicas;
    replicas = [];
    await Promise.all(open.map((sql) => sql.end({ timeout: 5 })));
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('the process timer wires the tick, its state and the staleness limit', () => {
    const src = readFileSync(indexSrc, 'utf8');
    expect(src).toContain('runScheduledReconciliationTick');
    expect(src).toContain('createReconcileTickState');
    expect(src).toContain('maxStaleHours: env.LEDGER_RECONCILE_MAX_STALE_HOURS');
    expect(src).toContain('maxConsecutiveIncomplete: env.RECONCILE_MAX_CONSECUTIVE_INCOMPLETE');
    expect(src).not.toContain('reconciliation run failed');
  });

  it('a real mismatch freezes the book, so a second connection cannot post', async () => {
    const writerSql = connect();
    const writer = new LedgerService(writerSql, new MemoryEventBus('writer'));
    const reader = new LedgerService(connect(), new MemoryEventBus('reader'));
    await expect(reader.post(deposit())).resolves.toMatchObject({ module: 'ledger' });
    await requireDb().sql`UPDATE accounts SET balance = balance + 1 WHERE owner_type = 'user'`;

    const { log, fatal } = logSink();
    await runScheduledReconciliationTick(() => runScheduledReconciliation(writerSql, writer), writer, log);

    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
    await expect(reader.status()).resolves.toEqual({
      postingEnabled: false,
      frozenReason: 'reconciliation mismatch',
      frozenBy: 'reconciliation',
    });
    await expect(reader.post(deposit())).rejects.toMatchObject({ code: 'ledger.frozen' });
    const runs = await requireDb().sql`SELECT outcome FROM reconcile_runs`;
    expect(runs.map((r) => r.outcome)).toEqual(['mismatch']);
  });

  it('an INCOMPLETE run (real statement timeout) freezes nothing, and the book keeps posting', async () => {
    const opened = requireDb();
    const writerSql = connect();
    const writer = new LedgerService(writerSql, new MemoryEventBus('writer'));
    const reader = new LedgerService(connect(), new MemoryEventBus('reader'));
    await reader.post(deposit());

    // A held ACCESS EXCLUSIVE lock makes the proof wait until its own statement_timeout fires: 57014.
    const blocker = await opened.sql.reserve();
    try {
      await blocker.unsafe('BEGIN');
      await blocker.unsafe(`LOCK TABLE "${opened.schema}".ledger_entries IN ACCESS EXCLUSIVE MODE`);
      const { log, fatal } = logSink();
      await runScheduledReconciliationTick(() => runScheduledReconciliation(writerSql, writer, { statementTimeoutMs: 1_000 }), writer, log);
      expect(fatal.map((entry) => entry.msg)).toEqual([INCOMPLETE_LOG]);
      expect(fatal[0]?.obj).toMatchObject({ outcome: 'incomplete', errorCode: '57014' });
    } finally {
      await blocker.unsafe('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    await expect(reader.status()).resolves.toMatchObject({ postingEnabled: true, frozenReason: null });
    await expect(reader.post(deposit())).resolves.toMatchObject({ module: 'ledger' });
    const runs = await opened.sql`SELECT outcome, error_code FROM reconcile_runs`;
    expect(runs.map((r) => [r.outcome, r.error_code])).toEqual([['incomplete', '57014']]);
    expect(await opened.sql`SELECT 1 FROM balance_snapshots`).toHaveLength(0);
  });

  it('an incomplete run leaves an operator freeze standing', async () => {
    const writerSql = connect();
    const writer = new LedgerService(writerSql, new MemoryEventBus('writer'));
    const reader = new LedgerService(connect(), new MemoryEventBus('reader'));
    await writer.freeze('operator: suspected drift', OPERATOR);

    const { log } = logSink();
    await runScheduledReconciliationTick(
      async () => ({
        outcome: 'incomplete',
        report: null,
        snapshotted: false,
        run: { outcome: 'incomplete', phase: 'proof', error: new Error('x'), errorCode: 'x', runId: null },
      }),
      writer,
      log,
    );
    await expect(reader.freezeState()).resolves.toMatchObject({ frozen: true, reason: 'operator: suspected drift', actor: OPERATOR });
  });

  it('the staleness reporting reports an old proof without freezing or refusing a post', async () => {
    const opened = requireDb();
    const writerSql = connect();
    const writer = new LedgerService(writerSql, new MemoryEventBus('writer'));
    const reader = new LedgerService(connect(), new MemoryEventBus('reader'));
    await opened.sql`
      INSERT INTO reconcile_runs (started_at, finished_at, outcome, through_seq)
      VALUES (now() - interval '26 hours', now() - interval '26 hours', 'ok', 5)
    `;

    const { log, fatal } = logSink();
    await runScheduledReconciliationTick(async () => ({ outcome: 'skipped' }), writer, log, { maxStaleHours: 24 });

    expect(fatal.map((entry) => entry.msg)).toEqual([STALE_LOG]);
    await expect(reader.status()).resolves.toEqual({
      postingEnabled: true,
      frozenReason: null,
      frozenBy: null,
    });
    await expect(reader.post(deposit())).resolves.toMatchObject({ module: 'ledger' });
  });

  it('a fresh ok run keeps the backstop quiet, and an operator freeze beats a stale one', async () => {
    const opened = requireDb();
    const writer = new LedgerService(connect(), new MemoryEventBus('writer'));
    const reader = new LedgerService(connect(), new MemoryEventBus('reader'));
    await opened.sql`INSERT INTO reconcile_runs (started_at, outcome, through_seq) VALUES (now(), 'ok', 5)`;
    const quiet = logSink();
    await runScheduledReconciliationTick(async () => ({ outcome: 'skipped' }), writer, quiet.log, { maxStaleHours: 24 });
    expect(quiet.fatal).toEqual([]);
    await expect(reader.status()).resolves.toMatchObject({ postingEnabled: true });

    await opened.sql`UPDATE reconcile_runs SET finished_at = now() - interval '3 days'`;
    await writer.freeze('operator: investigating', OPERATOR);
    const stale = logSink();
    await runScheduledReconciliationTick(async () => ({ outcome: 'skipped' }), writer, stale.log, { maxStaleHours: 24 });
    expect(stale.fatal.map((entry) => entry.msg)).toEqual([STALE_LOG]);
    await expect(reader.freezeState()).resolves.toMatchObject({ reason: 'operator: investigating', actor: OPERATOR });
  });

  it('pages when the mismatch freeze call throws after posting is already halted', async () => {
    const { log, fatal } = logSink();
    const thrown = new LedgerError('found a mismatch, the freeze did not land', 'ledger.reconcile_freeze_failed');
    await runScheduledReconciliationTick(
      async () => {
        throw thrown;
      },
      {
        async freeze() {
          throw new Error('bus down after the switch committed');
        },
        async status() {
          return { postingEnabled: false };
        },
      },
      log,
    );
    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
    expect(fatal[0]?.obj).toMatchObject({ err: thrown });
  });

  it('does not claim the book is frozen when the mismatch freeze write itself fails', async () => {
    const { log, fatal } = logSink();
    const boom = new Error('posting_freeze write failed');
    await expect(
      runScheduledReconciliationTick(
        async () => {
          throw new LedgerError('found a mismatch, the freeze did not land', 'ledger.reconcile_freeze_failed');
        },
        {
          async freeze() {
            throw boom;
          },
        },
        log,
      ),
    ).rejects.toBe(boom);
    expect(fatal).toEqual([]);
  });
});

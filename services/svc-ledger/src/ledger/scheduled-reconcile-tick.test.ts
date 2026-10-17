import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { LedgerError, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { LedgerService } from '../service.js';
import { runScheduledReconciliationTick, type ReconcileTickLog } from './scheduled-reconcile-tick.js';
import type { ReconciliationReport } from './reconcile.js';
import { truncateBook } from '../db/journal-guards.testkit.js';

/**
 * The hourly timer. A failed report already halted posting inside
 * `LedgerService.reconcile` before it returned. A throw never got that far:
 * the process logged and kept posting. This tick is the seam that closes that.
 */

const FROZEN_LOG = 'LEDGER RECONCILIATION FAILED — posting frozen, operator paged';

function logSink(): { log: ReconcileTickLog; fatal: Array<{ obj: object; msg: string }> } {
  const fatal: Array<{ obj: object; msg: string }> = [];
  return {
    fatal,
    log: {
      fatal(obj, msg) {
        fatal.push({ obj, msg });
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

describe('scheduled reconciliation tick — returned report', () => {
  it('pages when the run returns a failed report and does not freeze again', async () => {
    const { log, fatal } = logSink();
    let froze = 0;
    await runScheduledReconciliationTick(
      async () => ({ report: failedReport(), snapshotted: false }),
      {
        async freeze() {
          froze += 1;
        },
      },
      log,
    );
    expect(froze).toBe(0);
    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
    expect(fatal[0]?.obj).toMatchObject({ report: { ok: false }, snapshotted: false });
  });

  it('stays quiet when the run returns a green report', async () => {
    const { log, fatal } = logSink();
    let froze = 0;
    await runScheduledReconciliationTick(
      async () => ({
        report: { ...failedReport(), ok: true, chain: { ok: true, length: 0 } },
        snapshotted: true,
      }),
      {
        async freeze() {
          froze += 1;
        },
      },
      log,
    );
    expect(froze).toBe(0);
    expect(fatal).toEqual([]);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const indexSrc = join(here, '..', 'index.ts');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

describe('scheduled reconciliation tick — a throw freezes posting', () => {
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
      'ledger_freeze_outbox, ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE',
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

  it('the process timer no longer treats a throw as a log-only failure', () => {
    const src = readFileSync(indexSrc, 'utf8');
    expect(src).toContain('runScheduledReconciliationTick');
    expect(src).not.toContain('reconciliation run failed');
  });

  it('a throw freezes the book, so a second connection cannot post', async () => {
    const writer = new LedgerService(connect(), new MemoryEventBus('writer'));
    const reader = new LedgerService(connect(), new MemoryEventBus('reader'));
    await expect(reader.post(deposit())).resolves.toMatchObject({ module: 'ledger' });

    const { log, fatal } = logSink();
    const thrown = new Error('scheduled reconciliation threw');
    await runScheduledReconciliationTick(
      async () => {
        throw thrown;
      },
      writer,
      log,
    );

    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
    expect(fatal[0]?.obj).toMatchObject({ err: thrown });
    expect(fatal[0]?.obj).not.toHaveProperty('report');

    await expect(reader.status()).resolves.toEqual({
      postingEnabled: false,
      frozenReason: 'reconciliation mismatch',
      frozenBy: 'reconciliation',
    });
    await expect(reader.post(deposit())).rejects.toMatchObject({ code: 'ledger.frozen' });
  });

  it('a throw leaves an operator freeze standing and posting stays refused', async () => {
    const writer = new LedgerService(connect(), new MemoryEventBus('writer'));
    const reader = new LedgerService(connect(), new MemoryEventBus('reader'));
    await writer.freeze('operator: suspected drift', OPERATOR);

    const { log, fatal } = logSink();
    await runScheduledReconciliationTick(
      async () => {
        throw new Error('scheduled reconciliation threw');
      },
      writer,
      log,
    );

    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
    await expect(reader.freezeState()).resolves.toMatchObject({
      frozen: true,
      reason: 'operator: suspected drift',
      actor: OPERATOR,
    });
    await expect(reader.post(deposit())).rejects.toMatchObject({ code: 'ledger.frozen' });
  });

  it('pages when the freeze call throws after posting is already halted', async () => {
    const { log, fatal } = logSink();
    const thrown = new Error('scheduled reconciliation threw');
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

  it('does not claim the book is frozen when the freeze write itself fails', async () => {
    const { log, fatal } = logSink();
    const boom = new Error('posting_freeze write failed');
    await expect(
      runScheduledReconciliationTick(
        async () => {
          throw new Error('scheduled reconciliation threw');
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

  it('still pages when the book was already frozen by reconciliation and the freeze is a no-op', async () => {
    const writer = new LedgerService(connect(), new MemoryEventBus('writer'));
    const reader = new LedgerService(connect(), new MemoryEventBus('reader'));
    await writer.freeze('reconciliation mismatch', 'reconciliation');

    const { log, fatal } = logSink();
    await runScheduledReconciliationTick(
      async () => {
        throw new LedgerError('page failed after the halt', 'ledger.bus');
      },
      writer,
      log,
    );

    expect(fatal.map((entry) => entry.msg)).toEqual([FROZEN_LOG]);
    await expect(reader.status()).resolves.toMatchObject({
      postingEnabled: false,
      frozenReason: 'reconciliation mismatch',
      frozenBy: 'reconciliation',
    });
  });
});

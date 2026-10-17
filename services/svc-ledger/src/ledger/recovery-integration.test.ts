import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { recipes, parseAmount } from '@intafaced/ledger-client';
import { LedgerService } from '../service.js';
import { runScheduledReconciliation } from './reconcile.js';
import { writeFreeze, readFreeze, unpublishedFreezeOutbox } from './freeze.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationDir = join(root, 'drizzle');
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => (schema: string) => rewriteSchemaSql(readFileSync(join(migrationDir, name), 'utf8'), 'ledger', schema));
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deposit = (ref: string) => recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('1'), rail: 'test', railRef: ref });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fixture(run: (db: Awaited<ReturnType<typeof createTestDb>>, pool: postgres.Sql) => Promise<void>) {
  const db = await createTestDb({ service: 'ledger_repair', url: process.env.TEST_DATABASE_URL, migrations });
  const pool = postgres(db.url, {
    max: 1,
    onnotice: () => undefined,
    connection: { search_path: `${db.schema},public`, application_name: `ledger-repair-${process.pid}` },
  });
  try {
    await run(db, pool);
  } finally {
    await pool.end({ timeout: 1 });
    await db.drop();
  }
}
async function bounded<T>(operation: Promise<T>, ms = 1500): Promise<T> {
  // Observe rejection even when the bounded assertion wins and fixture teardown closes the pool.
  const observed = operation.then(
    (value) => ({ kind: 'done' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  const result = await Promise.race([observed, delay(ms).then(() => ({ kind: 'timeout' as const }))]);
  if (result.kind === 'timeout') throw new Error('actual max:1 reconciliation retained its pool connection');
  if (result.kind === 'error') throw result.error;
  return result.value;
}

/** Poll until the pool's own session is parked on a lock (the proof is waiting on the blocker). */
async function waitUntilProofWaits(db: Awaited<ReturnType<typeof createTestDb>>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const [row] = await db.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n
        FROM pg_stat_activity
       WHERE application_name = ${`ledger-repair-${process.pid}`} AND wait_event_type = 'Lock'
    `;
    if (row?.n !== '0') return;
    await delay(5);
  }
  throw new Error('the proof never reached the blocked statement');
}

describe('native recovery integration with the actual ledger service', () => {
  // Rewritten for #4755. The proof used to hold the chain_tip lock for its whole run, and these
  // two tests pinned that ("waiting post" queued behind it). The proof now reads one REPEATABLE
  // READ snapshot and takes NO tip lock; what they still pin is the max:1 pool property: a
  // finished run, success or mismatch, gives its only connection back before anything else needs it.
  // 20s sits above vitest's 5s default. Each case builds a schema inside the timer.
  // This one: alone max 747ms; six copies at once max 4522ms; CI killed it at 5000ms.
  // Same load: mismatch 5737ms, snapshot refusal 5615ms, proof error 4425ms, replay 4326ms.
  // Every case in this file carries the same 20s limit. The 1500ms pool bound is unchanged.
  it(
    'completes actual max:1 proof and snapshots without reacquiring its pool, holding no tip lock while it waits',
    async () =>
      fixture(async (db, pool) => {
        const ledger = new LedgerService(pool, new MemoryEventBus('max1'));
        await ledger.post(deposit('max1-success'));
        const blocker = await db.sql.reserve();
        try {
          await blocker.unsafe('BEGIN');
          await blocker.unsafe(`LOCK TABLE "${db.schema}".ledger_entries IN ACCESS EXCLUSIVE MODE`);
          const scheduled = runScheduledReconciliation(pool, ledger);
          const observed = scheduled.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await waitUntilProofWaits(db);
          // The proof is parked mid-run and the posting lock is NOT held.
          await expect(db.sql`SELECT id FROM chain_tip WHERE id = true FOR UPDATE NOWAIT`).resolves.toHaveLength(1);
          await blocker.unsafe('ROLLBACK');
          const result = await bounded(observed);
          if ('error' in result) throw result.error;
          expect(result.value).toMatchObject({ outcome: 'ok', report: { ok: true }, snapshotted: true });
          const rows = await db.sql`SELECT chain_tip_seq::text AS seq, balance::text AS balance FROM balance_snapshots`;
          expect(rows).toHaveLength(2);
          expect(rows.every((row) => row.seq === '1')).toBe(true);
          expect(rows.map((row) => row.balance).sort()).toEqual(['-1.000000000000000000', '1.000000000000000000']);
          // The single pool connection is free again.
          await expect(bounded(ledger.post(deposit('after-success')))).resolves.toMatchObject({ module: 'ledger' });
        } finally {
          await blocker.unsafe('ROLLBACK').catch(() => undefined);
          blocker.release();
        }
      }),
    20_000,
  );

  it(
    'commits actual max:1 mismatch freeze and intent after the proof releases the pool; bus observes only committed state',
    async () =>
      fixture(async (db, pool) => {
        const bus = new MemoryEventBus('max1-failure');
        const emitted: boolean[] = [];
        const publish = bus.publish.bind(bus);
        bus.publish = async (...args) => {
          if (args[0] === 'ledgerFreezeUpdated') {
            // The same max:1 service pool must be available, and the business lock released.
            await pool`SELECT id FROM chain_tip WHERE id = true FOR UPDATE`;
            expect((await pool`SELECT frozen FROM posting_freeze`)[0]?.frozen).toBe(true);
            expect((await pool`SELECT count(*)::text AS n FROM ledger_freeze_outbox WHERE published_at IS NULL`)[0]?.n).toBe('1');
            emitted.push(true);
          }
          return publish(...args);
        };
        const ledger = new LedgerService(pool, bus);
        await ledger.post(deposit('max1-failure'));
        await db.sql`UPDATE accounts SET balance = balance + 1 WHERE owner_type = 'user'`;
        const blocker = await db.sql.reserve();
        try {
          await blocker.unsafe('BEGIN');
          await blocker.unsafe(`LOCK TABLE "${db.schema}".ledger_entries IN ACCESS EXCLUSIVE MODE`);
          const scheduledObserved = runScheduledReconciliation(pool, ledger).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await waitUntilProofWaits(db);
          await blocker.unsafe('ROLLBACK');
          const result = await bounded(scheduledObserved);
          if ('error' in result) throw result.error;
          expect(result.value).toMatchObject({ outcome: 'mismatch', report: { ok: false }, snapshotted: false });
          await expect(ledger.post(deposit('waiting-after-failure'))).rejects.toMatchObject({ code: 'ledger.frozen' });
          expect(emitted).toEqual([true]);
          expect(await db.sql`SELECT * FROM balance_snapshots`).toHaveLength(0);
          expect((await db.sql`SELECT outcome FROM reconcile_runs`).map((r) => r.outcome)).toEqual(['mismatch']);
          // The SAME body: a retry of a committed post returns it even while frozen. (A different
          // body under this key is a conflict now, see the conformance suite.)
          const replay = await ledger.post(deposit('max1-failure'));
          expect(replay.idempotencyKey).toBe(deposit('max1-failure').idempotencyKey);
          expect(await db.sql`SELECT * FROM ledger_tx`).toHaveLength(1);
        } finally {
          await blocker.unsafe('ROLLBACK').catch(() => undefined);
          blocker.release();
        }
      }),
    20_000,
  );

  // Was: "rolls back a SQL proof error to the held savepoint, commits the halt, then publishes and
  // rethrows" (a proof error froze the book). A proof that cannot run is NOT a mismatch.
  it(
    'a SQL proof error is INCOMPLETE: nothing frozen, nothing snapshotted, the attempt recorded, no rethrow',
    async () =>
      fixture(async (db, pool) => {
        const bus = new MemoryEventBus('proof-error');
        const ledger = new LedgerService(pool, bus);
        await ledger.post(deposit('proof-error'));
        await db.sql`ALTER TABLE ledger_entries RENAME COLUMN amount TO hidden_amount`;
        const result = await bounded(runScheduledReconciliation(pool, ledger));
        expect(result).toMatchObject({ outcome: 'incomplete', report: null, snapshotted: false, run: { errorCode: '42703' } });
        expect(await readFreeze(pool)).toMatchObject({ frozen: false });
        expect(await db.sql`SELECT * FROM balance_snapshots`).toHaveLength(0);
        expect(await db.sql`SELECT * FROM ledger_freeze_outbox`).toHaveLength(0);
        expect((await db.sql`SELECT outcome, error_code FROM reconcile_runs`).map((r) => [r.outcome, r.error_code])).toEqual([
          ['incomplete', '42703'],
        ]);
        expect(bus.emitted('ledgerFreezeUpdated')).toHaveLength(0);
        expect(bus.emitted('ledgerReconciliationFailed')).toHaveLength(0);
      }),
    20_000,
  );

  // Was: "commits a halt before releasing the posting lock when actual snapshot DDL rejects the insert".
  it(
    'a rejected snapshot insert is INCOMPLETE: rolled back together with the ok run row, nothing frozen',
    async () =>
      fixture(async (db, pool) => {
        const bus = new MemoryEventBus('snapshot-error');
        const ledger = new LedgerService(pool, bus);
        await ledger.post(deposit('snapshot-error'));
        await db.sql.unsafe(
          `CREATE FUNCTION "${db.schema}".refuse_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'native snapshot refusal'; END $$; CREATE TRIGGER refuse_snapshot BEFORE INSERT ON "${db.schema}".balance_snapshots FOR EACH ROW EXECUTE FUNCTION "${db.schema}".refuse_snapshot();`,
        );
        const result = await bounded(runScheduledReconciliation(pool, ledger));
        expect(result).toMatchObject({
          outcome: 'incomplete',
          run: { phase: 'snapshot', error: expect.objectContaining({ message: 'native snapshot refusal' }) },
        });
        expect(await readFreeze(pool)).toMatchObject({ frozen: false });
        expect(await db.sql`SELECT * FROM balance_snapshots`).toHaveLength(0);
        expect((await db.sql`SELECT outcome FROM reconcile_runs`).map((r) => r.outcome)).toEqual(['incomplete']);
        expect(bus.emitted('ledgerFreezeUpdated')).toHaveLength(0);
        expect(bus.emitted('ledgerReconciliationFailed')).toHaveLength(0);
      }),
    20_000,
  );

  it(
    'replays forced inverted transaction starts in actual switch order with stable failed-send retry keys',
    async () =>
      fixture(async (db, pool) => {
        // The delayed driver starts a real BEGIN, then pauses before any switch SQL.
        let release!: () => void, reached!: () => void;
        const pause = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const delayed = new Proxy(pool, {
          get(target, property, receiver) {
            if (property === 'begin')
              return (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
                pool.begin(async (tx) => {
                  reached();
                  await pause;
                  return callback(tx);
                });
            return Reflect.get(target, property, receiver);
          },
        });
        const thaw = writeFreeze(delayed, { frozen: false, actor: 'delayed-thaw', confirmOperatorId: 'delayed-confirm' });
        const thawObserved = thaw.catch((error: unknown) => {
          throw error;
        });
        await started;
        try {
          await db.sql`SELECT pg_sleep(0.025)`;
          await writeFreeze(db.sql, { frozen: true, reason: 'actual order', actor: 'later-start-freeze' });
        } finally {
          release();
        }
        await thawObserved;
        expect(await readFreeze(pool)).toMatchObject({ frozen: false, actor: 'delayed-thaw' });
        const before = await unpublishedFreezeOutbox(pool);
        expect(before.map((row) => (row.payload as { frozen: boolean }).frozen)).toEqual([true, false]);
        const bus = new MemoryEventBus('ordered');
        const publish = bus.publish.bind(bus);
        let failThaw = true;
        bus.publish = async (...args) => {
          if (args[0] === 'ledgerFreezeUpdated' && 'frozen' in args[1] && args[1].frozen === false && failThaw)
            throw new Error('thaw bus failure');
          return publish(...args);
        };
        const ledger = new LedgerService(pool, bus);
        await expect(ledger.recoverUnpublishedOutbox()).rejects.toThrow('thaw bus failure');
        const pending = await unpublishedFreezeOutbox(pool);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.idempotency_key).toBe(before[1]?.idempotency_key);
        failThaw = false;
        await ledger.recoverUnpublishedOutbox();
        const events = bus.emitted('ledgerFreezeUpdated');
        expect(events.map((event) => event.payload.frozen)).toEqual([true, false]);
        expect(events[1]?.idempotencyKey).toBe(before[1]?.idempotency_key);
        await ledger.recoverUnpublishedOutbox();
        expect(bus.emitted('ledgerFreezeUpdated')).toHaveLength(2);
      }),
    20_000,
  );
});

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

describe('native recovery integration with the actual ledger service', () => {
  it('completes actual max:1 proof and snapshots without reacquiring its pool', async () =>
    fixture(async (db, pool) => {
      const ledger = new LedgerService(pool, new MemoryEventBus('max1'));
      await ledger.post(deposit('max1-success'));
      const blocker = await db.sql.reserve();
      const writer = postgres(db.url, { max: 1, onnotice: () => undefined, connection: { search_path: `${db.schema},public` } });
      try {
        await blocker.unsafe('BEGIN');
        await blocker.unsafe(`LOCK TABLE "${db.schema}".ledger_entries IN ACCESS EXCLUSIVE MODE`);
        const scheduled = runScheduledReconciliation(pool, ledger);
        const observed = scheduled.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let locked = false;
        for (let i = 0; i < 100; i++) {
          try {
            await db.sql`SELECT id FROM chain_tip WHERE id = true FOR UPDATE NOWAIT`;
          } catch (error) {
            if ((error as { code?: string }).code === '55P03') {
              locked = true;
              break;
            }
            throw error;
          }
          await delay(5);
        }
        expect(locked).toBe(true);
        const waiting = new LedgerService(writer, new MemoryEventBus('allowed-waiting')).post(deposit('waiting-after-success'));
        const waitingObserved = waiting.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await delay(20);
        expect(await Promise.race([waitingObserved, delay(10).then(() => 'waiting')])).toBe('waiting');
        await blocker.unsafe('ROLLBACK');
        const result = await bounded(observed);
        if ('error' in result) throw result.error;
        expect(result.value).toMatchObject({ report: { ok: true }, snapshotted: true });
        const posted = await bounded(waitingObserved);
        if ('error' in posted) throw posted.error;
        expect(posted.value.idempotencyKey).toBe(deposit('waiting-after-success').idempotencyKey);
        const rows = await db.sql`SELECT chain_tip_seq::text AS seq, balance::text AS balance FROM balance_snapshots`;
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.seq === '1')).toBe(true);
        expect(rows.map((row) => row.balance).sort()).toEqual(['-1.000000000000000000', '1.000000000000000000']);
        expect(await db.sql`SELECT * FROM ledger_tx`).toHaveLength(2);
      } finally {
        await blocker.unsafe('ROLLBACK').catch(() => undefined);
        blocker.release();
        await writer.end({ timeout: 1 });
      }
    }));

  it('commits actual max:1 mismatch freeze and intent before releasing a waiting post; bus observes only committed state', async () =>
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
      const writer = postgres(db.url, { max: 1, onnotice: () => undefined, connection: { search_path: `${db.schema},public` } });
      try {
        await blocker.unsafe('BEGIN');
        await blocker.unsafe(`LOCK TABLE "${db.schema}".ledger_entries IN ACCESS EXCLUSIVE MODE`);
        const scheduled = runScheduledReconciliation(pool, ledger);
        const scheduledObserved = scheduled.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let locked = false;
        for (let i = 0; i < 100; i++) {
          try {
            await db.sql`SELECT id FROM chain_tip WHERE id = true FOR UPDATE NOWAIT`;
          } catch (error) {
            if ((error as { code?: string }).code === '55P03') {
              locked = true;
              break;
            }
            throw error;
          }
          await delay(5);
        }
        expect(locked).toBe(true);
        const post = new LedgerService(writer, new MemoryEventBus('waiting')).post(deposit('waiting-after-failure'));
        const postObserved = post.then(
          () => ({ kind: 'posted' as const }),
          (error: unknown) => ({ kind: 'refused' as const, error }),
        );
        await delay(20);
        expect(await Promise.race([postObserved, delay(10).then(() => 'waiting')])).toBe('waiting');
        await blocker.unsafe('ROLLBACK');
        const result = await bounded(scheduledObserved);
        if ('error' in result) throw result.error;
        expect(result.value).toMatchObject({ report: { ok: false }, snapshotted: false });
        const outcome = await bounded(postObserved);
        expect(outcome.kind).toBe('refused');
        if (outcome.kind === 'refused') expect(outcome.error).toMatchObject({ code: 'ledger.frozen' });
        expect(emitted).toEqual([true]);
        expect(await db.sql`SELECT * FROM balance_snapshots`).toHaveLength(0);
        // The SAME body: a retry of a committed post returns it even while frozen. (A different
        // body under this key is a conflict now, see the conformance suite.)
        const replay = await ledger.post(deposit('max1-failure'));
        expect(replay.idempotencyKey).toBe(deposit('max1-failure').idempotencyKey);
        expect(await db.sql`SELECT * FROM ledger_tx`).toHaveLength(1);
      } finally {
        await blocker.unsafe('ROLLBACK').catch(() => undefined);
        blocker.release();
        await writer.end({ timeout: 1 });
      }
    }));

  it('rolls back a SQL proof error to the held savepoint, commits the halt, then publishes and rethrows', async () =>
    fixture(async (db, pool) => {
      const bus = new MemoryEventBus('proof-error');
      const ledger = new LedgerService(pool, bus);
      await ledger.post(deposit('proof-error'));
      await db.sql`ALTER TABLE ledger_entries RENAME COLUMN amount TO hidden_amount`;
      await expect(bounded(runScheduledReconciliation(pool, ledger))).rejects.toMatchObject({ code: '42703' });
      expect(await readFreeze(pool)).toMatchObject({ frozen: true, actor: 'reconciliation' });
      expect(await db.sql`SELECT * FROM balance_snapshots`).toHaveLength(0);
      expect((await db.sql`SELECT published_at FROM ledger_freeze_outbox`)[0]?.published_at).toBeInstanceOf(Date);
      expect(bus.emitted('ledgerFreezeUpdated')).toHaveLength(1);
      expect(bus.emitted('ledgerReconciliationFailed')).toHaveLength(0);
    }));

  it('commits a halt before releasing the posting lock when actual snapshot DDL rejects the insert', async () =>
    fixture(async (db, pool) => {
      const bus = new MemoryEventBus('snapshot-error');
      const ledger = new LedgerService(pool, bus);
      await ledger.post(deposit('snapshot-error'));
      await db.sql.unsafe(
        `CREATE FUNCTION "${db.schema}".refuse_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'native snapshot refusal'; END $$; CREATE TRIGGER refuse_snapshot BEFORE INSERT ON "${db.schema}".balance_snapshots FOR EACH ROW EXECUTE FUNCTION "${db.schema}".refuse_snapshot();`,
      );
      await expect(bounded(runScheduledReconciliation(pool, ledger))).rejects.toThrow('native snapshot refusal');
      expect(await readFreeze(pool)).toMatchObject({ frozen: true, actor: 'reconciliation' });
      expect(await db.sql`SELECT * FROM balance_snapshots`).toHaveLength(0);
      expect(bus.emitted('ledgerFreezeUpdated')).toHaveLength(1);
      expect(bus.emitted('ledgerReconciliationFailed')).toHaveLength(0);
    }));

  it('replays forced inverted transaction starts in actual switch order with stable failed-send retry keys', async () =>
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
    }));
});

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';

/**
 * 0002's down reads posting_freeze and then drops the table. The read takes
 * no lock, so under READ COMMITTED a freeze can commit in that gap and the
 * drop deletes the frozen row. The next restart then posts with no actor.
 *
 * The guard has to hold the singleton row until the drop, so a concurrent
 * freeze cannot commit while the down is still open.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const DOWN = readFileSync(join(drizzleDir, '0002_durable_freeze.down.sql'), 'utf8');

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('0002 down freeze lock (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('0002 down — a freeze cannot commit between the read and the drop', () => {
    let db: TestDb;

    beforeAll(async () => {
      db = await createTestDb({ service: 'ledger_freezedown', url: URL, migrations });
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('holds the freeze row so a concurrent freeze times out', async () => {
      await db.sql.unsafe(`UPDATE "${db.schema}"."posting_freeze" SET "frozen" = false, "reason" = NULL, "actor" = NULL WHERE "id" = true`);
      const held = await db.sql.reserve();
      const other = postgres(URL, { max: 1, onnotice: () => undefined });
      try {
        await held.unsafe('BEGIN');
        await held.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema));
        await expect(
          other.unsafe(
            `SET lock_timeout = '400ms'; UPDATE "${db.schema}"."posting_freeze" SET "frozen" = true, "reason" = 'race', "actor" = 'tester' WHERE "id" = true`,
          ),
        ).rejects.toMatchObject({ code: '55P03' });
        await held.unsafe('ROLLBACK');
        const still = await db.sql.unsafe(`SELECT "frozen" FROM "${db.schema}"."posting_freeze" WHERE "id" = true`);
        expect(still).toHaveLength(1);
        expect(still[0]?.frozen).toBe(false);
      } finally {
        await held.unsafe('ROLLBACK').catch(() => undefined);
        held.release();
        await other.end();
      }
    });

    it('refuses the drop while a freeze is recorded and leaves the row', async () => {
      await db.sql.unsafe(
        `UPDATE "${db.schema}"."posting_freeze" SET "frozen" = true, "reason" = 'halt', "actor" = 'ops' WHERE "id" = true`,
      );
      await expect(db.sql.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema))).rejects.toMatchObject({ code: 'P0001' });
      const rows = await db.sql<Array<{ frozen: boolean }>>`
        SELECT "frozen" FROM ${db.sql(db.schema)}."posting_freeze" WHERE "id" = true
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.frozen).toBe(true);
    });

    it('preserves attribution from an already-thawed historical switch', async () => {
      await db.sql.unsafe(
        `UPDATE "${db.schema}"."posting_freeze" SET "frozen" = false, "reason" = NULL, "actor" = 'historical-operator' WHERE "id" = true`,
      );
      await expect(db.sql.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema))).rejects.toMatchObject({ code: 'P0001' });
      expect((await db.sql.unsafe(`SELECT actor FROM "${db.schema}"."posting_freeze"`))[0]?.actor).toBe('historical-operator');
    });

    it('drops the table once the freeze has been thawed', async () => {
      await db.sql.unsafe(`UPDATE "${db.schema}"."posting_freeze" SET "frozen" = false, "reason" = NULL, "actor" = NULL WHERE "id" = true`);
      await db.sql.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema));
      const left = await db.sql<Array<{ name: string | null }>>`
        SELECT to_regclass(${db.schema + '.posting_freeze'}) AS name
      `;
      expect(left[0]?.name).toBeNull();
    });
  });
}

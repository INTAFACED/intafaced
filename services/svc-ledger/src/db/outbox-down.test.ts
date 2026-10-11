import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';

/**
 * 0013's down counts unpublished outbox rows, then drops the table in a
 * later statement. The count takes no lock. Under READ COMMITTED a post can
 * commit a new unpublished row after that count and before DROP TABLE, and
 * the drop discards the intent.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const DOWN = readFileSync(join(drizzleDir, '0013_tx_posted_outbox.down.sql'), 'utf8');

function guardBlock(sql: string): string {
  const start = sql.indexOf('DO $$');
  const end = sql.indexOf('END $$;');
  if (start < 0 || end < 0) throw new Error('down migration has no DO block');
  return sql.slice(start, end + 'END $$;'.length);
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('0013 down outbox lock (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('0013 down — a post cannot commit between the count and the drop', () => {
    let db: TestDb;

    beforeAll(async () => {
      db = await createTestDb({ service: 'ledger_outboxdown', url: URL, migrations });
    });
    afterAll(async () => {
      await db?.drop();
    });

    async function txId(key: string): Promise<string> {
      const rows = await db.sql<Array<{ id: string }>>`
        INSERT INTO ${db.sql(db.schema)}.ledger_tx (idempotency_key, module, reason, hash)
        VALUES (${key}, 'ledger', 'probe', 'hash')
        RETURNING id
      `;
      return rows[0]!.id;
    }

    it('holds the outbox so a concurrent unpublished insert times out', async () => {
      const end = DOWN.indexOf('END $$;');
      const drop = DOWN.indexOf('DROP TABLE');
      expect(drop).toBeGreaterThan(0);
      expect(drop).toBeLessThan(end);
      const held = await db.sql.reserve();
      const other = postgres(URL, { max: 1, onnotice: () => undefined });
      const id = await txId('l686-race');
      try {
        await held.unsafe('BEGIN');
        await held.unsafe(rewriteSchemaSql(guardBlock(DOWN), 'ledger', db.schema));
        await expect(
          other.unsafe(
            `SET lock_timeout = '400ms'; INSERT INTO "${db.schema}"."ledger_tx_outbox" ("tx_id", "payload", "correlation_id") VALUES ('${id}', '{"entries":[]}'::jsonb, 'l686-race')`,
          ),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await held.unsafe('ROLLBACK').catch(() => undefined);
        held.release();
        await other.end();
        await db.sql.unsafe(`DELETE FROM "${db.schema}"."ledger_tx_outbox" WHERE "correlation_id" = 'l686-race'`).catch(() => undefined);
      }
    });

    it('refuses the drop while an unpublished row is waiting and leaves it', async () => {
      const id = await txId('l686-unpublished');
      await db.sql.unsafe(
        `INSERT INTO "${db.schema}"."ledger_tx_outbox" ("tx_id", "payload", "correlation_id") VALUES ('${id}', '{"entries":[]}'::jsonb, 'l686-unpublished')`,
      );
      await expect(db.sql.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema))).rejects.toMatchObject({ code: 'P0001' });
      const rows = await db.sql<Array<{ correlation_id: string }>>`
        SELECT correlation_id FROM ${db.sql(db.schema)}.ledger_tx_outbox WHERE correlation_id = 'l686-unpublished'
      `;
      expect(rows).toHaveLength(1);
    });

    it('drops the table once every outbox row is published', async () => {
      await db.sql.unsafe(
        `UPDATE "${db.schema}"."ledger_tx_outbox" SET "published_at" = now() WHERE "correlation_id" = 'l686-unpublished'`,
      );
      await db.sql.unsafe(rewriteSchemaSql(DOWN, 'ledger', db.schema));
      const left = await db.sql<Array<{ name: string | null }>>`
        SELECT to_regclass(${db.schema + '.ledger_tx_outbox'}) AS name
      `;
      expect(left[0]?.name).toBeNull();
    });
  });
}

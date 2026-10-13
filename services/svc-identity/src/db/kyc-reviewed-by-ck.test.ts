import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';

/**
 * kyc_reviewed_by_ck is the database backstop that a reviewed row names its
 * reviewer. 0001 comments that rule and then checks reviewed_at only, so a new
 * non-pending row with a null reviewer is accepted. NOT VALID must stay: the
 * inherited backlog is not scanned into a failure and is not given a name.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const CHECK_VIOLATION = '23514';

/** True when this migration's kyc_reviewed_by_ck predicate actually names reviewed_by. */
function migrationRequiresNamedReviewer(sql: string): boolean {
  const pattern = /ADD CONSTRAINT "kyc_reviewed_by_ck"\s+CHECK \(([\s\S]*?)\)\s*NOT VALID/gi;
  for (const match of sql.matchAll(pattern)) {
    if (match[1]?.includes('"reviewed_by"')) return true;
  }
  return false;
}

const files = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(drizzleDir, name), 'utf8') }));

const cut = files.findIndex((file) => migrationRequiresNamedReviewer(file.sql));
const inherited = cut === -1 ? files : files.slice(0, cut);
const tightened = cut === -1 ? [] : files.slice(cut);

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('kyc_reviewed_by_ck (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('kyc_reviewed_by_ck', () => {
    let db: TestDb | undefined;

    afterAll(async () => {
      await db?.drop();
    });

    it('refuses a new non-pending row that does not name its reviewer, and leaves the backlog unnamed', async () => {
      db = await createTestDb({ service: 'identity_kyc_reviewer', url: URL, migrations: [] });
      const apply = async (batch: typeof files) => {
        for (const file of batch) {
          await db!.sql.unsafe(rewriteSchemaSql(file.sql, 'identity', db!.schema));
        }
      };

      await apply(inherited);

      const [user] = await db.sql<Array<{ id: string }>>`
        INSERT INTO users (handle, email, password_hash)
        VALUES ('l224user', 'l224user@example.com', 'hash')
        RETURNING id
      `;
      const userId = user!.id;

      const [backlog] = await db.sql<Array<{ id: string; reviewed_by: string | null; reviewed_at: Date; status: string }>>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_at, reviewed_by)
        VALUES (${userId}, 'basic', 'DE', 'approved', now(), NULL)
        RETURNING id, reviewed_by, reviewed_at, status::text AS status
      `;
      const [pendingBefore] = await db.sql<Array<{ id: string; reviewed_by: string | null }>>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, status)
        VALUES (${userId}, 'basic', 'DE', 'pending')
        RETURNING id, reviewed_by
      `;

      await apply(tightened);

      const [backlogAfter] = await db.sql<Array<{ reviewed_by: string | null; reviewed_at: Date; status: string }>>`
        SELECT reviewed_by, reviewed_at, status::text AS status
          FROM kyc_records
         WHERE id = ${backlog!.id}
      `;
      expect(backlogAfter?.status).toBe('approved');
      expect(backlogAfter?.reviewed_by).toBeNull();
      expect(new Date(backlogAfter!.reviewed_at).getTime()).toBe(new Date(backlog!.reviewed_at).getTime());

      const [pendingAfter] = await db.sql<Array<{ reviewed_by: string | null }>>`
        SELECT reviewed_by FROM kyc_records WHERE id = ${pendingBefore!.id}
      `;
      expect(pendingAfter?.reviewed_by).toBeNull();

      const insertReviewed = (reviewedBy: string | null) => {
        if (reviewedBy === null) {
          return db!.sql`
            INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_at, reviewed_by)
            VALUES (${userId}, 'basic', 'DE', 'approved', now(), NULL)
          `;
        }
        return db!.sql`
          INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_at, reviewed_by)
          VALUES (${userId}, 'basic', 'DE', 'approved', now(), ${reviewedBy})
        `;
      };

      await expect(insertReviewed(null)).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint_name: 'kyc_reviewed_by_ck',
      });
      for (const blank of ['', ' ', '   ', '\t', '\n', ' \t\n ']) {
        await expect(insertReviewed(blank)).rejects.toMatchObject({
          code: CHECK_VIOLATION,
          constraint_name: 'kyc_reviewed_by_ck',
        });
      }

      await expect(
        db.sql`
          INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_by)
          VALUES (${userId}, 'basic', 'DE', 'pending', '   ')
        `,
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint_name: 'kyc_reviewed_by_ck',
      });

      const [pendingNew] = await db.sql<Array<{ reviewed_by: string | null; status: string }>>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, status)
        VALUES (${userId}, 'full', 'DE', 'pending')
        RETURNING reviewed_by, status::text AS status
      `;
      expect(pendingNew?.status).toBe('pending');
      expect(pendingNew?.reviewed_by).toBeNull();

      await expect(insertReviewed('operator-1')).resolves.toBeDefined();

      const [constraints] = await db.sql<Array<{ convalidated: boolean; def: string }>>`
        SELECT c.convalidated, pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE c.conname = 'kyc_reviewed_by_ck'
           AND n.nspname = ${db.schema}
      `;
      expect(constraints?.convalidated).toBe(false);
      expect(constraints?.def).toContain('reviewed_by');
    });
  });
}

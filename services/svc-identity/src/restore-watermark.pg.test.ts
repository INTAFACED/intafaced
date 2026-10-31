import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterAll } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { restoreWatermarkReadSchema } from '@intafaced/contracts';
import { createTestDb } from './fixture-truncate.testkit.js';
import {
  OPERATOR_TRAFFIC_TABLES,
  WATERMARK_KIND,
  digestCounts,
  readIdentityWatermark,
} from './restore-watermark.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

describe('digestCounts', () => {
  it('does not depend on the order the tables come in, and moves when a count does', () => {
    const a = [
      { table: 'a', rows: 1n },
      { table: 'b', rows: 2n },
    ];
    expect(digestCounts(a)).toBe(digestCounts([...a].reverse()));
    expect(digestCounts(a)).not.toBe(
      digestCounts([
        { table: 'a', rows: 1n },
        { table: 'b', rows: 3n },
      ]),
    );
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('identity restore watermark (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_restore_wm',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('identity restore watermark (real Postgres)', () => {
    it('reads a contract-shaped position, stable while nothing is written', async () => {
      const first = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(restoreWatermarkReadSchema.parse(first).service).toBe('identity');
      const second = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect({ ...second, readAt: '' }).toEqual({ ...first, readAt: '' });
    });

    it('moves the position, the digest and lastWriteAt when a row is written, and is back once the write is rolled back', async () => {
      const before = await readIdentityWatermark(db.sql, new Date(), db.schema);
      const ROLLBACK = new Error('rollback');
      let inside: Awaited<ReturnType<typeof readIdentityWatermark>> | undefined;
      await db.sql
        .begin(async (tx) => {
          await tx`INSERT INTO users (handle, email, password_hash) VALUES ('wm_user', 'wm@example.com', 'x')`;
          inside = await readIdentityWatermark(tx as unknown as typeof db.sql, new Date(), db.schema);
          throw ROLLBACK;
        })
        .catch((err: unknown) => {
          if (err !== ROLLBACK) throw err;
        });
      expect(BigInt(inside!.position)).toBeGreaterThan(BigInt(before.position));
      expect(inside!.integrity).not.toBe(before.integrity);
      expect(inside!.lastWriteAt).not.toBeNull();
      expect(Date.parse(inside!.lastWriteAt!)).toBeLessThanOrEqual(Date.now() + 1000);
      const after = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(after.position).toBe(before.position);
      expect(after.integrity).toBe(before.integrity);
    });

    it('reads the same lastWriteAt whatever timezone the session runs in', async () => {
      await db.sql`INSERT INTO users (handle, email, password_hash) VALUES ('wm_tz', 'wmtz@example.com', 'x')`;
      const utc = await readIdentityWatermark(db.sql, new Date(), db.schema);
      const west = await db.sql.begin(async (tx) => {
        await tx`SET LOCAL timezone = 'America/New_York'`;
        return readIdentityWatermark(tx as unknown as typeof db.sql, new Date(), db.schema);
      });
      expect(west.lastWriteAt).not.toBeNull();
      expect(west.lastWriteAt).toBe(utc.lastWriteAt);
    });

    it('names only tables that exist, so a renamed table cannot drop out of the exclusions unseen', async () => {
      const tables = await db.sql<Array<{ t: string }>>`
        SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ${db.schema} AND table_type = 'BASE TABLE'`;
      const present = new Set(tables.map((r) => r.t));
      for (const name of Object.keys(OPERATOR_TRAFFIC_TABLES)) {
        expect(present.has(name), name).toBe(true);
      }
    });

    it('is unmoved by sign-in traffic, and still moves for a change to an existing record (J-ops-console-08 #7)', async () => {
      const [user] = await db.sql<Array<{ id: string }>>`
        INSERT INTO users (handle, email, password_hash, created_at, updated_at)
        VALUES ('wm_signin', 'wmsignin@example.com', 'x', now() - interval '1 hour', now() - interval '1 hour') RETURNING id`;
      await db.sql`UPDATE users SET updated_at = now() - interval '1 hour'`;
      const before = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(before.kind).toBe(WATERMARK_KIND);
      // A failed second step at sign-in: the attempt row is traffic.
      await db.sql`INSERT INTO auth_attempts (user_id, kind, failures) VALUES (${user!.id}, 'mfa', 1)`;
      const signedIn = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect({ ...signedIn, readAt: '' }).toEqual({ ...before, readAt: '' });
      // Freezing the account changes no count, but it is a write after the cut-off and shows as one.
      await db.sql`UPDATE users SET status = 'frozen', updated_at = now() WHERE id = ${user!.id}`;
      const frozen = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(frozen.position).toBe(before.position);
      expect(Date.parse(frozen.lastWriteAt!)).toBeGreaterThan(Date.parse(before.lastWriteAt!));
    });
  });
}

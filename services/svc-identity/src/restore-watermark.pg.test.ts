import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterAll } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { restoreWatermarkReadSchema } from '@intafaced/contracts';
import { createTestDb } from './fixture-truncate.testkit.js';
import { digestCounts, readIdentityWatermark } from './restore-watermark.js';

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
  });
}

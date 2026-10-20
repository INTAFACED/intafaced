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

    it('moves the position, the digest and lastWriteAt when a row is written, and back when it is removed', async () => {
      const before = await readIdentityWatermark(db.sql, new Date(), db.schema);
      const [u] = await db.sql<Array<{ id: string }>>`
        INSERT INTO users (handle, email, password_hash) VALUES ('wm_user', 'wm@example.com', 'x') RETURNING id`;
      const after = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(BigInt(after.position)).toBeGreaterThan(BigInt(before.position));
      expect(after.integrity).not.toBe(before.integrity);
      expect(after.lastWriteAt).not.toBeNull();
      expect(Date.parse(after.lastWriteAt!)).toBeLessThanOrEqual(Date.now() + 1000);
      await db.sql`DELETE FROM users WHERE id = ${u!.id}`;
      const gone = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(gone.position).toBe(before.position);
      expect(gone.integrity).toBe(before.integrity);
    });
  });
}

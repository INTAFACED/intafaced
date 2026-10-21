import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { restoreWatermarkReadSchema } from '@intafaced/contracts';
import { digestCounts, readPayWatermark } from './restore-watermark.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  if (!parsed.pathname.replace(/^\//, '').endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

if (!process.env.TEST_DATABASE_URL?.trim()) {
  throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
}

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

let db!: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ service: 'pay', url: dedicatedTestUrl(process.env.TEST_DATABASE_URL!.trim()), migrations });
}, 120_000);
afterAll(() => db?.drop());

describe('pay restore watermark (real Postgres)', () => {
  it('reads a contract-shaped position, stable while nothing is written', async () => {
    const first = await readPayWatermark(db.sql, new Date(), db.schema);
    expect(restoreWatermarkReadSchema.parse(first).service).toBe('pay');
    const second = await readPayWatermark(db.sql, new Date(), db.schema);
    expect({ ...second, readAt: '' }).toEqual({ ...first, readAt: '' });
  });

  it('moves the position, the digest and lastWriteAt when a row is written, and back when it is removed', async () => {
    const before = await readPayWatermark(db.sql, new Date(), db.schema);
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO merchants (user_id) VALUES ('wm-user') RETURNING id`;
    const after = await readPayWatermark(db.sql, new Date(), db.schema);
    expect(BigInt(after.position)).toBeGreaterThan(BigInt(before.position));
    expect(after.integrity).not.toBe(before.integrity);
    expect(after.lastWriteAt).not.toBeNull();
    expect(Date.parse(after.lastWriteAt!)).toBeLessThanOrEqual(Date.now() + 1000);
    await db.sql`DELETE FROM merchants WHERE id = ${row!.id}`;
    const gone = await readPayWatermark(db.sql, new Date(), db.schema);
    expect(gone.position).toBe(before.position);
    expect(gone.integrity).toBe(before.integrity);
  });

  it('reads the same lastWriteAt whatever timezone the session runs in', async () => {
    await db.sql`INSERT INTO merchants (user_id) VALUES ('wm-tz')`;
    const utc = await readPayWatermark(db.sql, new Date(), db.schema);
    const west = await db.sql.begin(async (tx) => {
      await tx`SET LOCAL timezone = 'America/New_York'`;
      return readPayWatermark(tx as unknown as typeof db.sql, new Date(), db.schema);
    });
    expect(west.lastWriteAt).not.toBeNull();
    expect(west.lastWriteAt).toBe(utc.lastWriteAt);
  });
});

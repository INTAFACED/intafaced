/**
 * J-cex-spot-06 #6: when a stop fired and the price that reached it, kept from matching.order.triggered in
 * trade.order_stop_trigger. The first record wins; a stop with no row here is not recorded.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlStopTrigger } from './stop-trigger-door.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const ORDER = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_stop_fired_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('a stop that fired keeps when and at what price (PG)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  it('records the first trigger, reads it back at full precision, and ignores a later one', async () => {
    const store = sqlStopTrigger(db.sql);
    await store.remember(ORDER, ALICE, '100');
    expect(await store.readFired([ORDER])).toEqual(new Map());

    const fired = { at: '2026-10-23T03:00:00.123Z', by: 'last' as const, referencePrice: '99.123456789012345678', sequence: 41 };
    expect(await store.recordFired(ORDER, fired)).toBe(true);
    expect(await store.recordFired(ORDER, { ...fired, referencePrice: '90', sequence: 99 })).toBe(true);
    expect((await store.readFired([ORDER, OTHER])).get(ORDER)).toEqual(fired);
    // The stop price itself is untouched.
    expect(await store.read(ORDER)).toBe('100');
  });

  it('does not record a stop it does not hold', async () => {
    const store = sqlStopTrigger(db.sql);
    const fired = { at: '2026-10-23T03:00:00.000Z', by: 'mark' as const, referencePrice: '1', sequence: 1 };
    expect(await store.recordFired(OTHER, fired)).toBe(false);
    expect(await db.sql`SELECT 1 FROM trade.order_stop_trigger WHERE order_id = ${OTHER}`).toHaveLength(0);
    await store.remember(OTHER, ALICE, '5');
    expect(await store.recordFired(OTHER, { ...fired, referencePrice: '0' })).toBe(false);
    expect(await store.readFired([OTHER])).toEqual(new Map());
    // A bracket child's stop (`<uuid>:sl`) is not this table's: answered, not a database error the bus would redeliver.
    expect(await store.recordFired(`${OTHER}:sl`, { ...fired, referencePrice: '5' })).toBe(false);
  });

  it('refuses a half-written trigger at the table', async () => {
    await expect(db.sql`UPDATE trade.order_stop_trigger SET triggered_at = now() WHERE order_id = ${OTHER}`).rejects.toThrow(
      /order_stop_trigger_fired_ck/,
    );
  });
});

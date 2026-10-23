import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { statusPageConfigureInputSchema } from '@intafaced/contracts';
import { SqlStatusPageBook } from './book.js';

/**
 * The status page book on the real tables. The page row is one shared singleton, so the test puts the definition it
 * found back at the end; the log and the readings are append-only and keep what the test wrote.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const FOUNDER = 'st4tus-p4ge-1111-4111-8111-111111111111';
const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify status-page book.pg.test');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()) {
    await client.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
});

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => undefined);
});

describe.skipIf(!URL || !available)('status page book on the shared test database', () => {
  it('stores the notice category list as an owner value, cleared with null', async () => {
    const book = new SqlStatusPageBook(client!);
    const before = await book.definition();
    const change = (noticeCategories: unknown, expectedRevision: number) =>
      book.configure({
        input: statusPageConfigureInputSchema.parse({ reason: 'TEST pg categories', expectedRevision, noticeCategories }),
        by: FOUNDER,
        at: new Date().toISOString(),
      });
    const list = [{ id: 'pg-test-listings', name: 'TEST listings' }];
    const set = await change(list, before.revision);
    try {
      expect(set.noticeCategories).toEqual(list);
      expect((await book.definition()).noticeCategories).toEqual(list);
      expect((await change(null, set.revision)).noticeCategories).toBeNull();
    } finally {
      const now = await book.definition();
      if (JSON.stringify(now.noticeCategories) !== JSON.stringify(before.noticeCategories))
        await change(before.noticeCategories, now.revision);
    }
  });

  it('defines, replays, refuses a stale revision, stores one reading per instant, and keeps the log append-only', async () => {
    const book = new SqlStatusPageBook(client!);
    const before = await book.definition();
    const at = new Date();
    const change = (fields: Record<string, unknown>, expectedRevision: number) =>
      book.configure({
        input: statusPageConfigureInputSchema.parse({ reason: 'TEST pg', expectedRevision, ...fields }),
        by: FOUNDER,
        at: at.toISOString(),
      });
    const components = [{ id: 'pg-test-trading', name: 'Trading', group: null, source: null }];
    const set = await change({ components, componentCap: 3, stalenessSeconds: 60, uptimeDays: 2 }, before.revision);
    try {
      expect(set).toMatchObject({ components, componentCap: 3, stalenessSeconds: 60, uptimeDays: 2, revision: before.revision + 1 });
      expect((await change({ components, componentCap: 3, stalenessSeconds: 60, uptimeDays: 2 }, before.revision)).revision).toBe(
        set.revision,
      );
      await expect(change({ componentCap: 2 }, before.revision)).rejects.toMatchObject({ code: 'status.page_revision_stale' });

      const reading = {
        componentId: 'pg-test-trading',
        state: 'operational' as const,
        observedAt: new Date(at.getTime() - 1000),
        source: 'TEST',
      };
      await book.record(reading, FOUNDER, at);
      await book.record(reading, FOUNDER, at);
      await expect(book.record({ ...reading, state: 'degraded' }, FOUNDER, at)).rejects.toMatchObject({ code: 'status.reading_conflict' });
      await expect(book.record({ ...reading, componentId: 'pg-test-ghost' }, FOUNDER, at)).rejects.toMatchObject({
        code: 'status.component_unknown',
      });
      expect((await book.daily(reading.observedAt)).find((d) => d.componentId === 'pg-test-trading')?.states).toEqual(['operational']);
      expect((await book.latest()).find((r) => r.componentId === 'pg-test-trading')).toMatchObject({ state: 'operational' });

      await expect(client!`DELETE FROM notify.status_readings WHERE component_id = 'pg-test-trading'`).rejects.toThrow(/append-only/);
      await expect(client!`UPDATE notify.status_page_log SET reason = 'x' WHERE set_by = ${FOUNDER}`).rejects.toThrow(/append-only/);
    } finally {
      await change(
        {
          components: before.components,
          componentCap: before.componentCap,
          stalenessSeconds: before.stalenessSeconds,
          uptimeDays: before.uptimeDays,
        },
        set.revision,
      );
    }
  });
});

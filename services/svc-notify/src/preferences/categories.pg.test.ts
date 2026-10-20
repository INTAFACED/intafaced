import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { PostgresCommandLog } from './account.pg.js';
import { CategoryPrefs } from './categories.js';
import { PostgresCategoryPrefStore } from './categories.pg.js';

/**
 * Durable category choices on a test database. Cleanup deletes only this file's ids.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const USER = 'c4t0ry00-1111-4111-8111-111111111111';
const OTHER = 'c4t0ry00-2222-4222-8222-222222222222';

const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

function db(): Sql {
  if (!client) throw new Error('TEST_DATABASE_URL_NOTIFY and TEST_DATABASE_URL are unset');
  return client;
}

async function cleanup(sql: Sql): Promise<void> {
  await sql`DELETE FROM notify.category_pref_history WHERE user_id IN (${USER}, ${OTHER})`;
  await sql`DELETE FROM notify.category_prefs WHERE user_id IN (${USER}, ${OTHER})`;
  await sql`DELETE FROM notify.preference_commands WHERE user_id IN (${USER}, ${OTHER})`;
}

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify categories.pg.test');
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of files) {
    await client.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
  await cleanup(client);
});

afterAll(async () => {
  if (!client) return;
  await cleanup(client).catch(() => undefined);
  await client.end({ timeout: 1 }).catch(() => undefined);
});

describe.skipIf(!URL || !available)('category choices on the shared test database', () => {
  const prefs = () => new CategoryPrefs(new PostgresCategoryPrefStore(db()), new PostgresCommandLog(db()), () => []);

  it('keeps the last write per cell, records both writes, and hides another account', async () => {
    const store = new PostgresCategoryPrefStore(db());
    expect(await store.set(USER, 'news', 'email', false)).toEqual({ changed: true });
    expect(await store.set(USER, 'news', 'email', false)).toEqual({ changed: false });
    expect(await store.set(USER, 'news', 'email', true)).toEqual({ changed: true });
    expect(await store.get(USER, 'news', 'email')).toBe(true);
    const history = await db()<{ enabled: boolean }[]>`
      SELECT enabled FROM notify.category_pref_history WHERE user_id = ${USER} AND category = 'news' ORDER BY changed_at, id
    `;
    expect(history.map((row) => row.enabled).sort()).toEqual([false, true]);
    expect(await store.list(OTHER)).toEqual([]);
  });

  it('settles two simultaneous writes to the same cell on one value, with a history row per change', async () => {
    const store = new PostgresCategoryPrefStore(db());
    await Promise.all([
      store.set(USER, 'status', 'sms', false),
      store.set(USER, 'status', 'sms', false),
      store.set(USER, 'status', 'sms', true),
    ]);
    const final = await store.get(USER, 'status', 'sms');
    const rows = await db()<{ enabled: boolean }[]>`
      SELECT enabled FROM notify.category_prefs WHERE user_id = ${USER} AND category = 'status' AND channel = 'sms'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(final);
    const history = await db()<{ n: string }[]>`
      SELECT count(*)::text AS n FROM notify.category_pref_history WHERE user_id = ${USER} AND category = 'status' AND channel = 'sms'
    `;
    expect(Number(history[0]!.n)).toBeGreaterThanOrEqual(1);
    expect(Number(history[0]!.n)).toBeLessThanOrEqual(3);
  });

  it('replays a client request and refuses to store a locked cell', async () => {
    const first = await prefs().set(USER, { category: 'promotions', channel: 'push', enabled: false, clientRequestId: 'pg-cat-1' });
    const replay = await prefs().set(USER, { category: 'promotions', channel: 'push', enabled: true, clientRequestId: 'pg-cat-1' });
    expect(replay).toEqual(first);
    const locked = await prefs().set(USER, { category: 'security', channel: 'email', enabled: false, clientRequestId: 'pg-cat-2' });
    expect(locked.locked).toBe(true);
    const stored = await db()<
      { n: string }[]
    >`SELECT count(*)::text AS n FROM notify.category_prefs WHERE user_id = ${USER} AND category = 'security'`;
    expect(stored[0]!.n).toBe('0');
  });
});

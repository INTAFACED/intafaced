import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { SqlNavMetricStore } from './counts.js';

/** The navigation counts on the real table. Each run reads a far-past day of its own, so other runs' rows do not matter. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify nav metric counts.pg.test');
  await client.unsafe(readFileSync(join(migrations, '0036_notify_nav_metric_counts.sql'), 'utf8')).catch(() => undefined);
});

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => undefined);
});

describe.skipIf(!URL || !available)('navigation counts on the shared test database', () => {
  it('adds one per miss on the UTC day, keeps only the count, and reads a window', async () => {
    const store = new SqlNavMetricStore(client!);
    const year = 1900 + Math.floor(Math.random() * 90);
    const day = `${year}-06-15`;
    await client!`DELETE FROM notify.nav_metric_counts WHERE day = ${day}::date`;
    await Promise.all([1, 2, 3].map(() => store.count('search_miss', new Date(`${day}T23:00:00Z`))));
    expect(await store.read('search_miss', `${year}-06-14`, `${year}-06-16`)).toEqual([{ day, count: 3 }]);
    const columns = await client!<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'notify' AND table_name = 'nav_metric_counts' ORDER BY column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual(['count', 'day', 'kind']);
  });

  it('refuses a kind it does not know', async () => {
    await expect(client!`INSERT INTO notify.nav_metric_counts (kind, day) VALUES ('who_searched', '2000-01-01')`).rejects.toThrow();
  });
});

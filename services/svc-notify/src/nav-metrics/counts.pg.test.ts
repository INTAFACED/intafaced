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

if (!client) {
  describe.skip('navigation counts (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('navigation counts on the shared test database', () => {
    it('adds one per miss on the UTC day, keeps only the count, and reads a window', async () => {
      const store = new SqlNavMetricStore(client!);
      // A random day in years 1000 to 1899, far from today's real counts and unlikely to meet another run's day.
      const at = Date.UTC(1000, 0, 1) + Math.floor(Math.random() * 900 * 365) * 86_400_000;
      const iso = (offset: number) => new Date(at + offset * 86_400_000).toISOString().slice(0, 10);
      const day = iso(0);
      await client!`DELETE FROM notify.nav_metric_counts WHERE day = ${day}::date`;
      await Promise.all([1, 2, 3].map(() => store.count('search_miss', new Date(`${day}T23:00:00Z`))));
      expect(await store.read('search_miss', iso(-1), iso(1))).toEqual([{ day, count: 3 }]);
      const columns = await client!<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_schema = 'notify' AND table_name = 'nav_metric_counts' ORDER BY column_name
      `;
      expect(columns.map((row) => row.column_name)).toEqual(['count', 'day', 'kind']);
    });

    it('refuses a kind it does not know', async () => {
      await expect(client!`INSERT INTO notify.nav_metric_counts (kind, day) VALUES ('who_searched', '2000-01-01')`).rejects.toThrow();
    });
  });
}

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { SqlTemplateStore } from './templates.pg.js';

/** The incident template store on the real table. Each run uses its own ids and a cap above what other runs left. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify templates.pg.test');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()) {
    await client.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
});

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => undefined);
});

if (!URL || !available) {
  describe.skip('incident template store on the shared test database (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else
  describe('incident template store on the shared test database', () => {
    it('replaces by id, retires, brings a retired id back, and refuses growth past the cap', async () => {
      const store = new SqlTemplateStore(client!);
      const id = `t-${randomUUID().slice(0, 8)}`;
      const at = new Date('2026-10-23T12:00:00.000Z');
      const template = {
        id,
        name: 'TEST',
        group: null,
        title: 'TEST title',
        body: 'TEST body',
        impact: 'minor' as const,
        components: ['api'],
        definedBy: 'f',
        definedAt: at.toISOString(),
      };
      expect(await store.put(template, 10_000)).toBe(true);
      expect(await store.put({ ...template, title: 'TEST title 2' }, 10_000)).toBe(true);
      expect(await store.find(id)).toMatchObject({ title: 'TEST title 2', components: ['api'], impact: 'minor' });
      expect(await store.retire(id, 'f', at)).toBe(true);
      expect(await store.retire(id, 'f', at)).toBe(false);
      expect(await store.find(id)).toBeNull();
      expect((await store.list()).some((t) => t.id === id)).toBe(false);
      expect(await store.put(template, 10_000)).toBe(true);
      expect(await store.find(id)).toMatchObject({ title: 'TEST title' });
      const active = (await store.list()).length;
      expect(await store.put({ ...template, id: `${id}-x` }, active)).toBe(false);
      expect(await store.put({ ...template, title: 'TEST replace at cap' }, active)).toBe(true);
      await store.retire(id, 'f', at);
    });

    it('the table refuses components with no impact', async () => {
      const store = new SqlTemplateStore(client!);
      const bad = {
        id: `t-${randomUUID().slice(0, 8)}`,
        name: 'TEST',
        group: null,
        title: 'T',
        body: 'B',
        impact: null,
        components: ['api'],
        definedBy: 'f',
        definedAt: new Date().toISOString(),
      };
      await expect(store.put(bad, 10_000)).rejects.toThrow();
    });
  });

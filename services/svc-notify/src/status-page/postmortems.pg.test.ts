import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { SqlPostmortemStore } from './postmortems.pg.js';

/** The postmortem store on the real tables. Each test uses its own incident id. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify postmortems.pg.test');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()) {
    await client.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
});

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => undefined);
});

const at = new Date('2026-10-23T12:00:00.000Z');

if (!URL || !available) {
  describe.skip('postmortem store on the shared test database (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else
  describe('postmortem store on the shared test database', () => {
    it('writes by version, refuses a stale edit, and lists drafts for founders only', async () => {
      const store = new SqlPostmortemStore(client!);
      const incidentId = randomUUID();
      expect(await store.write({ incidentId, body: 'TEST first', writtenBy: 'a', at }, 0)).toMatchObject({ version: 1, status: 'draft' });
      expect(await store.write({ incidentId, body: 'TEST again', writtenBy: 'a', at }, 0)).toBe('stale');
      expect(await store.write({ incidentId, body: 'TEST second', writtenBy: 'b', at }, 1)).toMatchObject({ version: 2, writtenBy: 'b' });
      expect(await store.write({ incidentId, body: 'TEST third', writtenBy: 'b', at }, 1)).toBe('stale');
      expect((await store.forIncidents([incidentId, randomUUID()])).map((p) => p.incidentId)).toEqual([incidentId]);
      expect((await store.published(200)).some((p) => p.incidentId === incidentId)).toBe(false);
    });

    it('publishes and records the approval together, once; a stale version lands neither', async () => {
      const store = new SqlPostmortemStore(client!);
      const incidentId = randomUUID();
      const approvalId = `appr-${randomUUID()}`;
      await store.write({ incidentId, body: 'TEST', writtenBy: 'a', at }, 0);
      expect(await store.publishWith(incidentId, 2, { approvalId, publishedBy: 'a', at })).toBe('stale');
      expect(await store.approvalUse(approvalId)).toBeNull();
      expect(await store.publishWith(incidentId, 1, { approvalId, publishedBy: 'a', at })).toBe('published');
      expect(await store.approvalUse(approvalId)).toEqual({ outcome: 'published', incidentId, publisherId: 'a' });
      expect(await store.publishWith(incidentId, 1, { approvalId, publishedBy: 'a', at })).toBe('spent');
      expect(await store.write({ incidentId, body: 'TEST edit', writtenBy: 'a', at }, 1)).toBe('published');
      expect((await store.published(200)).find((p) => p.incidentId === incidentId)).toMatchObject({ status: 'published', version: 1 });
    });

    it('a refusal spends the approval without publishing', async () => {
      const store = new SqlPostmortemStore(client!);
      const incidentId = randomUUID();
      const approvalId = `appr-${randomUUID()}`;
      await store.write({ incidentId, body: 'TEST', writtenBy: 'a', at }, 0);
      await store.recordRefusal(approvalId, incidentId, 'b', 'refused_same_operator');
      expect(await store.approvalUse(approvalId)).toMatchObject({ outcome: 'refused_same_operator', publisherId: 'b' });
      expect(await store.publishWith(incidentId, 1, { approvalId, publishedBy: 'a', at })).toBe('spent');
      expect(await store.get(incidentId)).toMatchObject({ status: 'draft' });
    });

    it('two publishes racing on one draft: exactly one lands', async () => {
      const store = new SqlPostmortemStore(client!);
      const incidentId = randomUUID();
      await store.write({ incidentId, body: 'TEST', writtenBy: 'a', at }, 0);
      const outcomes = await Promise.all([
        store.publishWith(incidentId, 1, { approvalId: `appr-${randomUUID()}`, publishedBy: 'a', at }),
        store.publishWith(incidentId, 1, { approvalId: `appr-${randomUUID()}`, publishedBy: 'b', at }),
      ]);
      expect(outcomes.sort()).toEqual(['published', 'stale']);
    });
  });

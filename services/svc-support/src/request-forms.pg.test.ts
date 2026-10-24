import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { RequestForms, SqlFormsStore } from './request-forms.js';

/**
 * Request form definitions against Postgres (SP-tickets-03): two leads writing at once cannot pass the owner's cap,
 * a stale revision writes nothing, and the log keeps one row per write.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const LEAD = '33333333-3333-4333-8333-333333333333';
const R = 'TEST reason';

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.endsWith('_test')) return raw;
  const admin = postgres(raw, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe('CREATE DATABASE adminops_harness_test');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) throw err;
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(raw);
  url.pathname = '/adminops_harness_test';
  return url.toString();
}

const url = await harnessUrl();

if (!url) {
  describe.skip('request forms (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  describe('SqlFormsStore', () => {
    it('concurrent creates on two connections stop at the cap', async () => {
      const second = postgres(db.url, { max: 1, onnotice: () => undefined });
      try {
        const a = new RequestForms(new SqlFormsStore(db.sql), { forms: 5, fields: 2 });
        const b = new RequestForms(new SqlFormsStore(second), { forms: 5, fields: 2 });
        const field = (id: string) => ({ id, label: id, kind: 'text', expectedRevision: 0, reason: R });
        const results = await Promise.allSettled([
          a.defineField(field('one'), LEAD),
          b.defineField(field('two'), LEAD),
          a.defineField(field('three'), LEAD),
          b.defineField(field('four'), LEAD),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
        for (const r of results.filter((r) => r.status === 'rejected'))
          expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'support.field_cap_reached' });
        const [live] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM support.request_definitions WHERE kind = 'field'`;
        expect(live?.n).toBe(2);
      } finally {
        await second.end({ timeout: 5 });
      }
    });

    it('a stale revision writes nothing; each write leaves one log row; retiring frees a place', async () => {
      const forms = new RequestForms(new SqlFormsStore(db.sql), { forms: 5, fields: 1 });
      const made = await forms.defineField({ id: 'one', label: 'One', kind: 'text', expectedRevision: 0, reason: R }, LEAD);
      await expect(
        forms.defineField({ id: 'one', label: 'Again', kind: 'text', expectedRevision: 0, reason: R }, LEAD),
      ).rejects.toMatchObject({ code: 'support.form_revision_stale' });
      await forms.defineField({ id: 'one', label: 'One', kind: 'text', retired: true, expectedRevision: made.revision, reason: R }, LEAD);
      await forms.defineField({ id: 'two', label: 'Two', kind: 'text', expectedRevision: 0, reason: R }, LEAD);
      const log = await db.sql`SELECT id, revision FROM support.request_definition_log ORDER BY at, id, revision`;
      expect(log.map((row) => `${row.id}@${row.revision}`)).toEqual(['one@1', 'one@2', 'two@1']);
    });
  });
}

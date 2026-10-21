import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * SP-csat-01 — the first resolve of a ticket writes its rating request in the same
 * transaction; a reopen and a second resolve write nothing more. Per-run database as in
 * status-pair-enum.pg.test.ts.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_rating_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let created = false;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const f of files) await sql.unsafe(readFileSync(join(migrationsDir, f), 'utf8'));
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end({ timeout: 5 });
});

describe('rating request trigger (SP-csat-01)', () => {
  it('records once on the first resolve and keeps the first resolve time', async () => {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO support.tickets (user_id, category, subject, body) VALUES ('u-rate', 'account', 's', 'b') RETURNING id
    `;
    const id = t!.id;
    await sql`UPDATE support.tickets SET status = 'pending' WHERE id = ${id}`;
    expect(await sql`SELECT 1 FROM support.rating_requests WHERE ticket_id = ${id}`).toHaveLength(0);
    await sql`UPDATE support.tickets SET status = 'resolved', updated_at = '2026-10-20T10:00:00Z' WHERE id = ${id}`;
    await sql`UPDATE support.tickets SET status = 'open' WHERE id = ${id}`;
    await sql`UPDATE support.tickets SET status = 'resolved', updated_at = '2026-10-21T10:00:00Z' WHERE id = ${id}`;
    const rows = await sql<{ user_id: string; resolved_at: Date; published_at: Date | null }[]>`
      SELECT user_id, resolved_at, published_at FROM support.rating_requests WHERE ticket_id = ${id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe('u-rate');
    expect(rows[0]!.resolved_at.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(rows[0]!.published_at).toBeNull();
  });
});

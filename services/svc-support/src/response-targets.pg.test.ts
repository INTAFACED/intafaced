import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLA_POLICY_STALE, SLA_TARGETS_UNSET, SqlResponseTargetBook } from './response-targets.js';
import { PostgresSupportStore } from './store.js';

/**
 * SP-sla-01 — the response target book against Postgres: one row, a business-keyed append-only log, a revision check under
 * a race, the database's own refusal of an active policy with no target, and one first-reply clock per ticket. Per-run
 * database as in attachment-settings.pg.test.ts; the name ends in _test and is never intafaced_test.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_slatgt_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
const USER = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-20T14:00:00.000Z';

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
  sql = postgres(url.toString(), { max: 8, onnotice: () => undefined });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const f of files) await sql.unsafe(readFileSync(join(migrationsDir, f), 'utf8'));
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

const change = (over: Record<string, unknown> = {}) => ({ expectedRevision: 0, by: 'lead-1', reason: 'TEST target', at: AT, ...over });

describe('SqlResponseTargetBook', () => {
  it('reads blank and off before anything is set', async () => {
    expect(await new SqlResponseTargetBook(sql).policy()).toEqual({ firstReplyMinutes: null, active: false, revision: 0, updatedAt: null });
  });

  it('refuses on with no target, then saves and logs once; a replay returns the stored policy; a stale change refuses', async () => {
    const book = new SqlResponseTargetBook(sql);
    await expect(book.save(change({ active: true }))).rejects.toMatchObject({ code: SLA_TARGETS_UNSET });
    const saved = await book.save(change({ firstReplyMinutes: 30, active: true }));
    expect(saved).toMatchObject({ firstReplyMinutes: 30, active: true, revision: 1 });
    expect(await book.save(change({ firstReplyMinutes: 30, active: true }))).toEqual(saved);
    await expect(book.save(change({ firstReplyMinutes: 45 }))).rejects.toMatchObject({ code: SLA_POLICY_STALE });
    const log = await sql<{ key: string }[]>`SELECT key FROM support.sla_policy_log ORDER BY revision_after`;
    expect(log.map((r) => r.key)).toEqual(['support.sla_policy:r0']);
    await expect(sql`DELETE FROM support.sla_policy_log`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE support.sla_policy SET first_reply_minutes = NULL`).rejects.toThrow(/check/i);
  });

  it('two changes from the same revision: one wins, the other is stale', async () => {
    const book = new SqlResponseTargetBook(sql);
    const { revision } = await book.policy();
    const results = await Promise.allSettled([
      book.save(change({ expectedRevision: revision, firstReplyMinutes: 10, reason: 'a' })),
      book.save(change({ expectedRevision: revision, firstReplyMinutes: 20, reason: 'b' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual([SLA_POLICY_STALE]);
  });

  it('starts one first-reply clock per ticket, due at its creation plus the target, and none while off', async () => {
    const book = new SqlResponseTargetBook(sql);
    const store = new PostgresSupportStore(sql);
    const on = await store.createTicket({ userId: USER, category: 'account', subject: 'on', body: 'b' });
    const off = await store.createTicket({ userId: USER, category: 'account', subject: 'off', body: 'b' });
    const policy = { firstReplyMinutes: 30, active: true, revision: 1, updatedAt: AT };
    await book.startClock(on.id, on.createdAt, policy);
    await book.startClock(on.id, on.createdAt, { ...policy, firstReplyMinutes: 60, revision: 2 });
    await book.startClock(off.id, off.createdAt, { ...policy, active: false });
    const clocks = await book.clocks([on.id, off.id]);
    expect(clocks.size).toBe(1);
    expect(clocks.get(on.id)).toEqual({
      ticketId: on.id,
      targetMinutes: 30,
      startedAt: new Date(on.createdAt).toISOString(),
      dueAt: new Date(Date.parse(on.createdAt) + 30 * 60_000).toISOString(),
      policyRevision: 1,
    });
  });
});

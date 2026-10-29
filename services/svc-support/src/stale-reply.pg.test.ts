import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { PostgresSupportStore } from './store.js';

/**
 * A stale reply on the real tables (SP-tickets-09, J-support-public-10 #8): a trail row someone else wrote after the
 * agent's last read refuses the comment or the status change under the ticket lock, and nothing is written.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_stalereply_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
const USER = '5c0e0e01-1111-4111-8111-111111111111';

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const available = await postgresAvailable(ADMIN_URL);
const admin = available ? postgres(ADMIN_URL, { max: 1, onnotice: () => undefined }) : null;
let sql: postgres.Sql | null = null;
let created = false;

beforeAll(async () => {
  if (!admin) return;
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 4, onnotice: () => undefined });
  await assertTestDatabase(sql, 'svc-support stale-reply.pg.test');
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const f of files) await sql.unsafe(readFileSync(join(migrationsDir, f), 'utf8'));
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (created) await admin?.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});

const OP = '5c0e0e01-3333-4333-8333-333333333333';
const OTHER_OP = '5c0e0e01-4444-4444-8444-444444444444';

describe.skipIf(!available)('stale reply on Postgres', () => {
  const store = () => new PostgresSupportStore(sql!);

  it('refuses with the newer rows and writes no comment; the same reply after them is written once', async () => {
    const t = await store().createTicket({ userId: USER, category: 'account', subject: 'TEST', body: 'TEST' });
    await store().claimTicket({ ticketId: t.id, operatorId: OP });
    const seen = (await store().listEvents(t.id)).at(-1)!.sequence;
    await store().setStatus({ ticketId: t.id, status: 'on_hold', operatorId: OTHER_OP, note: 'TEST' });
    const reply = { ticketId: t.id, authorId: OP, authorRole: 'operator' as const, body: 'TEST answer' };
    const refused = await store().addComment({ ...reply, expectedSequence: seen });
    expect(refused).toMatchObject({ status: 'refuse', reason: 'stale', newer: [{ actorId: OTHER_OP, toStatus: 'on_hold' }] });
    expect(await store().listComments(t.id)).toHaveLength(0);
    const last = (await store().listEvents(t.id)).at(-1)!.sequence;
    expect(await store().addComment({ ...reply, expectedSequence: last })).toMatchObject({ status: 'ok' });
    expect(await store().listComments(t.id)).toHaveLength(1);
  });

  it("the writer's own newer rows do not make it stale", async () => {
    const t = await store().createTicket({ userId: USER, category: 'account', subject: 'TEST', body: 'TEST' });
    const opened = (await store().listEvents(t.id)).at(-1)!.sequence;
    await store().claimTicket({ ticketId: t.id, operatorId: OP });
    const ok = await store().addComment({ ticketId: t.id, authorId: OP, authorRole: 'operator', body: 'TEST', expectedSequence: opened });
    expect(ok).toMatchObject({ status: 'ok' });
  });

  it('a status change naming an older row is refused with the newer rows and changes nothing', async () => {
    const t = await store().createTicket({ userId: USER, category: 'account', subject: 'TEST', body: 'TEST' });
    await store().claimTicket({ ticketId: t.id, operatorId: OP });
    const seen = (await store().listEvents(t.id)).at(-1)!.sequence;
    await store().setStatus({ ticketId: t.id, status: 'on_hold', operatorId: OTHER_OP, note: 'TEST' });
    const before = await store().listEvents(t.id);
    const refused = await store().setStatus({ ticketId: t.id, status: 'resolved', operatorId: OP, expectedSequence: seen });
    expect(refused).toMatchObject({ status: 'refuse', reason: 'stale', newer: [{ actorId: OTHER_OP, toStatus: 'on_hold' }] });
    expect(await store().listEvents(t.id)).toEqual(before);
    expect((await store().findById(t.id))?.status).toBe('on_hold');
  });
});

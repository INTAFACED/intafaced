import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { PostgresSupportStore } from './store.js';

/**
 * Internal notes on the real tables (SP-tickets-05): the customer's page is filtered inside the query before its limit,
 * the table refuses a note by anyone but an operator, a note leaves `updated_at` as it was, and its key is kept apart.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));
const USER = '5c0e0e00-2222-4222-8222-222222222222';
const AGENT = '5c0e0e00-3333-4333-8333-333333333333';

// A per-run database (#6713), so another file's migration replay cannot rewrite the tables under these tests.
const available = await postgresAvailable(ADMIN_URL);
const db: TestDatabase | null = available ? await createTestDatabase({ service: 'support', url: ADMIN_URL, migrations: MIGRATIONS }) : null;
const sql = db?.sql ?? null;
if (sql) await assertTestDatabase(sql, 'svc-support internal-notes.pg.test');

afterAll(async () => {
  await db?.drop();
}, 30_000);

describe.skipIf(!available)('internal notes on Postgres', () => {
  const store = () => new PostgresSupportStore(sql!);
  const open = () => store().createTicket({ userId: USER, category: 'account', subject: 'TEST', body: 'TEST' });
  const key = (n: string) => `pg-note:${Date.now().toString(36)}:${n}`;
  const note = (ticketId: string, body: string, clientRequestId?: string) =>
    store().addComment({
      ticketId,
      authorId: AGENT,
      authorRole: 'operator',
      visibility: 'internal',
      body,
      ...(clientRequestId ? { clientRequestId } : {}),
    });

  it('the customer page leaves notes out before its limit; the desk page keeps them', async () => {
    const t = await open();
    for (const n of [1, 2, 3]) expect((await note(t.id, `TEST note ${n}`)).status).toBe('ok');
    expect((await store().addComment({ ticketId: t.id, authorId: AGENT, authorRole: 'operator', body: 'TEST reply 1' })).status).toBe('ok');
    expect(
      (await store().addComment({ ticketId: t.id, authorId: USER, authorRole: 'user', body: 'TEST reply 2', userCap: 5 })).status,
    ).toBe('ok');
    expect((await store().listComments(t.id, { limit: 2 })).map((c) => c.body)).toEqual(['TEST reply 1', 'TEST reply 2']);
    expect((await store().listComments(t.id)).map((c) => c.visibility)).toEqual(['public', 'public']);
    expect((await store().listComments(t.id, { limit: 10, withInternal: true })).map((c) => [c.body, c.visibility])).toEqual([
      ['TEST note 1', 'internal'],
      ['TEST note 2', 'internal'],
      ['TEST note 3', 'internal'],
      ['TEST reply 1', 'public'],
      ['TEST reply 2', 'public'],
    ]);
  });

  it('the table refuses a note by the customer, and a note leaves updated_at and status as they were', async () => {
    const t = await open();
    await expect(
      sql!`INSERT INTO support.comments (ticket_id, author_id, author_role, visibility, body) VALUES (${t.id}, ${USER}, 'user', 'internal', 'TEST')`,
    ).rejects.toThrow(/comments_visibility_ck/);
    await expect(
      sql!`INSERT INTO support.comments (ticket_id, author_id, author_role, visibility, body) VALUES (${t.id}, ${AGENT}, 'operator', 'secret', 'TEST')`,
    ).rejects.toThrow(/comments_visibility_ck/);
    await sql!`UPDATE support.tickets SET status = 'resolved' WHERE id = ${t.id}`;
    const [before] = await sql!`SELECT status, updated_at, assignee_id FROM support.tickets WHERE id = ${t.id}`;
    const result = await note(t.id, 'TEST note on resolved');
    expect(result).toMatchObject({ status: 'ok', reopened: false, comment: { visibility: 'internal' } });
    const [after] = await sql!`SELECT status, updated_at, assignee_id FROM support.tickets WHERE id = ${t.id}`;
    expect(after).toEqual(before);
  });

  it('a note key is one note under its own receipt; a reply under the same key is another comment', async () => {
    const t = await open();
    const k = key('a');
    const [a, b] = await Promise.all([note(t.id, 'TEST note', k), note(t.id, 'TEST note', k)]);
    expect(a.status === 'ok' && b.status === 'ok').toBe(true);
    if (a.status !== 'ok' || b.status !== 'ok') return;
    expect(b.comment).toEqual(a.comment);
    expect(await note(t.id, 'TEST other', k)).toEqual({ status: 'refuse', reason: 'idempotency_conflict' });
    const reply = await store().addComment({
      ticketId: t.id,
      authorId: AGENT,
      authorRole: 'operator',
      body: 'TEST note',
      clientRequestId: k,
    });
    expect(reply).toMatchObject({ status: 'ok', comment: { visibility: 'public' } });
    const receipts = await sql!`
      SELECT procedure, count(*)::int AS n FROM support.write_receipts WHERE client_request_id = ${k} GROUP BY procedure ORDER BY procedure
    `;
    expect(receipts.map((r) => `${r.procedure}:${r.n}`)).toEqual(['support.comment:1', 'support.note:1']);
    expect(await store().listComments(t.id, { withInternal: true })).toHaveLength(2);
  });
});

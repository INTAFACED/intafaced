import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestEventOutbox, SqlRequestEventBook, type RequestEvent } from './request-events.js';

/**
 * SP-email-01: the outbox rows are written by triggers in the same transaction as the
 * ticket or message row, once per event, with no request text. Per-run database as in
 * rating-request.pg.test.ts.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_reqevents_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

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

async function newTicket(user: string): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO support.tickets (user_id, category, subject, body) VALUES (${user}, 'account', 'secret subject', 'secret body') RETURNING id
  `;
  return t!.id;
}

describe('request event outbox triggers (SP-email-01)', () => {
  it('opening a request writes one opened row in the same statement', async () => {
    const id = await newTicket('u-open');
    const rows = await sql`SELECT event_key, event_name, user_id FROM support.event_outbox WHERE ticket_id = ${id}`;
    expect(rows.map((r) => [r.event_key, r.event_name, r.user_id])).toEqual([
      [`support.ticket.opened:${id}`, 'supportTicketOpened', 'u-open'],
    ]);
  });

  it('each status change writes one updated row; an update that keeps the status writes none', async () => {
    const id = await newTicket('u-status');
    await sql`UPDATE support.tickets SET status = 'pending', updated_at = '2026-10-22T07:00:00Z' WHERE id = ${id}`;
    await sql`UPDATE support.tickets SET status = 'pending', updated_at = '2026-10-22T07:05:00Z' WHERE id = ${id}`;
    await sql`UPDATE support.tickets SET status = 'resolved', updated_at = '2026-10-22T07:10:00Z' WHERE id = ${id}`;
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM support.event_outbox WHERE ticket_id = ${id} AND event_name = 'supportTicketUpdated' ORDER BY occurred_at
    `;
    expect(rows.map((r) => r.status)).toEqual(['pending', 'resolved']);
  });

  it('two changes to the same status in one transaction keep two rows', async () => {
    const id = await newTicket('u-same-tx');
    await sql.begin(async (tx) => {
      await tx`UPDATE support.tickets SET status = 'pending', updated_at = now() WHERE id = ${id}`;
      await tx`UPDATE support.tickets SET status = 'open', updated_at = now() WHERE id = ${id}`;
      await tx`UPDATE support.tickets SET status = 'pending', updated_at = now() WHERE id = ${id}`;
    });
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM support.event_outbox WHERE ticket_id = ${id} AND event_name = 'supportTicketUpdated'
    `;
    expect(rows.map((r) => r.status).sort()).toEqual(['open', 'pending', 'pending']);
  });

  it('a message writes one row keyed by the message, naming the request owner and the author role', async () => {
    const id = await newTicket('u-msg');
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO support.comments (ticket_id, author_id, author_role, body) VALUES (${id}, 'agent-1', 'operator', 'secret reply') RETURNING id
    `;
    const rows = await sql`
      SELECT event_key, user_id, message_id, author_role FROM support.event_outbox WHERE event_name = 'supportMessageCreated' AND ticket_id = ${id}
    `;
    expect(rows.map((r) => [r.event_key, r.user_id, r.message_id, r.author_role])).toEqual([
      [`support.message.created:${c!.id}`, 'u-msg', c!.id, 'operator'],
    ]);
  });

  it('a rolled-back request leaves no outbox row', async () => {
    const before = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM support.event_outbox`;
    await sql
      .begin(async (tx) => {
        await tx`INSERT INTO support.tickets (user_id, category, subject, body) VALUES ('u-rollback', 'account', 's', 'b')`;
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const after = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM support.event_outbox`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('the outbox holds no request or message text', async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'support' AND table_name = 'event_outbox'
    `;
    const names = cols.map((c) => c.column_name);
    for (const banned of ['subject', 'body', 'note']) expect(names).not.toContain(banned);
  });

  it('the sweep publishes each row once and a second sweep publishes nothing', async () => {
    const id = await newTicket('u-sweep');
    await sql`UPDATE support.event_outbox SET published_at = now() WHERE ticket_id <> ${id} AND published_at IS NULL`;
    const sent: RequestEvent[] = [];
    const outbox = new RequestEventOutbox(new SqlRequestEventBook(sql), async () => ({ send: async (e) => void sent.push(e) }));
    expect(await outbox.flush()).toBe(1);
    expect(sent.map((e) => [e.name, e.ticketId, e.userId])).toEqual([['supportTicketOpened', id, 'u-sweep']]);
    expect(await outbox.flush()).toBe(0);
  });

  it('a failed row backs off in Postgres and the rows behind it still publish; a backlog over one page drains in one sweep', async () => {
    await sql`UPDATE support.event_outbox SET published_at = now() WHERE published_at IS NULL`;
    const first = await newTicket('u-poison');
    for (let i = 0; i < 120; i += 1) await newTicket('u-backlog');
    const sent: string[] = [];
    const book = new SqlRequestEventBook(sql);
    const outbox = new RequestEventOutbox(book, async () => ({
      send: async (e) => {
        if (e.ticketId === first) throw new Error('rejected');
        sent.push(e.key);
      },
    }));
    expect(await outbox.flush()).toBe(120);
    expect(sent).toHaveLength(120);
    const [row] = await sql<{ attempts: number; due: boolean; last_error: string; published_at: Date | null }[]>`
      SELECT attempts, next_attempt_at > now() AS due, last_error, published_at FROM support.event_outbox WHERE ticket_id = ${first}
    `;
    expect(row).toMatchObject({ attempts: 1, due: true, last_error: 'rejected', published_at: null });
    expect(await book.pending(10, new Date().toISOString())).toEqual([]);
  });
});

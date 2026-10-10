import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * L1239 — ticket_events and case_files stay after the ticket row is gone.
 * The suite builds its own database from postgres://127.0.0.1:5432/postgres.
 * The name is never intafaced_test.
 */

const ADMIN_URL = 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_l1239_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

if (database === 'intafaced_test' || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let created = false;

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

async function insertTicket(tx: postgres.Sql): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO support.tickets (user_id, category, subject, body)
    VALUES ('l1239-user', 'account', 'audit stays', 'body')
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('ticket insert returned no id');
  return id;
}

async function insertEvent(tx: postgres.Sql, ticketId: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role)
    VALUES (${ticketId}, 1, 'opened', 'l1239-user', 'user')
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('ticket_events insert returned no id');
  return id;
}

async function insertCaseFile(tx: postgres.Sql, ticketId: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO support.case_files (ticket_id, escalated_by, reason, citations, grounding, summary)
    VALUES (
      ${ticketId},
      'l1239-operator',
      'other',
      ${tx.json([{ kind: 'kb_article', ref: 'kb-account-access', digest: 'a'.repeat(64), readAt: '2026-08-09T10:00:00.000Z' }])},
      ${tx.json({ status: 'unread', reason: 'plane_dark' })},
      'Escalating.'
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('case_files insert returned no id');
  return id;
}

/** Drop the foreign key so the ticket can disappear without taking the child row. */
async function withDetachedParent(
  table: 'ticket_events' | 'case_files',
  constraint: string,
  run: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  const sentinel = new Error('rollback-fixture');
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`ALTER TABLE support.${table} DROP CONSTRAINT ${constraint}`);
      await run(tx);
      throw sentinel;
    });
  } catch (err) {
    if (err !== sentinel) throw err;
  }
}

beforeAll(async () => {
  const adminDb = await admin<{ db: string }[]>`SELECT current_database() AS db`;
  if (adminDb[0]?.db !== 'postgres') {
    throw new Error(`admin connection is on ${adminDb[0]?.db ?? '<none>'}, expected postgres`);
  }
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;

  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });

  const live = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  if (live[0]?.db !== database || live[0]?.db === 'intafaced_test') {
    throw new Error(`refusing to migrate ${live[0]?.db ?? '<none>'}`);
  }

  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  const ups = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of ups) {
    await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
  }
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

describe('L1239 audit delete is refused after the ticket is gone', () => {
  it('refuses a ticket_events delete while its ticket still exists', async () => {
    const ticketId = await insertTicket(sql);
    const eventId = await insertEvent(sql, ticketId);
    let code: string | undefined;
    try {
      await sql`DELETE FROM support.ticket_events WHERE id = ${eventId}`;
    } catch (err) {
      code = pgCode(err);
    }
    const left = await sql<{ id: string }[]>`SELECT id FROM support.ticket_events WHERE id = ${eventId}`;
    expect(code).toBe('23514');
    expect(left).toHaveLength(1);
  });

  it('refuses a ticket_events delete after the ticket row is already gone', async () => {
    const ticketId = await insertTicket(sql);
    const eventId = await insertEvent(sql, ticketId);
    await withDetachedParent('ticket_events', 'ticket_events_ticket_id_fkey', async (tx) => {
      await tx`DELETE FROM support.tickets WHERE id = ${ticketId}`;
      const parent = await tx<{ id: string }[]>`SELECT id FROM support.tickets WHERE id = ${ticketId}`;
      expect(parent).toHaveLength(0);
      let code: string | undefined;
      try {
        await tx.savepoint((sp) => sp`DELETE FROM support.ticket_events WHERE id = ${eventId}`);
      } catch (err) {
        code = pgCode(err);
      }
      const left = await tx<{ id: string }[]>`SELECT id FROM support.ticket_events WHERE id = ${eventId}`;
      expect(code, 'old predicate allows the child delete once the ticket is gone').toBe('23514');
      expect(left).toHaveLength(1);
    });
  });

  it('refuses a case_files delete after the ticket row is already gone', async () => {
    const ticketId = await insertTicket(sql);
    const caseId = await insertCaseFile(sql, ticketId);
    await withDetachedParent('case_files', 'case_files_ticket_id_fkey', async (tx) => {
      await tx`DELETE FROM support.tickets WHERE id = ${ticketId}`;
      const parent = await tx<{ id: string }[]>`SELECT id FROM support.tickets WHERE id = ${ticketId}`;
      expect(parent).toHaveLength(0);
      let code: string | undefined;
      try {
        await tx.savepoint((sp) => sp`DELETE FROM support.case_files WHERE id = ${caseId}`);
      } catch (err) {
        code = pgCode(err);
      }
      const left = await tx<{ id: string }[]>`SELECT id FROM support.case_files WHERE id = ${caseId}`;
      expect(code, 'old predicate allows the case file delete once the ticket is gone').toBe('23514');
      expect(left).toHaveLength(1);
    });
  });

  it('a ticket delete does not erase ticket_events or case_files', async () => {
    const ticketId = await insertTicket(sql);
    const eventId = await insertEvent(sql, ticketId);
    const caseId = await insertCaseFile(sql, ticketId);
    let code: string | undefined;
    try {
      await sql`DELETE FROM support.tickets WHERE id = ${ticketId}`;
    } catch (err) {
      code = pgCode(err);
    }
    const events = await sql<{ id: string }[]>`SELECT id FROM support.ticket_events WHERE id = ${eventId}`;
    const cases = await sql<{ id: string }[]>`SELECT id FROM support.case_files WHERE id = ${caseId}`;
    const tickets = await sql<{ id: string }[]>`SELECT id FROM support.tickets WHERE id = ${ticketId}`;
    expect(events, 'ticket delete erased ticket_events').toHaveLength(1);
    expect(cases, 'ticket delete erased case_files').toHaveLength(1);
    expect(tickets).toHaveLength(1);
    expect(code).toBe('23503');

    const rules = await sql<{ relname: string; confdeltype: string }[]>`
      SELECT r.relname, c.confdeltype
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'support'
        AND r.relname IN ('ticket_events', 'case_files')
        AND c.contype = 'f'
    `;
    expect(new Set(rules.map((row) => `${row.relname}:${row.confdeltype}`))).toEqual(
      new Set(['ticket_events:r', 'case_files:r']),
    );
  });
});

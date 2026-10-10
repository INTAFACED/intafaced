import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * L1240 — a status_changed row may name only a ticket status, and the two sides differ.
 * Same per-run database as audit-delete-refused.pg.test.ts. The migrated name
 * ends in _test and is never intafaced_test. The postgres database is admin only.
 */

const ADMIN_URL = 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_l1240_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
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
    VALUES ('l1240-user', 'account', 'status pair', 'body')
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('ticket insert returned no id');
  return id;
}

async function tryEvent(
  ticketId: string,
  sequence: number,
  kind: 'opened' | 'status_changed',
  fromStatus: string | null,
  toStatus: string | null,
): Promise<{ code?: string; id?: string }> {
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role, from_status, to_status)
      VALUES (${ticketId}, ${sequence}, ${kind}, 'l1240-operator', 'operator', ${fromStatus}, ${toStatus})
      RETURNING id
    `;
    return { id: rows[0]?.id };
  } catch (err) {
    return { code: pgCode(err) };
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
  if (live[0]?.db !== database || !live[0]?.db.endsWith('_test') || live[0]?.db === 'intafaced_test') {
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

describe('L1240 status pair is a ticket status on each side', () => {
  it('refuses an empty string on a status_changed row', async () => {
    const ticketId = await insertTicket(sql);
    const fromEmpty = await tryEvent(ticketId, 1, 'status_changed', '', 'pending');
    const toEmpty = await tryEvent(ticketId, 2, 'status_changed', 'open', '');
    const bothEmpty = await tryEvent(ticketId, 3, 'status_changed', '', '');
    const left = await sql<{ sequence: number }[]>`
      SELECT sequence FROM support.ticket_events WHERE ticket_id = ${ticketId} ORDER BY sequence
    `;
    expect(fromEmpty.code).toBe('23514');
    expect(toEmpty.code).toBe('23514');
    expect(bothEmpty.code).toBe('23514');
    expect(fromEmpty.id).toBeUndefined();
    expect(left).toHaveLength(0);
  });

  it('refuses a status the ticket row is not allowed to hold', async () => {
    const ticketId = await insertTicket(sql);
    const badTo = await tryEvent(ticketId, 1, 'status_changed', 'open', 'reopened');
    const badFrom = await tryEvent(ticketId, 2, 'status_changed', 'archived', 'closed');
    const left = await sql<{ id: string }[]>`SELECT id FROM support.ticket_events WHERE ticket_id = ${ticketId}`;
    expect(badTo.code).toBe('23514');
    expect(badFrom.code).toBe('23514');
    expect(left).toHaveLength(0);
  });

  it('refuses a status_changed pair that does not differ', async () => {
    const ticketId = await insertTicket(sql);
    const same = await tryEvent(ticketId, 1, 'status_changed', 'open', 'open');
    const left = await sql<{ id: string }[]>`SELECT id FROM support.ticket_events WHERE ticket_id = ${ticketId}`;
    expect(same.code).toBe('23514');
    expect(left).toHaveLength(0);
  });

  it('refuses a status_changed row whose statuses are null', async () => {
    const ticketId = await insertTicket(sql);
    const missing = await tryEvent(ticketId, 1, 'status_changed', null, null);
    const left = await sql<{ id: string }[]>`SELECT id FROM support.ticket_events WHERE ticket_id = ${ticketId}`;
    expect(missing.code).toBe('23514');
    expect(left).toHaveLength(0);
  });

  it('a non-status_changed row still has both statuses null', async () => {
    const ticketId = await insertTicket(sql);
    const opened = await tryEvent(ticketId, 1, 'opened', null, null);
    const withStatus = await tryEvent(ticketId, 2, 'opened', 'open', null);
    const rows = await sql<{ from_status: string | null; to_status: string | null }[]>`
      SELECT from_status, to_status FROM support.ticket_events WHERE ticket_id = ${ticketId} ORDER BY sequence
    `;
    expect(opened.id).toBeTruthy();
    expect(opened.code).toBeUndefined();
    expect(withStatus.code).toBe('23514');
    expect(rows).toEqual([{ from_status: null, to_status: null }]);
  });

  it('a legal pair such as open to pending still inserts', async () => {
    const ticketId = await insertTicket(sql);
    const pairs: Array<[string, string]> = [
      ['open', 'pending'],
      ['pending', 'resolved'],
      ['resolved', 'closed'],
      ['closed', 'open'],
    ];
    for (const status of TICKET_STATUSES) {
      expect(pairs.some(([fromStatus, toStatus]) => fromStatus === status || toStatus === status)).toBe(true);
    }
    const ids: string[] = [];
    for (const [index, [fromStatus, toStatus]] of pairs.entries()) {
      const inserted = await tryEvent(ticketId, index + 1, 'status_changed', fromStatus, toStatus);
      expect(inserted.code).toBeUndefined();
      if (!inserted.id) throw new Error(`legal pair ${fromStatus} → ${toStatus} did not insert`);
      ids.push(inserted.id);
    }
    const stored = await sql<{ from_status: string; to_status: string }[]>`
      SELECT from_status, to_status
      FROM support.ticket_events
      WHERE ticket_id = ${ticketId}
      ORDER BY sequence
    `;
    expect(stored).toEqual([
      { from_status: 'open', to_status: 'pending' },
      { from_status: 'pending', to_status: 'resolved' },
      { from_status: 'resolved', to_status: 'closed' },
      { from_status: 'closed', to_status: 'open' },
    ]);
    expect(new Set(ids).size).toBe(4);
  });
});

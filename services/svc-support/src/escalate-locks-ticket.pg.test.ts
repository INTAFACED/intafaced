import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupportCaseFile, SupportTicketStatus } from '@intafaced/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSupportStore, type PutCaseFileWithEscalatedResult } from './store.js';

/**
 * L1244 — putCaseFileWithEscalated locks the ticket and refuses a missing or
 * closed row. escalate checks isTerminal on a pre-read, then awaits identity
 * and KB work, so a concurrent setStatus(closed) can commit first. The case
 * file and the escalated trail row are one transaction: either both land or
 * neither does. closed is terminal. resolved is not. No amount column.
 * Same per-run database as kb-version-immutable.pg.test.ts. The migrated name
 * ends in _test and is never intafaced_test.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_l1244_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const MISSING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let databaseUrl = '';
let created = false;

function caseFile(ticketId: string): SupportCaseFile {
  return {
    ticketId,
    escalatedBy: OP,
    reason: 'other',
    citations: [
      {
        kind: 'kb_article',
        ref: 'kb-account-access',
        digest: 'a'.repeat(64),
        readAt: '2026-08-09T10:00:00.000Z',
      },
    ],
    grounding: { status: 'unread', reason: 'plane_dark' },
    summary: 'Escalating.',
    createdAt: '2026-08-09T10:00:00.000Z',
  };
}

async function counts(ticketId: string): Promise<{ cases: number; escalated: number }> {
  const cases = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM support.case_files WHERE ticket_id = ${ticketId}
  `;
  const escalated = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM support.ticket_events
    WHERE ticket_id = ${ticketId} AND kind = 'escalated'
  `;
  return { cases: Number(cases[0]?.n ?? 0), escalated: Number(escalated[0]?.n ?? 0) };
}

async function openTicket(status: SupportTicketStatus): Promise<string> {
  const store = new PostgresSupportStore(sql);
  const ticket = await store.createTicket({ userId: USER, category: 'account', subject: 'S', body: 'B' });
  if (status !== 'open') {
    const moved = await store.setStatus({ ticketId: ticket.id, status, operatorId: OP });
    expect(moved.status, status).toBe('ok');
  }
  return ticket.id;
}

function escalate(ticketId: string): Promise<PutCaseFileWithEscalatedResult> {
  return new PostgresSupportStore(sql).putCaseFileWithEscalated({
    caseFile: caseFile(ticketId),
    actorId: OP,
    note: 'reason:other citations:1',
  });
}

/** True once some session in this database is waiting on a lock. */
async function seesLockWait(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
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
  databaseUrl = url.toString();
  sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined });

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

describe('L1244 escalate locks the ticket', () => {
  it('refuses a missing ticket and writes no case file and no escalated event', async () => {
    const live = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    expect(live[0]?.db).toBe(database);

    let thrown: unknown;
    let result: PutCaseFileWithEscalatedResult | undefined;
    try {
      result = await escalate(MISSING);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'missing ticket threw instead of refusing').toBeUndefined();
    expect(result).toEqual({ status: 'refuse', reason: 'not_found' });
    expect(await counts(MISSING)).toEqual({ cases: 0, escalated: 0 });
  });

  it('refuses a closed ticket and writes no case file and no escalated event', async () => {
    const ticketId = await openTicket('closed');
    let thrown: unknown;
    let result: PutCaseFileWithEscalatedResult | undefined;
    try {
      result = await escalate(ticketId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'closed ticket threw instead of refusing').toBeUndefined();
    expect(result).toEqual({ status: 'refuse', reason: 'terminal' });
    expect(await counts(ticketId)).toEqual({ cases: 0, escalated: 0 });
    const status = await sql<{ status: string }[]>`SELECT status FROM support.tickets WHERE id = ${ticketId}`;
    expect(status[0]?.status).toBe('closed');
  });

  it('writes the case file and the escalated event for open, pending, and resolved', async () => {
    for (const status of ['open', 'pending', 'resolved'] as const) {
      const ticketId = await openTicket(status);
      const result = await escalate(ticketId);
      expect(result, status).toMatchObject({
        status: 'ok',
        caseFile: { ticketId, escalatedBy: OP, reason: 'other', summary: 'Escalating.' },
      });
      if (result.status !== 'ok') return;
      expect(result.caseFile, status).not.toHaveProperty('amount');
      expect(await counts(ticketId), status).toEqual({ cases: 1, escalated: 1 });
      const live = await sql<{ status: string }[]>`SELECT status FROM support.tickets WHERE id = ${ticketId}`;
      expect(live[0]?.status, status).toBe(status);
    }
    const amount = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'support' AND table_name = 'case_files' AND column_name = 'amount'
    `;
    expect(amount).toHaveLength(0);
  });

  it('refuses when a close commits while the escalate transaction is waiting on the ticket', async () => {
    const ticketId = await openTicket('open');
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    let allowClose = (): void => undefined;
    const closeGate = new Promise<void>((resolve) => {
      allowClose = resolve;
    });
    let markLocked = (): void => undefined;
    const lockHeld = new Promise<void>((resolve) => {
      markLocked = resolve;
    });

    const closing = holder.begin(async (tx) => {
      await tx`SELECT status FROM support.tickets WHERE id = ${ticketId} FOR UPDATE`;
      markLocked();
      await closeGate;
      await tx`
        UPDATE support.tickets
        SET status = 'closed', updated_at = now()
        WHERE id = ${ticketId}
      `;
    });

    let result: PutCaseFileWithEscalatedResult | undefined;
    let thrown: unknown;
    try {
      await lockHeld;
      const escalating = escalate(ticketId);
      const sawWait = await seesLockWait(5_000);
      allowClose();
      try {
        result = await escalating;
      } catch (err) {
        thrown = err;
      }
      await closing;
      expect(sawWait, 'escalate did not wait on the ticket lock').toBe(true);
      expect(thrown, 'raced close threw instead of refusing').toBeUndefined();
      expect(result).toEqual({ status: 'refuse', reason: 'terminal' });
      expect(await counts(ticketId)).toEqual({ cases: 0, escalated: 0 });
      const status = await sql<{ status: string }[]>`SELECT status FROM support.tickets WHERE id = ${ticketId}`;
      expect(status[0]?.status).toBe('closed');
    } finally {
      allowClose();
      await closing.catch(() => undefined);
      await holder.end({ timeout: 5 });
    }
  });
});

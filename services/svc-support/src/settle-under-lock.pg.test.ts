import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupportCaseFile, SupportEscalationReason, SupportTicketCategory, SupportTicketStatus } from '@intafaced/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSupportStore, type SetStatusResult } from './store.js';

/**
 * L1245 — setStatus rechecks settlement under the ticket lock.
 *
 * The service used to read latestCaseFile before store.setStatus. The store
 * locked the ticket and checked the lifecycle only. A later technical file
 * hid an earlier money_request, and a money_request that committed between
 * that pre-read and the locked update was invisible. The locked re-read of
 * the ticket and every case-file reason is the authority. latestCaseFile is
 * not. deposit_withdraw to resolved still refuses from the category. A closed
 * deposit_withdraw with no payout claim can close. No ledger row, no amount.
 * Same per-run database shape as escalate-locks-ticket.pg.test.ts. The
 * migrated name ends in _test and is never intafaced_test.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_l1245_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let databaseUrl = '';
let created = false;

function caseFile(ticketId: string, reason: SupportEscalationReason): SupportCaseFile {
  return {
    ticketId,
    escalatedBy: OP,
    reason,
    citations: [
      {
        kind: 'kb_article',
        ref: 'kb-account-access',
        digest: 'a'.repeat(64),
        readAt: '2026-08-09T10:00:00.000Z',
      },
    ],
    grounding: { status: 'unread', reason: 'plane_dark' },
    summary: `Escalating ${reason}.`,
    createdAt: '2026-08-09T10:00:00.000Z',
  };
}

async function openTicket(category: SupportTicketCategory): Promise<string> {
  const ticket = await new PostgresSupportStore(sql).createTicket({
    userId: USER,
    category,
    subject: 'S',
    body: 'B',
  });
  return ticket.id;
}

function escalate(ticketId: string, reason: SupportEscalationReason) {
  return new PostgresSupportStore(sql).putCaseFileWithEscalated({
    caseFile: caseFile(ticketId, reason),
    actorId: OP,
    note: `reason:${reason} citations:1`,
  });
}

function setStatus(ticketId: string, status: SupportTicketStatus, note?: string): Promise<SetStatusResult> {
  return new PostgresSupportStore(sql).setStatus({
    ticketId,
    status,
    operatorId: OP,
    note: note ?? null,
  });
}

async function ticketStatus(ticketId: string): Promise<string | undefined> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM support.tickets WHERE id = ${ticketId}`;
  return rows[0]?.status;
}

async function statusChanges(ticketId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM support.ticket_events
    WHERE ticket_id = ${ticketId} AND kind = 'status_changed'
  `;
  return Number(rows[0]?.n ?? 0);
}

async function reasons(ticketId: string): Promise<string[]> {
  const rows = await sql<{ reason: string }[]>`
    SELECT reason FROM support.case_files
    WHERE ticket_id = ${ticketId}
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map((row) => row.reason);
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

describe('L1245 setStatus rechecks settlement under the ticket lock', () => {
  it('refuses resolved and closed after money_request even when a later file is technical', async () => {
    const live = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    expect(live[0]?.db).toBe(database);
    expect(live[0]?.db).not.toBe('intafaced_test');

    for (const status of ['resolved', 'closed'] as const) {
      const ticketId = await openTicket('account');
      expect((await escalate(ticketId, 'money_request')).status, status).toBe('ok');
      expect((await escalate(ticketId, 'technical')).status, status).toBe('ok');
      expect(await reasons(ticketId), status).toEqual(['money_request', 'technical']);
      const latest = await new PostgresSupportStore(sql).latestCaseFile(ticketId);
      expect(latest?.reason, status).toBe('technical');
      expect(latest, status).not.toHaveProperty('amount');

      let thrown: unknown;
      let result: SetStatusResult | undefined;
      try {
        result = await setStatus(ticketId, status);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, status).toBeUndefined();
      expect(result, status).toEqual({ status: 'refuse', reason: 'settle' });
      expect(await ticketStatus(ticketId), status).toBe('open');
      expect(await statusChanges(ticketId), status).toBe(0);
    }

    const amount = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'support' AND table_name = 'case_files' AND column_name = 'amount'
    `;
    expect(amount).toHaveLength(0);
    const ledger = await sql<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace WHERE nspname = 'ledger'
    `;
    expect(ledger).toHaveLength(0);
  });

  it('refuses resolving a deposit_withdraw ticket from the category and writes no trail', async () => {
    const ticketId = await openTicket('deposit_withdraw');
    let thrown: unknown;
    let result: SetStatusResult | undefined;
    try {
      result = await setStatus(ticketId, 'resolved');
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'deposit_withdraw resolve threw instead of refusing').toBeUndefined();
    expect(result).toEqual({ status: 'refuse', reason: 'settle' });
    expect(await ticketStatus(ticketId)).toBe('open');
    expect(await statusChanges(ticketId)).toBe(0);
    expect(await reasons(ticketId)).toEqual([]);
  });

  it('closes a deposit_withdraw ticket that has no payout claim', async () => {
    const ticketId = await openTicket('deposit_withdraw');
    const result = await setStatus(ticketId, 'closed', 'cited kb-deposit-withdraw-honest');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.ticket.status).toBe('closed');
    expect(result.ticket).not.toHaveProperty('amount');
    expect(await ticketStatus(ticketId)).toBe('closed');
    expect(await statusChanges(ticketId)).toBe(1);
  });

  it('refuses a resolve or close whose note claims the money moved', async () => {
    for (const status of ['resolved', 'closed'] as const) {
      const ticketId = await openTicket('other');
      let thrown: unknown;
      let result: SetStatusResult | undefined;
      try {
        result = await setStatus(ticketId, status, 'refunded via pay');
      } catch (err) {
        thrown = err;
      }
      expect(thrown, status).toBeUndefined();
      expect(result, status).toEqual({ status: 'refuse', reason: 'settle' });
      expect(await ticketStatus(ticketId), status).toBe('open');
      expect(await statusChanges(ticketId), status).toBe(0);
    }
  });

  it('still resolves an account ticket whose only case file is technical', async () => {
    const ticketId = await openTicket('account');
    expect((await escalate(ticketId, 'technical')).status).toBe('ok');
    const result = await setStatus(ticketId, 'resolved');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.ticket.status).toBe('resolved');
    expect(await statusChanges(ticketId)).toBe(1);
  });

  it('refuses resolve when a money_request case file commits while setStatus waits on the ticket', async () => {
    const ticketId = await openTicket('account');
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    let allow = (): void => undefined;
    const release = new Promise<void>((resolve) => {
      allow = resolve;
    });
    let markLocked = (): void => undefined;
    const lockHeld = new Promise<void>((resolve) => {
      markLocked = resolve;
    });

    // FOR SHARE blocks setStatus's FOR UPDATE, and it does not block the
    // case-file insert's FOR KEY SHARE on the parent ticket. FOR UPDATE here
    // would deadlock that insert, so the file could not commit during the wait.
    const holding = holder.begin(async (tx) => {
      await tx`SELECT status FROM support.tickets WHERE id = ${ticketId} FOR SHARE`;
      markLocked();
      await release;
    });

    let moving: Promise<SetStatusResult> | undefined;
    try {
      await lockHeld;
      moving = setStatus(ticketId, 'resolved');
      const sawWait = await seesLockWait(5_000);
      const filed = await new PostgresSupportStore(sql).putCaseFile(caseFile(ticketId, 'money_request'));
      expect(filed.reason).toBe('money_request');
      expect(filed).not.toHaveProperty('amount');
      allow();
      let thrown: unknown;
      let result: SetStatusResult | undefined;
      try {
        result = await moving;
      } catch (err) {
        thrown = err;
      }
      await holding;
      expect(sawWait, 'setStatus did not wait on the ticket lock').toBe(true);
      expect(thrown, 'raced money_request threw instead of refusing').toBeUndefined();
      expect(result).toEqual({ status: 'refuse', reason: 'settle' });
      expect(await ticketStatus(ticketId)).toBe('open');
      expect(await statusChanges(ticketId)).toBe(0);
      expect(await reasons(ticketId)).toEqual(['money_request']);
    } finally {
      allow();
      await moving?.catch(() => undefined);
      await holding.catch(() => undefined);
      await holder.end({ timeout: 5 });
    }
  }, 15_000);
});

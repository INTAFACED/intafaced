import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * L1241 — a citation is an object with non-blank kind, ref, digest, and readAt.
 * grounding matches supportAccountGroundingSchema (accountStateSchema when read,
 * or an explicit unread record). Same per-run database as status-pair-enum.pg.test.ts.
 * The migrated name ends in _test and is never intafaced_test.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_l1241_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
const READ_AT = '2026-08-09T10:00:00.000Z';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const citation = {
  kind: 'kb_article',
  ref: 'kb-account-access',
  digest: DIGEST_A,
  readAt: READ_AT,
};

const readGrounding = {
  status: 'read',
  state: { userId: USER_ID, status: 'frozen', kycTier: 'basic' },
  readAt: READ_AT,
};

const unreadGrounding = { status: 'unread', reason: 'plane_dark' };

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
    VALUES ('l1241-user', 'account', 'citation shape', 'body')
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('ticket insert returned no id');
  return id;
}

async function tryCaseFile(ticketId: string, citations: unknown, grounding: unknown): Promise<{ code?: string; id?: string }> {
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO support.case_files (ticket_id, escalated_by, reason, citations, grounding, summary)
      VALUES (
        ${ticketId},
        'l1241-operator',
        'other',
        ${sql.json(citations as never)},
        ${sql.json(grounding as never)},
        'Escalating.'
      )
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

describe('L1241 citation shape and grounding', () => {
  it('refuses an array of empty citation objects', async () => {
    const ticketId = await insertTicket(sql);
    const emptyObject = await tryCaseFile(ticketId, [{}], unreadGrounding);
    const nullElement = await tryCaseFile(ticketId, [null], unreadGrounding);
    const left = await sql<{ id: string }[]>`SELECT id FROM support.case_files WHERE ticket_id = ${ticketId}`;
    expect(emptyObject.code).toBe('23514');
    expect(nullElement.code).toBe('23514');
    expect(emptyObject.id).toBeUndefined();
    expect(left).toHaveLength(0);
  });

  it('refuses a citation whose kind, ref, digest, or readAt is blank', async () => {
    const ticketId = await insertTicket(sql);
    const blankRef = await tryCaseFile(ticketId, [{ ...citation, ref: '' }], unreadGrounding);
    const whitespaceRef = await tryCaseFile(ticketId, [{ ...citation, ref: '   ' }], unreadGrounding);
    const blankKind = await tryCaseFile(ticketId, [{ ...citation, kind: '' }], unreadGrounding);
    const blankDigest = await tryCaseFile(ticketId, [{ ...citation, digest: '' }], unreadGrounding);
    const blankReadAt = await tryCaseFile(ticketId, [{ ...citation, readAt: '' }], unreadGrounding);
    const left = await sql<{ id: string }[]>`SELECT id FROM support.case_files WHERE ticket_id = ${ticketId}`;
    expect(blankRef.code).toBe('23514');
    expect(whitespaceRef.code).toBe('23514');
    expect(blankKind.code).toBe('23514');
    expect(blankDigest.code).toBe('23514');
    expect(blankReadAt.code).toBe('23514');
    expect(left).toHaveLength(0);
  });

  it('refuses a blank grounding status and a state outside accountStateSchema', async () => {
    const ticketId = await insertTicket(sql);
    const blankStatus = await tryCaseFile(ticketId, [citation], { status: '' });
    const whitespaceStatus = await tryCaseFile(ticketId, [citation], { status: '   ' });
    const blankAccountStatus = await tryCaseFile(ticketId, [citation], {
      status: 'read',
      state: { userId: USER_ID, status: '', kycTier: 'basic' },
      readAt: READ_AT,
    });
    const inventedTier = await tryCaseFile(ticketId, [citation], {
      status: 'read',
      state: { userId: USER_ID, status: 'frozen', kycTier: 'gold' },
      readAt: READ_AT,
    });
    const left = await sql<{ id: string }[]>`SELECT id FROM support.case_files WHERE ticket_id = ${ticketId}`;
    expect(blankStatus.code).toBe('23514');
    expect(whitespaceStatus.code).toBe('23514');
    expect(blankAccountStatus.code).toBe('23514');
    expect(inventedTier.code).toBe('23514');
    expect(left).toHaveLength(0);
  });

  it('a well-formed citation and a well-formed grounding still insert', async () => {
    const ticketId = await insertTicket(sql);
    const citations = [
      citation,
      { kind: 'account_state', ref: USER_ID, digest: DIGEST_B, readAt: READ_AT },
      { kind: 'ticket_comment', ref: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', digest: DIGEST_A, readAt: READ_AT },
    ];
    const read = await tryCaseFile(ticketId, citations, readGrounding);
    const unread = await tryCaseFile(ticketId, [citation], { status: 'unread', reason: 'not_attempted' });
    const planeDark = await tryCaseFile(ticketId, [citation], unreadGrounding);
    const stored = await sql<{ id: string; citations: unknown; grounding: unknown }[]>`
      SELECT id, citations, grounding FROM support.case_files WHERE ticket_id = ${ticketId}
    `;
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'support' AND table_name = 'case_files'
    `;
    expect(read.code).toBeUndefined();
    expect(unread.code).toBeUndefined();
    expect(planeDark.code).toBeUndefined();
    expect(read.id).toBeTruthy();
    expect(unread.id).toBeTruthy();
    expect(planeDark.id).toBeTruthy();
    expect(stored).toHaveLength(3);
    expect(stored.find((row) => row.id === read.id)).toMatchObject({ citations, grounding: readGrounding });
    expect(stored.find((row) => row.id === unread.id)).toMatchObject({
      citations: [citation],
      grounding: { status: 'unread', reason: 'not_attempted' },
    });
    expect(stored.find((row) => row.id === planeDark.id)).toMatchObject({
      citations: [citation],
      grounding: unreadGrounding,
    });
    expect(columns.map((column) => column.column_name)).not.toContain('amount');
  });
});

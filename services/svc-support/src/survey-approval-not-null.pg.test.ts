import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupportSurveyConfig } from '@intafaced/contracts';
import { SqlSurveyBook, type SurveyBook } from './survey-settings.js';

/** SP-csat-02 Security row :58: the audit log refuses a row without an approver or approval id (NOT NULL), and an approver equal to the actor. */
const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_survey_nullapr_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
if (!database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) throw new Error(`refusing ${database}`);

const AT = '2026-10-22T04:00:00.000Z';
const APPROVAL = { approvedBy: 'founder', approvalId: 'apr-test' };
const config = {
  scale: { min: 1, max: 5, labels: [] },
  followUp: null,
  sendAfterMinutes: 60,
  channels: ['in_app'],
  requestTypes: ['question'],
} as SupportSurveyConfig;

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let created = false;
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 4, onnotice: () => undefined });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  for (const f of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort())
    await sql.unsafe(readFileSync(join(migrationsDir, f), 'utf8'));
});
afterAll(async () => {
  await sql?.end();
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
});

describe('survey_log approval columns (PG)', () => {
  it('refuses a NULL approver, a NULL approval id, and approver = actor; accepts a full row', async () => {
    const book: SurveyBook = new SqlSurveyBook(sql, undefined, 3);
    const s = await book.configure({ surveyId: null, expectedRevision: 0, config, reason: 'r', by: 'lead', approval: APPROVAL, at: AT });
    const insert = (key: string, approvedBy: string | null, approvalId: string | null) =>
      sql`INSERT INTO support.survey_log (key, survey_id, revision_after, config, set_by, reason, approved_by, approval_id, set_at)
        VALUES (${key}, ${s.surveyId}, 9, '{}', 'lead', 'r', ${approvedBy}, ${approvalId}, ${AT})`;
    await expect(insert('k-null-approver', null, 'apr-1')).rejects.toThrow(/not-null|null value/i);
    await expect(insert('k-null-approval', 'founder', null)).rejects.toThrow(/not-null|null value/i);
    await expect(insert('k-self', 'lead', 'apr-1')).rejects.toThrow(/check/i);
    await expect(insert('k-blank', '', 'apr-1')).rejects.toThrow(/check/i);
    await insert('k-ok', 'founder', 'apr-1');
    const rows = await sql`SELECT approved_by, approval_id FROM support.survey_log ORDER BY key`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { approved_by: 'founder', approval_id: 'apr-1' },
      { approved_by: 'founder', approval_id: 'apr-test' },
    ]);
  });
});

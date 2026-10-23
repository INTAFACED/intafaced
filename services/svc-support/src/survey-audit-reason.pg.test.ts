import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupportSurveyConfig } from '@intafaced/contracts';
import { SqlSurveyBook, type SurveyBook } from './survey-settings.js';

/** SP-csat-02 Security row: every configure writes an append-only audit row carrying the operator reason. */
const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_survey_audit_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
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

describe('survey audit reason (PG)', () => {
  it('logs the reason and actor for create and change, and refuses edits to the log', async () => {
    const book: SurveyBook = new SqlSurveyBook(sql, undefined, 3);
    const first = await book.configure({
      surveyId: null,
      expectedRevision: 0,
      config,
      reason: 'launch csat',
      by: 'lead-a',
      approval: APPROVAL,
      at: AT,
    });
    await book.configure({
      surveyId: first.surveyId,
      expectedRevision: 1,
      config: { ...config, sendAfterMinutes: 30 },
      reason: 'faster send',
      by: 'lead-b',
      approval: APPROVAL,
      at: AT,
    });
    const rows = await sql<{ revision_after: number; set_by: string; reason: string }[]>`
      SELECT revision_after, set_by, reason FROM support.survey_log WHERE survey_id = ${first.surveyId} ORDER BY revision_after`;
    expect(rows).toEqual([
      { revision_after: 1, set_by: 'lead-a', reason: 'launch csat' },
      { revision_after: 2, set_by: 'lead-b', reason: 'faster send' },
    ]);
    await expect(sql`UPDATE support.survey_log SET reason = 'x' WHERE survey_id = ${first.surveyId}`).rejects.toThrow(/append-only/);
    await expect(sql`INSERT INTO support.survey_log (key, survey_id, revision_after, config, set_by, reason, set_at)
      VALUES ('k', ${first.surveyId}, 9, '{}', 'x', '', ${AT})`).rejects.toThrow();
  });
});

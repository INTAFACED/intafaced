import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupportSurveyConfig } from '@intafaced/contracts';
import { MemorySurveyBook, SqlSurveyBook, SurveyIdConflictError, type SurveyBook } from './survey-settings.js';

/** SP-csat-02 r2 #1: a create under a client-chosen id replays on the same config and refuses a different one. */
const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_survey_newid_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
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
  await sql?.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

const books: [string, string, () => SurveyBook][] = [
  ['memory', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', () => new MemorySurveyBook(undefined, 3)],
  ['postgres', 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', () => new SqlSurveyBook(sql, undefined, 3)],
];

describe.each(books)('survey create under a client id (%s)', (_kind, newSurveyId, make) => {
  it('uses the id, replays the same config without a second survey, and refuses a different config', async () => {
    const book = make();
    const create = { surveyId: null, newSurveyId, expectedRevision: 0, config, reason: 'r', by: 'lead', approval: APPROVAL, at: AT };
    const first = await book.configure(create);
    expect(first).toMatchObject({ surveyId: newSurveyId, revision: 1, active: true, config });

    const replay = await book.configure({ ...create, at: '2026-10-22T05:00:00.000Z' });
    expect(replay).toEqual(first);
    expect((await book.list()).surveys).toHaveLength(1);

    await expect(book.configure({ ...create, config: { ...config, sendAfterMinutes: 5 } })).rejects.toBeInstanceOf(SurveyIdConflictError);
    const after = await book.list();
    expect(after.surveys).toHaveLength(1);
    expect(after.surveys[0]).toMatchObject({ surveyId: newSurveyId, revision: 1, config });
  });
});

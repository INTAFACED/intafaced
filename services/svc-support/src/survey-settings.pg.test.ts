import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SUPPORT_SURVEY_CAP_REACHED,
  SUPPORT_SURVEY_CAP_UNSET,
  supportSurveyListSchema,
  type SupportSurveyConfig,
} from '@intafaced/contracts';
import {
  MemorySurveyBook,
  SqlSurveyBook,
  SurveyCapError,
  SurveyNotFoundError,
  SurveyStaleError,
  type SurveyBook,
} from './survey-settings.js';

/** SP-csat-02 — survey configuration books, memory and Postgres, against the same failure branches. */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_survey_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) throw new Error(`refusing ${database}`);

const AT = '2026-10-22T04:00:00.000Z';
const APPROVAL = { approvedBy: 'founder', approvalId: 'apr-test' };
const config: SupportSurveyConfig = {
  scale: { min: 1, max: 5, labels: [] },
  followUp: { question: 'What went wrong?', askAtOrBelow: 2 },
  sendAfterMinutes: 60,
  channels: ['in_app'],
  requestTypes: ['question'],
} as SupportSurveyConfig;
const ids = (prefix: string) => {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(12, '0')}`;
};

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let created = false;
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 8, onnotice: () => undefined });
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

const books: [string, (prefix: string, cap?: number | null) => SurveyBook][] = [
  ['memory', (p, cap = 3) => new MemorySurveyBook(ids(p), cap)],
  ['postgres', (p, cap = 3) => new SqlSurveyBook(sql, ids(p), cap)],
];

describe.each(books)('survey book (%s)', (kind, make) => {
  const prefix = kind === 'memory' ? 'aaaaaaaa-aaaa-4aaa-8aaa-' : 'bbbbbbbb-bbbb-4bbb-8bbb-';
  it('lists the cap unset with its code, configures, keeps one survey active, replays and refuses stale/unknown', async () => {
    const book = make(prefix);
    expect((await book.list()).cap).toEqual({ status: 'set', cap: 3 });

    const first = await book.configure({
      surveyId: null,
      expectedRevision: 0,
      config,
      reason: 'r',
      by: 'lead',
      approval: APPROVAL,
      at: AT,
    });
    expect(first).toMatchObject({ revision: 1, active: true, config });

    const changed = { ...config, sendAfterMinutes: 120 };
    const second = await book.configure({
      surveyId: first.surveyId,
      expectedRevision: 1,
      config: changed,
      reason: 'r',
      by: 'lead',
      approval: APPROVAL,
      at: AT,
    });
    expect(second.revision).toBe(2);
    // Lost reply replays the stored survey.
    expect(
      await book.configure({
        surveyId: first.surveyId,
        expectedRevision: 1,
        config: changed,
        reason: 'r',
        by: 'lead',
        approval: APPROVAL,
        at: AT,
      }),
    ).toMatchObject({
      revision: 2,
    });
    // Stale revision with a different config is refused.
    await expect(
      book.configure({ surveyId: first.surveyId, expectedRevision: 1, config, reason: 'r', by: 'lead', approval: APPROVAL, at: AT }),
    ).rejects.toBeInstanceOf(SurveyStaleError);
    // New survey must start at revision 0.
    await expect(
      book.configure({ surveyId: null, expectedRevision: 3, config, reason: 'r', by: 'lead', approval: APPROVAL, at: AT }),
    ).rejects.toBeInstanceOf(SurveyStaleError);
    // Unknown survey.
    await expect(
      book.configure({
        surveyId: '99999999-9999-4999-8999-999999999999',
        expectedRevision: 0,
        config,
        reason: 'r',
        by: 'lead',
        approval: APPROVAL,
        at: AT,
      }),
    ).rejects.toBeInstanceOf(SurveyNotFoundError);

    const other = await book.configure({
      surveyId: null,
      expectedRevision: 0,
      config,
      reason: 'r',
      by: 'lead',
      approval: APPROVAL,
      at: '2026-10-22T04:01:00.000Z',
    });
    const list = await book.list();
    expect(supportSurveyListSchema.parse(list)).toEqual(list);
    expect(list.surveys.filter((s) => s.active).map((s) => s.surveyId)).toEqual([other.surveyId]);
    expect(list.surveys).toHaveLength(2);
  });
});

describe.each(books)('survey cap (%s)', (kind, make) => {
  const p = kind === 'memory' ? 'cccccccc-cccc-4ccc-8ccc-' : 'dddddddd-dddd-4ddd-8ddd-';
  it('a blank cap lists unset and refuses a second survey with support.survey_cap_unset; editing stays allowed', async () => {
    if (kind === 'postgres') await sql`TRUNCATE support.surveys`;
    const book = make(p, null);
    expect((await book.list()).cap).toEqual({ status: 'unset', code: SUPPORT_SURVEY_CAP_UNSET });
    const first = await book.configure({
      surveyId: null,
      expectedRevision: 0,
      config,
      reason: 'r',
      by: 'lead',
      approval: APPROVAL,
      at: AT,
    });
    await expect(
      book.configure({ surveyId: null, expectedRevision: 0, config, reason: 'r', by: 'lead', approval: APPROVAL, at: AT }),
    ).rejects.toMatchObject({
      code: SUPPORT_SURVEY_CAP_UNSET,
    });
    expect(
      await book.configure({ surveyId: first.surveyId, expectedRevision: 1, config, reason: 'r', by: 'lead', approval: APPROVAL, at: AT }),
    ).toMatchObject({
      revision: 2,
    });
  });
  it('under the cap succeeds; at the cap a new survey refuses with support.survey_cap_reached', async () => {
    if (kind === 'postgres') await sql`TRUNCATE support.surveys`;
    const book = make(p.replace(/^./, 'e'), 2);
    await book.configure({ surveyId: null, expectedRevision: 0, config, reason: 'r', by: 'lead', approval: APPROVAL, at: AT });
    const second = await book.configure({
      surveyId: null,
      expectedRevision: 0,
      config,
      reason: 'r',
      by: 'lead',
      approval: APPROVAL,
      at: AT,
    });
    expect(second.active).toBe(true);
    const err = await book
      .configure({ surveyId: null, expectedRevision: 0, config, reason: 'r', by: 'lead', approval: APPROVAL, at: AT })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SurveyCapError);
    expect((err as SurveyCapError).code).toBe(SUPPORT_SURVEY_CAP_REACHED);
    expect((await book.list()).surveys).toHaveLength(2);
  });
});

describe('survey tables (postgres)', () => {
  it('the log is append-only and two active surveys are refused by the index', async () => {
    await expect(sql`DELETE FROM support.survey_log`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE support.surveys SET active = true`).rejects.toThrow();
  });
});

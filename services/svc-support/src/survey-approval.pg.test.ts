import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context, SupportSurveyConfig, SupportSurveyConfigureInput } from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { FakeIdentityApprovals, FOUNDER } from './survey-approval.fixture.js';
import { SURVEY_CONFIGURE_ACTION, surveyConfigurePayloadHash } from './survey-router.js';
import { SqlSurveyBook } from './survey-settings.js';

/** SP-csat-02 Security row :58 on Postgres: founder approval consumed, audit row with reason and approver; refusals write nothing. */
const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_survey_approval_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
if (!database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) throw new Error(`refusing ${database}`);
const AT = '2026-10-22T04:00:00.000Z';
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

const authConfig = {
  secret: 'a-support-survey-approval-pg-test-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';

async function door() {
  const staff = new MemoryStaffBook();
  await staff.appoint({ userId: LEAD, role: 'lead', by: LEAD, at: AT });
  const support = new SupportService(new MemorySupportStore(), undefined, undefined, staff);
  const identity = new FakeIdentityApprovals();
  const router = createSupportRouter(
    support,
    undefined,
    undefined,
    support,
    undefined,
    undefined,
    new SqlSurveyBook(sql, undefined, 5),
    identity,
  );
  const { token } = await issueAccessToken(
    { userId: LEAD, sessionId: '66666666-6666-4666-8666-666666666666', scopes: ['support:ops'], tier: 'none', mfa: true },
    authConfig,
  );
  const ctx: Context = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-apr' };
  return { identity, lead: router.createCaller(ctx) };
}

describe('configureSurvey founder approval (PG)', () => {
  it('refuses without, with a wrong target, with self and reused approvals; a founder approval writes the audit row', async () => {
    const { identity, lead } = await door();
    const input: SupportSurveyConfigureInput = { surveyId: null, expectedRevision: 0, config, reason: 'Launch CSAT' };
    const hash = surveyConfigurePayloadHash(input);
    await expect(lead.configureSurvey(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const wrong = identity.issue({ requesterId: LEAD, approverId: FOUNDER, targetId: 'support.other', payloadHash: hash });
    await expect(lead.configureSurvey({ ...input, ...wrong })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const self = identity.issue({ requesterId: LEAD, approverId: LEAD, targetId: SURVEY_CONFIGURE_ACTION, payloadHash: hash });
    await expect(lead.configureSurvey({ ...input, ...self })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await sql`SELECT count(*)::int AS n FROM support.survey_log`)[0]!.n).toBe(0);

    const ok = identity.issue({ requesterId: LEAD, approverId: FOUNDER, targetId: SURVEY_CONFIGURE_ACTION, payloadHash: hash });
    const s = await lead.configureSurvey({ ...input, ...ok });
    await expect(lead.configureSurvey({ ...input, surveyId: s.surveyId, expectedRevision: 1, ...ok })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    const rows = await sql`SELECT revision_after, set_by, reason, approved_by, approval_id FROM support.survey_log`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { revision_after: 1, set_by: LEAD, reason: 'Launch CSAT', approved_by: FOUNDER, approval_id: ok.approvalId },
    ]);
    await expect(sql`INSERT INTO support.survey_log (key, survey_id, revision_after, config, set_by, reason, approved_by, approval_id, set_at)
      VALUES ('k-self', ${s.surveyId}, 9, '{}', ${LEAD}, 'r', ${LEAD}, 'apr-x', ${AT})`).rejects.toThrow(/check/i);
  });
});

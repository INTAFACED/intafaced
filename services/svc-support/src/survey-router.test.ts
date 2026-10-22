import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { SUPPORT_SURVEY_CAP_UNSET, type Context } from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { MemorySurveyBook } from './survey-settings.js';

/** SP-csat-02 — the survey doors: lead-only configure, revision conflicts, unknown survey, contract-invalid input. */

const authConfig = {
  secret: 'a-support-survey-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const AT = '2026-10-22T04:00:00.000Z';
const config = {
  scale: { min: 1, max: 5, labels: [] },
  followUp: null,
  sendAfterMinutes: 30,
  channels: ['in_app'],
  requestTypes: ['question'],
} as const;

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-survey' };
  const { token } = await issueAccessToken(
    { userId, sessionId: '66666666-6666-4666-8666-666666666666', scopes, tier: 'none', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-survey' };
}

async function desk() {
  const staff = new MemoryStaffBook();
  await staff.appoint({ userId: LEAD, role: 'lead', by: LEAD, at: AT });
  await staff.appoint({ userId: AGENT, role: 'agent', by: LEAD, at: AT });
  const support = new SupportService(new MemorySupportStore(), undefined, undefined, staff);
  const router = createSupportRouter(support, undefined, undefined, support, undefined, undefined, new MemorySurveyBook());
  return async (userId: string | null, scopes = ['support:ops', 'support:read']) => router.createCaller(await ctx(userId, scopes));
}

describe('survey doors (SP-csat-02)', () => {
  it('a lead configures; the list carries the cap unset with its code and one active survey', async () => {
    const as = await desk();
    const s = await (await as(LEAD)).configureSurvey({ surveyId: null, expectedRevision: 0, config: config as never });
    expect(s).toMatchObject({ revision: 1, active: true });
    const list = await (await as(AGENT)).surveys();
    expect(list.cap).toEqual({ status: 'unset', code: SUPPORT_SURVEY_CAP_UNSET });
    expect(list.surveys.map((x) => x.surveyId)).toEqual([s.surveyId]);
  });

  it('refuses anonymous, no support:ops, and a non-lead', async () => {
    const as = await desk();
    const input = { surveyId: null, expectedRevision: 0, config: config as never };
    await expect((await as(null)).configureSurvey(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect((await as(LEAD, ['support:read'])).configureSurvey(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(LEAD, ['support:read'])).surveys()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await as(AGENT)).configureSurvey(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('stale revision is CONFLICT, unknown survey NOT_FOUND, bad scale BAD_REQUEST', async () => {
    const as = await desk();
    const lead = await as(LEAD);
    const s = await lead.configureSurvey({ surveyId: null, expectedRevision: 0, config: config as never });
    await expect(
      lead.configureSurvey({ surveyId: s.surveyId, expectedRevision: 0, config: { ...config, sendAfterMinutes: 5 } as never }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'support.survey_revision_stale' });
    await expect(
      lead.configureSurvey({ surveyId: '99999999-9999-4999-8999-999999999999', expectedRevision: 0, config: config as never }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'support.survey_not_found' });
    await expect(
      lead.configureSurvey({ surveyId: null, expectedRevision: 0, config: { ...config, scale: { min: 5, max: 5, labels: [] } } as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

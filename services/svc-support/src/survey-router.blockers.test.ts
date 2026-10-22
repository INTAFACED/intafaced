import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import {
  SUPPORT_SURVEY_EMAIL_DELIVERY,
  SUPPORT_SURVEY_NOT_FOUND,
  SUPPORT_SURVEY_REVISION_STALE,
  supportSurveyRefusalCodeSchema,
  type Context,
} from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { founderApproves, withApprovalIds } from './survey-approval.fixture.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { MemorySurveyBook } from './survey-settings.js';

/** SP-csat-02 review fixes: codes in the contracts refusal enum, the refusal code on cause (message is the code until catalog copy lands), vendor.email NotConnected surfaced. */
const authConfig = {
  secret: 'a-support-survey-blockers-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-22T04:00:00.000Z';
const config = {
  scale: { min: 1, max: 5, labels: [] },
  followUp: null,
  sendAfterMinutes: 30,
  channels: ['in_app'],
  requestTypes: ['question'],
} as const;

async function lead() {
  const staff = new MemoryStaffBook();
  await staff.appoint({ userId: LEAD, role: 'lead', by: LEAD, at: AT });
  const support = new SupportService(new MemorySupportStore(), undefined, undefined, staff);
  const router = createSupportRouter(
    support,
    undefined,
    undefined,
    support,
    undefined,
    undefined,
    new MemorySurveyBook(undefined, null),
    founderApproves(),
  );
  const { token } = await issueAccessToken(
    { userId: LEAD, sessionId: '66666666-6666-4666-8666-666666666666', scopes: ['support:ops', 'support:read'], tier: 'none', mfa: true },
    authConfig,
  );
  const ctx: Context = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-b' };
  return withApprovalIds(router.createCaller(ctx));
}

describe('survey review fixes (SP-csat-02)', () => {
  it('stale and not-found codes are in the contracts refusal enum', () => {
    expect(supportSurveyRefusalCodeSchema.safeParse(SUPPORT_SURVEY_REVISION_STALE).success).toBe(true);
    expect(supportSurveyRefusalCodeSchema.safeParse(SUPPORT_SURVEY_NOT_FOUND).success).toBe(true);
    expect(supportSurveyRefusalCodeSchema.options).toHaveLength(5);
  });

  it('stale and not-found refusals carry user copy on message and the code on cause', async () => {
    const as = await lead();
    const s = await as.configureSurvey({ surveyId: null, expectedRevision: 0, config: config as never, reason: 'Owner set it' });
    await expect(
      as.configureSurvey({ surveyId: s.surveyId, expectedRevision: 0, config: { ...config, sendAfterMinutes: 5 } as never, reason: 'x' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.survey_revision_stale',
      cause: { code: SUPPORT_SURVEY_REVISION_STALE },
    });
    await expect(
      as.configureSurvey({ surveyId: '99999999-9999-4999-8999-999999999999', expectedRevision: 0, config: config as never, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'support.survey_not_found', cause: { code: SUPPORT_SURVEY_NOT_FOUND } });
  });

  it('list and configure surface vendor.email as NotConnected', async () => {
    const as = await lead();
    const s = await as.configureSurvey({ surveyId: null, expectedRevision: 0, config: config as never, reason: 'Owner set it' });
    expect(s.emailDelivery).toEqual({ status: 'not_connected', notConnected: 'vendor.email' });
    expect((await as.surveys()).emailDelivery).toEqual(SUPPORT_SURVEY_EMAIL_DELIVERY);
  });
});

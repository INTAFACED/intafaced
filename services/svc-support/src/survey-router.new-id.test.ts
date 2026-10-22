import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { SUPPORT_SURVEY_ID_CONFLICT, type Context } from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { MemorySurveyBook } from './survey-settings.js';

/** SP-csat-02 r2 #1 at the door: a create replay under the client id returns the original; a different config is CONFLICT. */
const authConfig = {
  secret: 'a-support-survey-new-id-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '55555555-5555-4555-8555-555555555555';
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
  const router = createSupportRouter(support, undefined, undefined, support, undefined, undefined, new MemorySurveyBook(undefined, 3));
  const { token } = await issueAccessToken(
    { userId: LEAD, sessionId: '66666666-6666-4666-8666-666666666666', scopes: ['support:ops', 'support:read'], tier: 'none', mfa: true },
    authConfig,
  );
  const ctx: Context = { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-n' };
  return router.createCaller(ctx);
}

describe('configureSurvey newSurveyId (SP-csat-02)', () => {
  it('replays the create and refuses a different config under the same id', async () => {
    const as = await lead();
    const input = { surveyId: null, newSurveyId: NEW_ID, expectedRevision: 0, config: config as never, reason: 'Owner set it' };
    const first = await as.configureSurvey(input);
    expect(first.surveyId).toBe(NEW_ID);
    expect(await as.configureSurvey(input)).toEqual(first);
    const err = await as.configureSurvey({ ...input, config: { ...config, sendAfterMinutes: 5 } as never }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONFLICT', cause: { code: SUPPORT_SURVEY_ID_CONFLICT } });
    expect((await as.surveys()).surveys).toHaveLength(1);
  });
});

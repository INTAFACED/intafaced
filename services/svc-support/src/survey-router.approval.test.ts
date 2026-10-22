import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { type Context, type SupportSurveyConfigureInput } from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { founderApproves, withApprovalIds } from './survey-approval.fixture.js';
import { MemorySupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { MemorySurveyBook } from './survey-settings.js';
import { FakeIdentityApprovals, FOUNDER } from './survey-approval.fixture.js';
import { SURVEY_CONFIGURE_ACTION, surveyConfigurePayloadHash } from './survey-router.js';

/** SP-csat-02 Security row :58 (D101): configureSurvey consumes a founder action approval bound to the action and payload. */

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
  await staff.appoint({ userId: AGENT, role: 'lead', by: LEAD, at: AT });
  const support = new SupportService(new MemorySupportStore(), undefined, undefined, staff);
  const book = new MemorySurveyBook(undefined, 5);
  const identity = new FakeIdentityApprovals();
  const router = createSupportRouter(support, undefined, undefined, support, undefined, undefined, book, identity);
  return { book, identity, as: async (userId: string) => router.createCaller(await ctx(userId, ['support:ops', 'support:read'])) };
}

const input: SupportSurveyConfigureInput = { surveyId: null, expectedRevision: 0, config: config as never, reason: 'Launch CSAT' };
const approve = (identity: FakeIdentityApprovals, approverId: string, payload = input, targetId: string = SURVEY_CONFIGURE_ACTION) =>
  identity.issue({ requesterId: LEAD, approverId, targetId, payloadHash: surveyConfigurePayloadHash(payload) });

describe('configureSurvey dual control (SP-csat-02, D101)', () => {
  it('refuses without an approval, and writes nothing', async () => {
    const { as, book } = await desk();
    const err = await (await as(LEAD)).configureSurvey(input).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'action_approval.missing' } });
    expect(book.log).toEqual([]);
    expect((await book.list()).surveys).toEqual([]);
  });

  it('refuses an approval for a different action or a different payload', async () => {
    const { as, identity, book } = await desk();
    const lead = await as(LEAD);
    await expect(
      lead.configureSurvey({ ...input, ...approve(identity, FOUNDER, input, 'support.attachments.configure') }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'action_approval.consume_failed' },
    });
    const other = { ...input, reason: 'something else' };
    await expect(lead.configureSurvey({ ...input, ...approve(identity, FOUNDER, other) })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      lead.configureSurvey({ ...input, config: { ...config, sendAfterMinutes: 5 } as never, ...approve(identity, FOUNDER) }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(book.log).toEqual([]);
  });

  it('refuses self-approval and a reused approval', async () => {
    const { as, identity, book } = await desk();
    const lead = await as(LEAD);
    const self = await lead.configureSurvey({ ...input, ...approve(identity, LEAD) }).catch((e: unknown) => e);
    expect(self).toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('self-approval') });
    const ids = approve(identity, FOUNDER);
    const first = await lead.configureSurvey({ ...input, ...ids });
    await expect(
      (await as(AGENT)).configureSurvey({ ...input, surveyId: first.surveyId, expectedRevision: 1, ...ids }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(book.log).toHaveLength(1);
  });

  it('a valid founder approval configures and the audit row carries reason, actor, approver and approval id', async () => {
    const { as, identity, book } = await desk();
    const ids = approve(identity, FOUNDER);
    const s = await (await as(LEAD)).configureSurvey({ ...input, ...ids });
    expect(s).toMatchObject({ revision: 1, active: true });
    expect(book.log).toEqual([
      {
        key: `support.survey:${s.surveyId}:r1`,
        surveyId: s.surveyId,
        revisionAfter: 1,
        setBy: LEAD,
        reason: 'Launch CSAT',
        approvedBy: FOUNDER,
        approvalId: ids.approvalId,
      },
    ]);
  });
});

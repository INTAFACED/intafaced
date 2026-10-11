import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import {
  outreachCaptureInputSchema,
  outreachQuestionnaireSchema,
  outreachContinuationTokenSchema,
  outreachDraftSchema,
  type OutreachAudience,
} from '../../../../packages/contracts/src/outreach-crm';
import { mutate } from './config/intafaced.js';

const require = createRequire(import.meta.url);
const intake = require('./assets/js/outreach-intake.js') as {
  buildQuestionnaire(audience: OutreachAudience, form: Record<string, unknown>): unknown;
  buildContact(form: Record<string, unknown>): unknown;
  createCapability(crypto: unknown, encode: (value: string) => string): string;
  validDraft(value: unknown): boolean;
};
const forms: Record<OutreachAudience, Record<string, unknown>> = {
  investor: {
    investorType: 'fund',
    participation: 'both',
    decisionRole: 'adviser',
    amountStatus: 'stated',
    amount: '9007199254740993.000000000000000001',
    currency: 'USD',
  },
  trader: { markets: ['spot', 'derivatives'], experience: 'advanced', role: 'professional', platformInterest: 'Migration and API' },
  merchant: {
    businessName: 'Example',
    website: 'https://example.com',
    industry: 'Retail',
    operatingCountries: 'ID, SG',
    amountStatus: 'stated',
    amount: '0.000000000000000001',
    currency: 'IDR',
    period: 'monthly',
    services: ['payment_acceptance', 'payouts'],
  },
  academy: { learningGoal: 'Market literacy', experience: 'beginner', subjects: 'Risk, Markets', format: 'cohort' },
  partner: { expertise: 'Education', contribution: 'Curriculum', relationship: 'partnership', scope: 'Delivery' },
};

describe('public outreach v1 contract and existing edge transport', () => {
  it.each(Object.entries(forms))('builds exact %s v1 answers accepted by contracts', (audience, form) => {
    const q = intake.buildQuestionnaire(audience as OutreachAudience, { ...form, timing: 'undecided', message: 'Question' });
    expect(outreachQuestionnaireSchema.parse(q)).toEqual(q);
  });
  it('builds canonical 256-bit capabilities and strict contact capture', () => {
    const token = intake.createCapability(webcrypto, (value) => Buffer.from(value, 'binary').toString('base64'));
    expect(outreachContinuationTokenSchema.parse(token)).toBe(token);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const contact = intake.buildContact({
      name: 'Visitor',
      email: 'VISITOR@example.com',
      organisationName: 'Example',
      country: 'id',
      interests: ['investor', 'academy'],
      marketingOptIn: false,
    });
    const input = { requestId: webcrypto.randomUUID(), continuationToken: token, contact, sourceKey: 'opaque_campaign_1234' };
    expect(outreachCaptureInputSchema.parse(input)).toEqual(input);
  });
  it('refuses unsafe money and unselected or repeated questions in response drafts', () => {
    const contact = intake.buildContact({ name: 'Visitor', email: 'visitor@example.com', interests: ['investor'], marketingOptIn: false });
    const q = intake.buildQuestionnaire('investor', { ...forms.investor, timing: 'later' });
    const base = {
      submissionId: webcrypto.randomUUID(),
      revision: 2,
      capturedAt: new Date().toISOString(),
      continuationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      completedAt: null,
      contact,
      questionnaires: [q],
    };
    expect(outreachDraftSchema.parse(base)).toEqual(base);
    expect(intake.validDraft(base)).toBe(true);
    for (const questionnaires of [
      [q, q],
      [intake.buildQuestionnaire('partner', { ...forms.partner, timing: 'later' })],
      [
        {
          audience: 'investor',
          version: 1,
          answers: { ...forms.investor, indicativeContribution: { status: 'stated', amount: 3, currency: 'USD' }, timing: 'later' },
        },
      ],
    ]) {
      expect(outreachDraftSchema.safeParse({ ...base, questionnaires }).success).toBe(false);
      expect(intake.validDraft({ ...base, questionnaires })).toBe(false);
    }
  });
  it('POSTs capture, resume and answer through edge with bare JSON and no bearer or query', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ result: { data: { saved: true } } }) });
    vi.stubGlobal('fetch', fetch);
    try {
      for (const method of ['capture', 'resume', 'answer']) {
        const input = { continuationToken: 'test-secret-not-for-url', requestId: webcrypto.randomUUID() };
        await mutate('ops', 'outreach.' + method, input, null);
        const [url, options] = fetch.mock.calls.at(-1)!;
        expect(url).toBe('/api/ops/trpc/outreach.' + method);
        expect(options.method).toBe('POST');
        expect(JSON.parse(options.body)).toEqual(input);
        expect(options.headers).toEqual({ 'content-type': 'application/json' });
        expect(url).not.toContain(input.continuationToken);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

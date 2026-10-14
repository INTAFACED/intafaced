import { describe, expect, it } from 'vitest';
import { crmMessageSchema, crmMessagePageSchema } from './crm-notifications.js';
import {
  crmActivitySchema,
  crmCommunityStageSchema,
  crmNextActionInputSchema,
  crmEngagementSyncSchema,
  crmInvestorStageSchema,
  crmOpportunitySchema,
  crmOpportunityRowSchema,
  crmOpportunityPageSchema,
  crmCommitmentSchema,
  crmSetCommitmentInputSchema,
  ISO_4217_CURRENCIES,
  crmListInputSchema,
  outreachIndicativeAmountSchema,
  crmStageChangeInputSchema,
  crmStageFitsAudience,
  crmSubmissionSchema,
  crmAssignmentInputSchema,
  outreachCaptureInputSchema,
  outreachCaptureReceiptSchema,
  outreachContinuationTokenSchema,
  outreachDraftSchema,
  outreachQuestionnaireInputSchema,
  outreachQuestionnaireSchema,
  type OutreachAudience,
} from './outreach-crm.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const SUBMISSION_ID = '22222222-2222-4222-8222-222222222222';
const OPPORTUNITY_ID = '33333333-3333-4333-8333-333333333333';
const CONTACT_ID = '44444444-4444-4444-8444-444444444444';
const OWNER_ID = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-10-10T12:00:00.000Z';
const TOKEN = 'A'.repeat(43);

function questionnaire(audience: OutreachAudience) {
  const timing = { timing: 'as_available' } as const;
  switch (audience) {
    case 'investor':
      return {
        audience,
        version: 1,
        answers: {
          investorType: 'individual',
          participation: 'direct',
          decisionRole: 'decision_maker',
          indicativeContribution: { status: 'undecided' },
          ...timing,
        },
      };
    case 'trader':
      return {
        audience,
        version: 1,
        answers: {
          markets: ['spot'],
          experience: 'beginner',
          role: 'individual',
          platformInterest: 'Spot trading',
          ...timing,
        },
      };
    case 'merchant':
      return {
        audience,
        version: 1,
        answers: {
          businessName: 'Example GmbH',
          industry: 'Retail',
          operatingCountries: ['DE'],
          processingVolume: { status: 'unknown' },
          services: ['payment_acceptance'],
          ...timing,
        },
      };
    case 'academy':
      return {
        audience,
        version: 1,
        answers: {
          learningGoal: 'Learn digital asset basics',
          experience: 'beginner',
          subjects: ['Security'],
          format: 'self_paced',
          ...timing,
        },
      };
    case 'partner':
      return {
        audience,
        version: 1,
        answers: {
          expertise: 'Payments',
          contribution: 'I can advise on payment operations.',
          relationship: 'collaboration',
          ...timing,
        },
      };
  }
}

const CAPTURE = {
  requestId: REQUEST_ID,
  continuationToken: TOKEN,
  contact: {
    name: 'Ada Lovelace',
    email: 'ADA@example.com',
    interests: ['investor'],
    marketingOptIn: false,
  },
};

const RECEIPT = {
  submissionId: SUBMISSION_ID,
  revision: 1,
  capturedAt: NOW,
  continuationExpiresAt: '2026-10-10T12:15:00.000Z',
};

const OPPORTUNITY_BASE = {
  id: OPPORTUNITY_ID,
  contactId: CONTACT_ID,
  organisationId: null,
  submissionId: SUBMISSION_ID,
  ownerUserId: OWNER_ID,
  revision: 1,
  nextAction: { description: 'Review enquiry', dueAt: '2026-10-11T12:00:00.000Z' },
  closedDisposition: null,
  closingEvidenceRef: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const REPLY_STATE = { firstReplyAt: null, lastTouchAt: null, waitingSince: NOW };

describe('outreach and CRM boundary contracts', () => {
  it('includes exactly the private contacts associated with visible opportunities', () => {
    const opportunity = {
      ...OPPORTUNITY_BASE,
      ...REPLY_STATE,
      audience: 'investor',
      stage: 'new',
      indicativeContribution: { status: 'undecided' },
    };
    const contact = {
      id: CONTACT_ID,
      name: 'Ada',
      email: 'ada@example.com',
      emailEvidence: { status: 'unverified' },
      organisationIds: [],
      interests: ['investor'],
      platformIdentity: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const summary = { submissionId: opportunity.submissionId, completedAt: null, organisationName: 'Original organisation' };
    const page = { items: [opportunity], contacts: [contact], submissions: [summary], nextCursor: null };
    expect(crmOpportunityPageSchema.safeParse(page).success).toBe(true);
    expect(crmOpportunityPageSchema.safeParse({ ...page, contacts: [] }).success).toBe(false);
    expect(crmOpportunityPageSchema.safeParse({ ...page, contacts: [contact, contact] }).success).toBe(false);
    expect(crmOpportunityPageSchema.safeParse({ ...page, items: [] }).success).toBe(false);
    expect(crmOpportunityPageSchema.safeParse({ ...page, submissions: [] }).success).toBe(false);
    expect(crmOpportunityPageSchema.safeParse({ ...page, submissions: [summary, summary] }).success).toBe(false);
    expect(crmOpportunityPageSchema.safeParse({ ...page, submissions: [{ ...summary, submissionId: REQUEST_ID }] }).success).toBe(false);
    expect(crmOpportunityPageSchema.safeParse({ ...page, submissions: [{ ...summary, completedAt: 'invalid' }] }).success).toBe(false);
    expect(crmOpportunityPageSchema.safeParse({ ...page, submissions: [{ ...summary, email: 'private@example.test' }] }).success).toBe(
      false,
    );
    expect(
      crmOpportunityPageSchema.safeParse({ ...page, submissions: [{ ...summary, completedAt: '2026-10-11T00:00:00.000Z' }] }).success,
    ).toBe(true);
  });
  it.each(['investor', 'trader', 'merchant', 'academy', 'partner'] as const)(
    'accepts the published version 1 %s questionnaire',
    (audience) => {
      expect(outreachQuestionnaireSchema.safeParse(questionnaire(audience)).success).toBe(true);
    },
  );

  it('rejects unknown questionnaire versions and answers from a different audience', () => {
    expect(outreachQuestionnaireSchema.safeParse({ ...questionnaire('trader'), version: 2 }).success).toBe(false);
    expect(
      outreachQuestionnaireSchema.safeParse({
        ...questionnaire('merchant'),
        answers: questionnaire('trader').answers,
      }).success,
    ).toBe(false);
  });

  it('keeps indicative money as a decimal string with an explicit currency', () => {
    const investor = questionnaire('investor');
    const stated = { status: 'stated', amount: '25000.50', currency: 'EUR' };
    expect(
      outreachQuestionnaireSchema.safeParse({ ...investor, answers: { ...investor.answers, indicativeContribution: stated } }).success,
    ).toBe(true);
    expect(
      outreachQuestionnaireSchema.safeParse({
        ...investor,
        answers: { ...investor.answers, indicativeContribution: { ...stated, amount: 25000.5 } },
      }).success,
    ).toBe(false);
    expect(
      outreachQuestionnaireSchema.safeParse({
        ...investor,
        answers: { ...investor.answers, indicativeContribution: { status: 'stated', amount: '25000' } },
      }).success,
    ).toBe(false);
  });

  it('requires currency and period when merchant volume is stated', () => {
    const merchant = questionnaire('merchant');
    const stated = { status: 'stated', amount: '1000', currency: 'EUR', period: 'monthly' };
    expect(outreachQuestionnaireSchema.safeParse({ ...merchant, answers: { ...merchant.answers, processingVolume: stated } }).success).toBe(
      true,
    );
    expect(
      outreachQuestionnaireSchema.safeParse({
        ...merchant,
        answers: { ...merchant.answers, processingVolume: { status: 'stated', amount: '1000', period: 'monthly' } },
      }).success,
    ).toBe(false);
    expect(
      outreachQuestionnaireSchema.safeParse({
        ...merchant,
        answers: { ...merchant.answers, processingVolume: { status: 'stated', amount: '1000', currency: 'EUR' } },
      }).success,
    ).toBe(false);
    expect(
      outreachQuestionnaireSchema.safeParse({
        ...merchant,
        answers: { ...merchant.answers, processingVolume: { ...stated, amount: 1000 } },
      }).success,
    ).toBe(false);
  });

  it.each(['ownerUserId', 'actor', 'platformUserId', 'verified', 'stage'] as const)(
    'rejects caller-injected %s on both public write inputs',
    (field) => {
      expect(outreachCaptureInputSchema.safeParse({ ...CAPTURE, [field]: 'injected' }).success).toBe(false);
      expect(
        outreachQuestionnaireInputSchema.safeParse({
          submissionId: SUBMISSION_ID,
          continuationToken: TOKEN,
          requestId: REQUEST_ID,
          expectedRevision: 1,
          questionnaire: questionnaire('investor'),
          [field]: 'injected',
        }).success,
      ).toBe(false);
    },
  );

  it('rejects privileged identity fields smuggled inside public contact data', () => {
    for (const field of ['ownerUserId', 'actor', 'platformUserId', 'verified', 'stage']) {
      expect(
        outreachCaptureInputSchema.safeParse({
          ...CAPTURE,
          contact: { ...CAPTURE.contact, [field]: 'injected' },
        }).success,
      ).toBe(false);
    }
  });

  it('bounds continuation capability shape and keeps capture receipts prospect-private', () => {
    expect(outreachContinuationTokenSchema.safeParse(TOKEN).success).toBe(true);
    expect(outreachContinuationTokenSchema.safeParse('A'.repeat(42)).success).toBe(false);
    expect(outreachContinuationTokenSchema.safeParse('A'.repeat(44)).success).toBe(false);
    expect(outreachContinuationTokenSchema.safeParse('A'.repeat(42) + 'B').success).toBe(false);
    expect(outreachCaptureReceiptSchema.safeParse(RECEIPT).success).toBe(true);
    for (const field of ['email', 'contactId', 'ownerUserId', 'actor', 'stage']) {
      expect(outreachCaptureReceiptSchema.safeParse({ ...RECEIPT, [field]: 'private' }).success).toBe(false);
    }
  });

  it('accepts a completed draft only when it covers each selected audience exactly once', () => {
    const interests = ['investor', 'academy'] as const;
    const complete = {
      submissionId: SUBMISSION_ID,
      revision: 2,
      contact: { ...CAPTURE.contact, interests },
      questionnaires: [questionnaire('investor'), questionnaire('academy')],
      capturedAt: NOW,
      completedAt: '2026-10-10T12:05:00.000Z',
      continuationExpiresAt: '2026-10-10T12:15:00.000Z',
    };
    expect(outreachDraftSchema.safeParse(complete).success).toBe(true);
    expect(outreachDraftSchema.safeParse({ ...complete, questionnaires: [questionnaire('investor')] }).success).toBe(false);
    expect(
      outreachDraftSchema.safeParse({
        ...complete,
        questionnaires: [...complete.questionnaires, questionnaire('investor')],
      }).success,
    ).toBe(false);
    expect(
      outreachDraftSchema.safeParse({
        ...complete,
        questionnaires: [questionnaire('investor'), questionnaire('academy'), questionnaire('partner')],
      }).success,
    ).toBe(false);
    expect(outreachDraftSchema.safeParse({ ...complete, completedAt: '2026-10-10T11:59:00.000Z' }).success).toBe(false);
  });

  it('lets staff read original answers without exposing or accepting a continuation capability', () => {
    const staffSubmission = {
      submissionId: SUBMISSION_ID,
      revision: 2,
      contactId: CONTACT_ID,
      contact: { ...CAPTURE.contact, interests: ['investor'] },
      questionnaires: [questionnaire('investor')],
      capturedAt: NOW,
      completedAt: '2026-10-10T12:05:00.000Z',
    };
    const parsed = crmSubmissionSchema.safeParse(staffSubmission);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty('continuationToken');
    expect(crmSubmissionSchema.safeParse({ ...staffSubmission, continuationToken: TOKEN }).success).toBe(false);
    expect(crmSubmissionSchema.safeParse({ ...staffSubmission, completedAt: '2026-10-10T11:59:00.000Z' }).success).toBe(false);
  });

  it('separates investor and community stage vocabularies', () => {
    expect(crmInvestorStageSchema.safeParse('diligence').success).toBe(true);
    expect(crmCommunityStageSchema.safeParse('onboarding').success).toBe(true);
    expect(crmInvestorStageSchema.safeParse('invited').success).toBe(false);
    expect(crmCommunityStageSchema.safeParse('terms').success).toBe(false);
    expect(crmOpportunitySchema.safeParse({ ...OPPORTUNITY_BASE, audience: 'investor', stage: 'invited' }).success).toBe(false);
    expect(crmOpportunitySchema.safeParse({ ...OPPORTUNITY_BASE, audience: 'partner', stage: 'diligence' }).success).toBe(false);
    expect(crmStageFitsAudience('investor', 'diligence')).toBe(true);
    expect(crmStageFitsAudience('investor', 'invited')).toBe(false);
    expect(crmStageFitsAudience('partner', 'onboarding')).toBe(true);
    expect(crmStageFitsAudience('trader', 'terms')).toBe(false);
    expect(
      crmOpportunitySchema.safeParse({ ...OPPORTUNITY_BASE, audience: 'investor', stage: 'qualified', nextAction: null }).success,
    ).toBe(false);
  });

  it('requires disposition and evidence exactly when an opportunity closes', () => {
    const closed = {
      ...OPPORTUNITY_BASE,
      audience: 'investor',
      stage: 'closed',
      nextAction: null,
      indicativeContribution: { status: 'undecided' },
      closedDisposition: 'proceeded',
      closingEvidenceRef: 'review:decision-2026-10-10',
    };
    expect(crmOpportunitySchema.safeParse(closed).success).toBe(true);
    expect(crmOpportunitySchema.safeParse({ ...closed, closingEvidenceRef: null }).success).toBe(false);
    expect(crmOpportunitySchema.safeParse({ ...closed, closedDisposition: null }).success).toBe(false);
    expect(crmOpportunitySchema.safeParse({ ...closed, nextAction: OPPORTUNITY_BASE.nextAction }).success).toBe(false);
    expect(crmOpportunitySchema.safeParse({ ...closed, closingEvidenceRef: '   ' }).success).toBe(false);
    expect(
      crmOpportunitySchema.safeParse({
        ...OPPORTUNITY_BASE,
        audience: 'trader',
        stage: 'qualified',
        closedDisposition: 'declined',
        closingEvidenceRef: 'review:decision-2026-10-10',
      }).success,
    ).toBe(false);
  });

  it('keeps stage changes and assignment inputs free of caller-supplied actor identity', () => {
    const change = {
      requestId: REQUEST_ID,
      opportunityId: OPPORTUNITY_ID,
      expectedRevision: 1,
      stage: 'qualified',
      reason: 'Initial review complete',
      closedDisposition: null,
      closingEvidenceRef: null,
      nextAction: OPPORTUNITY_BASE.nextAction,
    };
    expect(crmStageChangeInputSchema.safeParse(change).success).toBe(true);
    expect(crmStageChangeInputSchema.safeParse({ ...change, actor: { kind: 'operator', userId: OWNER_ID } }).success).toBe(false);
    expect(crmStageChangeInputSchema.safeParse({ ...change, stage: 'diligence', actor: OWNER_ID }).success).toBe(false);
    const assignment = { requestId: REQUEST_ID, opportunityId: OPPORTUNITY_ID, expectedRevision: 1, ownerUserId: OWNER_ID };
    expect(crmAssignmentInputSchema.safeParse(assignment).success).toBe(true);
    expect(crmAssignmentInputSchema.safeParse({ ...assignment, actor: OWNER_ID }).success).toBe(false);
  });

  it('represents unavailable free sync as disabled, never a successful zero-count sync', () => {
    expect(crmEngagementSyncSchema.safeParse({ status: 'disabled', reason: 'api_access_unavailable' }).success).toBe(true);
    expect(crmEngagementSyncSchema.safeParse({ status: 'disabled', reason: 'unconfigured' }).success).toBe(true);
    expect(crmEngagementSyncSchema.safeParse({ status: 'synced', views: 0 }).success).toBe(false);
  });

  it('accepts a next-action edit without a stage or a reason, and refuses actor identity or an empty description', () => {
    const edit = {
      requestId: REQUEST_ID,
      opportunityId: OPPORTUNITY_ID,
      expectedRevision: 3,
      description: 'Send the deck',
      dueAt: '2026-10-14T09:00:00.000Z',
    };
    expect(crmNextActionInputSchema.safeParse(edit).success).toBe(true);
    expect(crmNextActionInputSchema.safeParse({ ...edit, stage: 'qualified' }).success).toBe(false);
    expect(crmNextActionInputSchema.safeParse({ ...edit, reason: 'Because' }).success).toBe(false);
    expect(crmNextActionInputSchema.safeParse({ ...edit, actor: OWNER_ID }).success).toBe(false);
    expect(crmNextActionInputSchema.safeParse({ ...edit, description: '   ' }).success).toBe(false);
    expect(crmNextActionInputSchema.safeParse({ ...edit, description: 'x'.repeat(161) }).success).toBe(false);
    expect(crmNextActionInputSchema.safeParse({ ...edit, dueAt: 'tomorrow' }).success).toBe(false);
    expect(crmNextActionInputSchema.safeParse({ ...edit, expectedRevision: 0 }).success).toBe(false);
    expect(crmNextActionInputSchema.safeParse({ ...edit, requestId: undefined }).success).toBe(false);
  });

  it('knows the next_action_changed activity kind', () => {
    const activity = {
      id: REQUEST_ID,
      opportunityId: OPPORTUNITY_ID,
      sequence: 2,
      kind: 'next_action_changed',
      actor: { kind: 'operator', userId: OWNER_ID },
      note: 'Send the deck',
      referenceId: '2026-10-14T09:00:00.000Z',
      occurredAt: NOW,
    };
    expect(crmActivitySchema.safeParse(activity).success).toBe(true);
    expect(crmActivitySchema.safeParse({ ...activity, kind: 'next_action_edited' }).success).toBe(false);
  });

  it('carries an alias match only for a visible opportunity', () => {
    const opportunity = {
      ...OPPORTUNITY_BASE,
      ...REPLY_STATE,
      audience: 'investor',
      stage: 'new',
      indicativeContribution: { status: 'undecided' },
    };
    const contact = {
      id: CONTACT_ID,
      name: 'Ada',
      email: 'ada@example.com',
      emailEvidence: { status: 'unverified' },
      organisationIds: [],
      interests: ['investor'],
      platformIdentity: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const summary = { submissionId: opportunity.submissionId, completedAt: null, organisationName: null };
    const page = { items: [opportunity], contacts: [contact], submissions: [summary], nextCursor: null };
    expect(crmOpportunityPageSchema.safeParse(page).success).toBe(true); // optional: an older page still parses
    expect(
      crmOpportunityPageSchema.safeParse({ ...page, aliasMatches: [{ opportunityId: OPPORTUNITY_ID, name: 'Old Ada' }] }).success,
    ).toBe(true);
    expect(crmOpportunityPageSchema.safeParse({ ...page, aliasMatches: [{ opportunityId: REQUEST_ID, name: 'Old Ada' }] }).success).toBe(
      false,
    );
    expect(
      crmOpportunityPageSchema.safeParse({ ...page, aliasMatches: [{ opportunityId: OPPORTUNITY_ID, name: 'Old Ada', email: 'x@y.test' }] })
        .success,
    ).toBe(false);
    expect(crmOpportunityPageSchema.safeParse({ ...page, aliasMatches: [{ opportunityId: OPPORTUNITY_ID, name: '' }] }).success).toBe(
      false,
    );
  });

  it('returns the founder-written message text, or null, on a message', () => {
    const message = {
      id: REQUEST_ID,
      opportunityId: OPPORTUNITY_ID,
      submissionId: SUBMISSION_ID,
      kind: 'follow_up',
      staffText: 'Thanks for your interest. Are you free on Friday?',
      actorUserId: OWNER_ID,
      status: 'unconfigured',
      createdAt: NOW,
      notification: null,
    };
    expect(crmMessageSchema.parse(message).staffText).toBe('Thanks for your interest. Are you free on Friday?');
    expect(crmMessageSchema.parse({ ...message, staffText: null }).staffText).toBeNull();
    // Saved before the field existed: absent reads as null, so an old message or idempotency receipt still parses.
    const { staffText: _absent, ...beforeStaffText } = message;
    expect(crmMessageSchema.parse(beforeStaffText).staffText).toBeNull();
    expect(crmMessageSchema.parse({ ...message, staffText: undefined }).staffText).toBeNull();
    expect(crmMessageSchema.safeParse({ ...message, staffText: 'x'.repeat(2001) }).success).toBe(false);
    expect(crmMessagePageSchema.safeParse({ items: [message], nextCursor: null }).success).toBe(true);
  });
  describe('reply state, queue mode and commitment', () => {
    const investor = {
      ...OPPORTUNITY_BASE,
      audience: 'investor' as const,
      stage: 'new' as const,
      indicativeContribution: { status: 'undecided' as const },
    };
    const commitment = { tier: 'soft_circled', amount: '250000', currency: 'EUR', recordedAt: NOW, recordedBy: OWNER_ID };

    it('reads a record saved before commitment existed as having none, and keeps reply state out of the record', () => {
      expect(crmOpportunitySchema.parse(investor)).toMatchObject({ commitment: null });
      expect(crmOpportunitySchema.safeParse({ ...investor, firstReplyAt: null }).success).toBe(false);
      const row = crmOpportunityRowSchema.parse({ ...investor, ...REPLY_STATE });
      expect(row).toMatchObject({ commitment: null, firstReplyAt: null, lastTouchAt: null, waitingSince: NOW });
      // A row must say when it started waiting; a server that omits the reply state is refused, not read as "unreplied".
      expect(crmOpportunityRowSchema.safeParse(investor).success).toBe(false);
      expect(crmOpportunityRowSchema.safeParse({ ...investor, ...REPLY_STATE, waitingSince: 'soon' }).success).toBe(false);
    });

    it('holds a commitment on investors only, and checks the money', () => {
      expect(crmOpportunitySchema.parse({ ...investor, commitment })).toMatchObject({ commitment });
      const trader = { ...OPPORTUNITY_BASE, audience: 'trader' as const, stage: 'new' as const };
      expect(crmOpportunitySchema.safeParse({ ...trader, commitment }).success).toBe(false);
      expect(crmCommitmentSchema.safeParse({ ...commitment, tier: 'received' }).success).toBe(false);
      expect(crmCommitmentSchema.safeParse({ ...commitment, evidenceRef: 'x'.repeat(201) }).success).toBe(false);
      expect(crmCommitmentSchema.safeParse({ ...commitment, evidenceRef: 'x'.repeat(200) }).success).toBe(true);
      for (const amount of ['-1', '1e6', '1,000', ' 5', '5.', '.5', '0', '0.00', '250000.0000000000000000001', 'abc', '']) {
        expect(crmCommitmentSchema.safeParse({ ...commitment, amount }).success, amount).toBe(false);
      }
      for (const amount of ['1', '0.5', '250000', '99999999999999999999999.123456789012345678']) {
        expect(crmCommitmentSchema.safeParse({ ...commitment, amount }).success, amount).toBe(true);
      }
      // Numbers are not decimal strings.
      expect(crmCommitmentSchema.safeParse({ ...commitment, amount: 250000 }).success).toBe(false);
    });

    it('requires a reference to the documents for committed, and lets soft-circled go without one', () => {
      const committed = { tier: 'committed', amount: '100000', currency: 'EUR' };
      expect(crmCommitmentSchema.safeParse({ ...commitment, ...committed }).success).toBe(false);
      expect(crmCommitmentSchema.safeParse({ ...commitment, ...committed, evidenceRef: 'signed agreement' }).success).toBe(true);
      expect(crmCommitmentSchema.safeParse({ ...commitment, ...committed, evidenceRef: '   ' }).success).toBe(false);
      const { evidenceRef: _unused, ...soft } = { ...commitment, evidenceRef: undefined };
      expect(crmCommitmentSchema.safeParse(soft).success).toBe(true);
      const input = { requestId: REQUEST_ID, opportunityId: OPPORTUNITY_ID, expectedRevision: 1, reason: 'Documents signed' };
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, commitment: committed }).success).toBe(false);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, commitment: { ...committed, evidenceRef: 'signed' } }).success).toBe(true);
      expect(
        crmSetCommitmentInputSchema.safeParse({ ...input, commitment: { tier: 'soft_circled', amount: '5', currency: 'EUR' } }).success,
      ).toBe(true);
    });

    it('caps an indicative amount at 15 integer digits and 18 decimals', () => {
      const stated = (amount: string) => outreachIndicativeAmountSchema.safeParse({ status: 'stated', amount, currency: 'EUR' }).success;
      expect(stated('999999999999999')).toBe(true);
      expect(stated('999999999999999.123456789012345678')).toBe(true);
      expect(stated('1000000000000000')).toBe(false);
      expect(stated('1'.repeat(40))).toBe(false);
      expect(stated('1.1234567890123456789')).toBe(false);
      // Any three-letter code is still accepted at intake; the public picker offers more than ISO 4217.
      expect(outreachIndicativeAmountSchema.safeParse({ status: 'stated', amount: '5', currency: 'XCG' }).success).toBe(true);
      expect(outreachIndicativeAmountSchema.safeParse({ status: 'stated', amount: '5', currency: 'BTC' }).success).toBe(true);
    });

    it('accepts only real ISO 4217 currencies', () => {
      for (const currency of ['EUR', 'USD', 'GBP', 'IDR', 'JPY', 'CHF', 'SGD', 'XCG', 'ANG']) {
        expect(crmCommitmentSchema.safeParse({ ...commitment, currency }).success, currency).toBe(true);
      }
      for (const currency of ['ZZZ', 'XXX', 'XAU', 'BTC', 'eur', 'EU', 'EURO', '', 'ABC']) {
        expect(crmCommitmentSchema.safeParse({ ...commitment, currency }).success, currency).toBe(false);
      }
      expect(new Set(ISO_4217_CURRENCIES).size).toBe(ISO_4217_CURRENCIES.length);
    });

    it('sets or clears a commitment with a revision and a reason, and never accepts who or when', () => {
      const input = {
        requestId: REQUEST_ID,
        opportunityId: OPPORTUNITY_ID,
        expectedRevision: 3,
        commitment: { tier: 'committed', amount: '100000', currency: 'EUR', evidenceRef: 'signed subscription agreement, 2026-10-12' },
        reason: 'Documents signed',
      };
      expect(crmSetCommitmentInputSchema.safeParse(input).success).toBe(true);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, commitment: null }).success).toBe(true);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, commitment: undefined }).success).toBe(false);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, reason: '  ' }).success).toBe(false);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, reason: undefined }).success).toBe(false);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, requestId: undefined }).success).toBe(false);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, commitment: { ...input.commitment, recordedBy: OWNER_ID } }).success).toBe(
        false,
      );
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, commitment: { ...input.commitment, amount: '-5' } }).success).toBe(false);
      expect(crmSetCommitmentInputSchema.safeParse({ ...input, commitment: { ...input.commitment, currency: 'ZZZ' } }).success).toBe(false);
    });

    it('accepts the waiting queue on a list request and nothing else in its place', () => {
      expect(crmListInputSchema.parse({ limit: 50, queue: 'waiting' })).toEqual({ limit: 50, queue: 'waiting' });
      expect(crmListInputSchema.parse({ limit: 50 }).queue).toBeUndefined();
      expect(crmListInputSchema.safeParse({ limit: 50, queue: 'all' }).success).toBe(false);
    });

    it('records where a stage, a next action and a commitment came from and went, and still reads old entries', () => {
      const activity = {
        id: REQUEST_ID,
        opportunityId: OPPORTUNITY_ID,
        sequence: 2,
        kind: 'stage_changed',
        actor: { kind: 'operator', userId: OWNER_ID },
        note: 'Reviewed: fits',
        referenceId: null,
        occurredAt: NOW,
      };
      expect(crmActivitySchema.safeParse(activity).success).toBe(true); // an entry written before these fields existed
      expect(crmActivitySchema.safeParse({ ...activity, fromStage: 'new', toStage: 'qualified' }).success).toBe(true);
      expect(crmActivitySchema.safeParse({ ...activity, fromStage: 'archived' }).success).toBe(false);
      const due = { ...activity, kind: 'next_action_changed', fromDueAt: NOW, toDueAt: '2026-10-15T00:00:00.000Z' };
      expect(crmActivitySchema.safeParse(due).success).toBe(true);
      expect(crmActivitySchema.safeParse({ ...due, fromDueAt: null }).success).toBe(true);
      const changed = {
        ...activity,
        kind: 'commitment_changed',
        fromCommitment: null,
        toCommitment: { tier: 'committed', amount: '100000', currency: 'EUR' },
      };
      expect(crmActivitySchema.safeParse(changed).success).toBe(true);
      expect(crmActivitySchema.safeParse({ ...changed, toCommitment: { tier: 'committed', amount: '-1', currency: 'EUR' } }).success).toBe(
        false,
      );
      expect(crmActivitySchema.safeParse({ ...activity, kind: 'reply_sent' }).success).toBe(true);
    });
  });
});

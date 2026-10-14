import { describe, expect, it } from 'vitest';
import {
  crmAttributionSchema,
  crmExportInputSchema,
  crmMergeInputSchema,
  crmMetricsInputSchema,
  crmCampaignWriteInputSchema,
  crmDocumentProviderReadResultSchema,
  crmInteractionInputSchema,
  crmInteractionSchema,
  crmMetricsSchema,
  crmRaiseSchema,
  crmWorkflowAuditSchema,
} from './crm-workflows.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = '2026-10-10T12:00:00.000Z';
const attribution = {
  sourceHint: null,
  sourceMappingId: null,
  sourceMappingRevision: null,
  campaign: null,
  recipientLinkage: 'unknown',
  capturedAt: NOW,
};
const campaign = { id: A, revision: 1, name: 'Investor deck', channel: 'deck', documentRef: null, providerLinkId: null };

describe('owned CRM workflow boundaries', () => {
  it('allows unknown campaign attribution and a complete captured mapping, never partial or invented recipient linkage', () => {
    expect(crmAttributionSchema.parse(attribution)).toEqual(attribution);
    const mapped = { ...attribution, sourceHint: 'opaque_source_1234', sourceMappingId: B, sourceMappingRevision: 1, campaign };
    expect(crmAttributionSchema.parse(mapped)).toEqual(mapped);
    for (const wrong of [
      { ...attribution, sourceMappingId: B },
      { ...attribution, sourceMappingRevision: 1 },
      { ...mapped, sourceHint: null },
      { ...mapped, sourceMappingId: null },
      { ...mapped, recipientLinkage: 'verified' },
    ])
      expect(crmAttributionSchema.safeParse(wrong).success).toBe(false);
  });
  it('requires increasing time bounds for metrics and bounded original-answer exports', () => {
    const bounds = { capturedFrom: NOW, capturedBefore: '2026-10-11T12:00:00.000Z' };
    expect(crmMetricsInputSchema.safeParse(bounds).success).toBe(true);
    expect(crmExportInputSchema.safeParse({ requestId: A, limit: 200, ...bounds }).success).toBe(true);
    for (const capturedBefore of [NOW, '2026-10-09T12:00:00.000Z']) {
      expect(crmMetricsInputSchema.safeParse({ ...bounds, capturedBefore }).success).toBe(false);
      expect(crmExportInputSchema.safeParse({ requestId: A, limit: 200, ...bounds, capturedBefore }).success).toBe(false);
    }
    expect(crmExportInputSchema.safeParse({ requestId: A, limit: 201 }).success).toBe(false);
  });
  it('requires explicit duplicate review and two distinct contacts, revisions and an operator reason', () => {
    const input = {
      requestId: A,
      sourceContactId: A,
      targetContactId: B,
      sourceExpectedRevision: 1,
      targetExpectedRevision: 3,
      confirmed: true,
      reason: 'Reviewed original submissions',
    };
    expect(crmMergeInputSchema.safeParse(input).success).toBe(true);
    for (const changed of [
      { confirmed: false },
      { reason: ' ' },
      { targetContactId: A.toUpperCase() },
      { sourceExpectedRevision: 0 },
      { actorUserId: A },
    ])
      expect(crmMergeInputSchema.safeParse({ ...input, ...changed }).success).toBe(false);
  });
  it('refuses unsafe revisions and actor injection into campaign commands', () => {
    const input = {
      requestId: A,
      id: B,
      expectedRevision: 0,
      name: 'Deck',
      channel: 'deck',
      status: 'active',
      documentRef: null,
      providerLinkId: null,
      reason: 'New outreach campaign',
    };
    expect(crmCampaignWriteInputSchema.safeParse(input).success).toBe(true);
    expect(crmCampaignWriteInputSchema.safeParse({ ...input, expectedRevision: 9007199254740992 }).success).toBe(false);
    expect(crmCampaignWriteInputSchema.safeParse({ ...input, actorUserId: A }).success).toBe(false);
  });
  it('represents unavailable provider analytics separately from an entitled empty page', () => {
    expect(crmDocumentProviderReadResultSchema.parse({ status: 'unavailable', reason: 'api_access_unavailable' })).toEqual({
      status: 'unavailable',
      reason: 'api_access_unavailable',
    });
    expect(
      crmDocumentProviderReadResultSchema.safeParse({ status: 'unavailable', reason: 'api_access_unavailable', items: [] }).success,
    ).toBe(false);
    expect(crmDocumentProviderReadResultSchema.safeParse({ status: 'page', items: [], nextCursor: null }).success).toBe(true);
  });
  const interaction = {
    requestId: A,
    opportunityId: B,
    expectedRevision: 2,
    occurredAt: NOW,
    nextAction: { description: 'Check in after the weekend', dueAt: '2026-10-14T09:00:00.000Z' },
    reason: 'Replied from Gmail',
  };
  it('records a reply sent outside the console, with an evidence reference that is optional for this kind only', () => {
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'reply_sent' }).success).toBe(true);
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'reply_sent', evidenceRef: 'gmail-thread-18f2' }).success).toBe(
      true,
    );
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'reply_sent', evidenceRef: '' }).success).toBe(false);
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'reply_sent', evidenceRef: 'x'.repeat(129) }).success).toBe(false);
    // The other kinds still need evidence, and a reply still needs a reason and a next step.
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'follow_up' }).success).toBe(false);
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'call_invited' }).success).toBe(false);
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'reply_sent', reason: undefined }).success).toBe(false);
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'reply_sent', nextAction: undefined }).success).toBe(false);
    expect(crmInteractionInputSchema.safeParse({ ...interaction, kind: 'reply_sent', actorUserId: A }).success).toBe(false);
  });
  it('lets only a reply be stored without evidence', () => {
    const stored = {
      id: A,
      opportunityId: B,
      kind: 'reply_sent',
      actorUserId: A,
      status: 'manually_recorded',
      evidenceRef: null,
      occurredAt: NOW,
      recordedAt: NOW,
      scheduledAt: null,
    };
    expect(crmInteractionSchema.safeParse(stored).success).toBe(true);
    expect(crmInteractionSchema.safeParse({ ...stored, kind: 'follow_up' }).success).toBe(false);
    expect(crmInteractionSchema.safeParse({ ...stored, kind: 'follow_up', evidenceRef: 'call-note' }).success).toBe(true);
  });
  it('knows the commitment_changed audit kind', () => {
    const audit = {
      id: A,
      requestId: B,
      actorUserId: A,
      subjectType: 'opportunity',
      subjectId: B,
      kind: 'commitment_changed',
      reason: 'Documents signed',
      occurredAt: NOW,
      facts: {},
    };
    expect(crmWorkflowAuditSchema.safeParse(audit).success).toBe(true);
    expect(crmWorkflowAuditSchema.safeParse({ ...audit, kind: 'commitment_deleted' }).success).toBe(false);
  });
  it('lets a total label any three-letter currency a visitor stated, and sums longer than one amount', () => {
    const counts = { indicated: 1, softCircled: 0, committed: 0, undecided: 0 };
    const raise = (indicated: unknown) => crmRaiseSchema.safeParse({ indicated, softCircled: [], committed: [], counts }).success;
    for (const currency of ['XCG', 'HRK', 'CUC', 'SLL', 'ZWL', 'XDR', 'XSU', 'BTC', 'ZZZ'])
      expect(raise([{ currency, amount: '5' }]), currency).toBe(true);
    for (const currency of ['eur', 'EU', 'EURO', '', 'E1R']) expect(raise([{ currency, amount: '5' }]), currency).toBe(false);
    // Two 60-digit amounts sum to 61 digits; a total of many amounts may be much longer than one.
    expect(raise([{ currency: 'EUR', amount: '1'.repeat(61) }])).toBe(true);
    expect(raise([{ currency: 'EUR', amount: '1'.repeat(120) }])).toBe(true);
    expect(raise([{ currency: 'EUR', amount: '1'.repeat(121) }])).toBe(false);
    expect(raise([{ currency: 'EUR', amount: '1e6' }])).toBe(false);
    // More than 60 distinct currencies, up to every possible three-letter code.
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        currency: String.fromCharCode(65 + (i % 26), 65 + (Math.floor(i / 26) % 26), 65 + Math.floor(i / 676)),
        amount: '1',
      }));
    expect(raise(many(61))).toBe(true);
    expect(raise(many(600))).toBe(true);
    expect(raise(many(17576))).toBe(true);
    expect(raise([...many(17576), { currency: 'AAA', amount: '1' }])).toBe(false);
  });
  it('totals the raise per currency as exact decimal strings, with people counted separately', () => {
    const raise = {
      indicated: [
        { currency: 'EUR', amount: '1000000.5' },
        { currency: 'USD', amount: '50000' },
      ],
      softCircled: [{ currency: 'EUR', amount: '250000' }],
      committed: [{ currency: 'EUR', amount: '100000' }],
      counts: { indicated: 3, softCircled: 1, committed: 1, undecided: 2 },
    };
    expect(crmRaiseSchema.parse(raise)).toEqual(raise);
    expect(crmRaiseSchema.safeParse({ ...raise, indicated: [{ currency: 'EUR', amount: 1000000 }] }).success).toBe(false);
    expect(crmRaiseSchema.safeParse({ ...raise, indicated: [{ currency: 'EUR', amount: '-1' }] }).success).toBe(false);
    expect(crmRaiseSchema.safeParse({ ...raise, indicated: [{ currency: 'EUR', amount: '1e6' }] }).success).toBe(false);
    expect(crmRaiseSchema.safeParse({ ...raise, converted: { currency: 'EUR', amount: '1' } }).success).toBe(false);
    const metrics = {
      observedAt: NOW,
      totals: {
        opportunities: 0,
        submissions: 0,
        canonicalContacts: 0,
        incompleteSubmissions: 0,
        overdueTasks: 0,
        manualCallInvitations: 0,
        manualCallBookings: 0,
      },
      byAudience: [],
      byStage: [],
      bySource: [],
      sourceGroupsTruncated: false,
      raise,
    };
    expect(crmMetricsSchema.safeParse(metrics).success).toBe(true);
    expect(crmMetricsSchema.safeParse({ ...metrics, raise: undefined }).success).toBe(false);
  });
});

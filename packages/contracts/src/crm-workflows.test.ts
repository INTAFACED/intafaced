import { describe, expect, it } from 'vitest';
import {
  crmAttributionSchema,
  crmExportInputSchema,
  crmMergeInputSchema,
  crmMetricsInputSchema,
  crmCampaignWriteInputSchema,
  crmDocumentProviderReadResultSchema,
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
});

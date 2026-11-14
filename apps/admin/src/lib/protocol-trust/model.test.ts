import { describe, expect, it } from 'vitest';
import type { ProtocolComplianceReport } from '@intafaced/contracts/protocol-address-risk';
import {
  TRUST_TABS,
  TRUST_TAB_WAITS,
  missingItemWords,
  pendingReview,
  publishedWords,
  reportWords,
  tierWords,
  trustRefusalWords,
} from './model';

const report = (over: Partial<ProtocolComplianceReport> = {}): ProtocolComplianceReport => ({
  id: '00000000-0000-4000-8000-000000000001',
  chainId: 84532,
  address: '0x00000000000000000000000000000000000ba5e0',
  kind: 'phishing',
  reporterId: 'r',
  note: 'TEST phishing report',
  evidenceUrl: null,
  status: 'open',
  duplicatesRefused: 0,
  createdAt: '2026-11-12T00:00:00.000Z',
  reviews: [],
  ...over,
});
const review = (status: 'pending' | 'published') => ({
  id: '00000000-0000-4000-9000-000000000001',
  kind: 'phishing' as const,
  reason: 'TEST',
  status,
  requesterId: 'a',
  approverId: status === 'published' ? 'b' : null,
  askedAt: '2026-11-12T00:00:00.000Z',
  decidedAt: status === 'published' ? '2026-11-12T00:01:00.000Z' : null,
});

describe('protocol trust desk words', () => {
  it('says a refused duplicate only when there was one', () => {
    expect(reportWords(report())).toBeNull();
    expect(reportWords(report({ duplicatesRefused: 1 }))).toBe('Duplicate from the same reporter refused once');
    expect(reportWords(report({ duplicatesRefused: 3 }))).toBe('Duplicate from the same reporter refused 3 times');
  });
  it('reads the pending review and the published labels', () => {
    expect(pendingReview(report({ reviews: [review('pending')] }))?.status).toBe('pending');
    expect(pendingReview(report({ reviews: [review('published')] }))).toBeNull();
    expect(publishedWords(report({ reviews: [review('published')] }))).toEqual(['Public: phishing. Why: TEST']);
  });
  it('names what every unbuilt tab waits for, and words each refusal', () => {
    for (const tab of Object.keys(TRUST_TAB_WAITS)) expect(TRUST_TABS).toContain(tab);
    expect(trustRefusalWords('protocol.compliance.same_reviewer')).toMatch(/different person/);
    expect(trustRefusalWords('protocol.other')).toBeNull();
    expect(trustRefusalWords(null)).toBeNull();
  });
  it('shows a human tier only once approved, with its day, and a pending change after the tier in force', () => {
    const pending = { id: 'p', tier: 'verified' as const, reason: 'TEST', requesterId: 'a', askedAt: '2026-11-13T00:00:00.000Z' };
    expect(tierWords(null)).toBe('unknown');
    expect(tierWords({ tier: null, since: null, pending })).toBe('unknown · verified pending');
    expect(tierWords({ tier: 'verified', since: '2026-11-13T05:00:00.000Z', pending: null })).toBe('verified · since 13 Nov 2026');
    expect(tierWords({ tier: 'verified', since: '2026-11-13T05:00:00.000Z', pending: { ...pending, tier: 'banned' } })).toBe(
      'verified · since 13 Nov 2026 · banned pending',
    );
  });
  it('names each blank checklist item', () => {
    expect(missingItemWords(['checkerAddress'])).toEqual(['Checker address missing']);
    expect(TRUST_TAB_WAITS['Token tiers']).toBeUndefined();
    expect(TRUST_TAB_WAITS['Permissioned pools']).toBeUndefined();
  });
});

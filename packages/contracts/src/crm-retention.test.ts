import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  crmErasureStatusSchema,
  crmRetentionReviewInputSchema,
  crmRetentionReviewSchema,
  crmRetentionStatusSchema,
} from './crm-privacy.js';

describe('approved outreach retention boundaries', () => {
  const reviewedAt = '2026-10-11T00:00:00.000Z';
  const review = {
    reviewId: randomUUID(),
    canonicalContactId: randomUUID(),
    revision: 1,
    state: 'active',
    reviewedBy: randomUUID(),
    reviewedAt,
    expiresAt: '2026-11-10T00:00:00.000Z',
    evidenceRef: 'discussion:1',
    reason: 'Discussion remains active',
  };
  it('separates configured policy from actual automation and sweep evidence', () => {
    expect(crmRetentionStatusSchema.parse({ status: 'disabled', reason: 'published_policy_unconfigured' }).status).toBe('disabled');
    const configured = {
      status: 'configured',
      inactivityCalendarMonths: 6,
      clockTimeZone: 'UTC',
      activeReviewMaxDays: 30,
      automationEnabled: false,
      lastSweepAt: null,
    };
    expect(crmRetentionStatusSchema.parse(configured)).toEqual(configured);
    for (const changed of [
      { ...configured, inactivityCalendarMonths: 180 },
      { ...configured, clockTimeZone: 'Europe/London' },
      { ...configured, activeReviewMaxDays: 365 },
    ])
      expect(crmRetentionStatusSchema.safeParse(changed).success).toBe(false);
  });
  it('bounds an active review and forbids an inactive exemption', () => {
    expect(crmRetentionReviewSchema.safeParse(review).success).toBe(true);
    expect(crmRetentionReviewSchema.safeParse({ ...review, state: 'inactive', expiresAt: null }).success).toBe(true);
    for (const changed of [
      { ...review, expiresAt: null },
      { ...review, expiresAt: reviewedAt },
      { ...review, expiresAt: '2026-11-10T00:00:00.001Z' },
      { ...review, state: 'inactive' },
    ])
      expect(crmRetentionReviewSchema.safeParse(changed).success).toBe(false);
  });
  it('requires current revisions and evidence while refusing caller-supplied actor or expiry', () => {
    const input = {
      requestId: randomUUID(),
      canonicalContactId: review.canonicalContactId,
      expectedCanonicalRevision: 2,
      expectedReviewRevision: 0,
      state: 'active',
      evidenceRef: 'discussion:1',
      reason: 'Ongoing',
    };
    expect(crmRetentionReviewInputSchema.safeParse(input).success).toBe(true);
    for (const changed of [
      { ...input, reviewedBy: review.reviewedBy },
      { ...input, expiresAt: review.expiresAt },
      { ...input, expectedReviewRevision: -1 },
      { ...input, evidenceRef: '' },
      { ...input, expectedCanonicalRevision: 0 },
    ])
      expect(crmRetentionReviewInputSchema.safeParse(changed).success).toBe(false);
  });
  it('keeps legacy founder intent attribution and distinguishes the actual system actor', () => {
    const intent = {
      intentId: randomUUID(),
      canonicalContactId: review.canonicalContactId,
      revision: 1,
      status: 'pending_notify',
      requestedBy: review.reviewedBy,
      requestedAt: reviewedAt,
      completedAt: null,
      pendingSubmissionCount: 1,
      code: null,
    };
    expect(crmErasureStatusSchema.parse(intent).actorKind).toBe('founder');
    expect(crmErasureStatusSchema.parse({ ...intent, actorKind: 'system', requestedBy: null }).actorKind).toBe('system');
    expect(crmErasureStatusSchema.safeParse({ ...intent, requestedBy: null }).success).toBe(false);
    expect(crmErasureStatusSchema.safeParse({ ...intent, actorKind: 'system' }).success).toBe(false);
  });
});

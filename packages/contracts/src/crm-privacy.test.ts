import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  crmErasureBeginInputSchema,
  crmErasurePreviewInputSchema,
  crmErasureStatusInputSchema,
  crmErasureStatusSchema,
} from './crm-privacy.js';

describe('strict founder cluster erasure contracts', () => {
  it('recovers saved intents by exactly one internal identifier, without contact details', () => {
    const intentId = randomUUID(),
      canonicalContactId = randomUUID();
    expect(crmErasureStatusInputSchema.parse({ intentId })).toEqual({ intentId });
    expect(crmErasureStatusInputSchema.parse({ canonicalContactId })).toEqual({ canonicalContactId });
    for (const value of [
      {},
      { intentId, canonicalContactId },
      { email: 'private@example.test' },
      { canonicalContactId, actor: randomUUID() },
    ])
      expect(crmErasureStatusInputSchema.safeParse(value).success).toBe(false);
  });
  it('requires whole-cluster confirmation and a reviewed snapshot, never an email identity', () => {
    const value = {
      requestId: randomUUID(),
      canonicalContactId: randomUUID(),
      expectedCanonicalRevision: 2,
      snapshot: 'a'.repeat(64),
      confirmedEntireCluster: true,
      reason: 'confirmed_privacy_request',
    };
    expect(crmErasureBeginInputSchema.safeParse(value).success).toBe(true);
    for (const changed of [
      { ...value, confirmedEntireCluster: false },
      { ...value, snapshot: '' },
      { ...value, email: 'private@example.test' },
    ])
      expect(crmErasureBeginInputSchema.safeParse(changed).success).toBe(false);
    expect(crmErasurePreviewInputSchema.safeParse({ email: 'private@example.test' }).success).toBe(false);
  });
  it('cannot label missing notify erasure evidence as completed', () => {
    const complete = {
      intentId: randomUUID(),
      canonicalContactId: randomUUID(),
      revision: 3,
      status: 'complete',
      requestedBy: randomUUID(),
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      pendingSubmissionCount: 0,
      code: null,
    };
    expect(crmErasureStatusSchema.safeParse(complete).success).toBe(true);
    for (const changed of [
      { ...complete, pendingSubmissionCount: 1 },
      { ...complete, completedAt: null },
      { ...complete, code: 'ops.crm.notification_erasure_unknown' },
    ])
      expect(crmErasureStatusSchema.safeParse(changed).success).toBe(false);
  });
});

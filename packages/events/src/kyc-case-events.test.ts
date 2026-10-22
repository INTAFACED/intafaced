import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './catalog.js';

const uid = () => crypto.randomUUID();
const ts = () => new Date().toISOString();

describe('I-kyc-compliance-01 KYC case events', () => {
  it('declares the subjects beside kycApproved', () => {
    expect(EVENT_CATALOG.kycSubmitted.subject).toBe('intafaced.identity.kyc.submitted');
    expect(EVENT_CATALOG.kycRejected.subject).toBe('intafaced.identity.kyc.rejected');
    expect(EVENT_CATALOG.kycInfoRequested.subject).toBe('intafaced.identity.kyc_info.requested');
  });

  it('refuses a reject without a reason code', () => {
    const base = { userId: uid(), caseId: uid(), version: 2, reasonCode: 'doc_blurry', rejectedAt: ts() };
    expect(EVENT_CATALOG.kycRejected.schema.safeParse(base).success).toBe(true);
    const { reasonCode: _c, ...noCode } = base;
    expect(EVENT_CATALOG.kycRejected.schema.safeParse(noCode).success).toBe(false);
    expect(EVENT_CATALOG.kycRejected.schema.safeParse({ ...base, reasonCode: '' }).success).toBe(false);
  });

  it('refuses version 0 and a non-uuid previous case', () => {
    const base = { userId: uid(), caseId: uid(), version: 1, previousCaseId: null, submittedAt: ts() };
    expect(EVENT_CATALOG.kycSubmitted.schema.safeParse({ ...base, version: 0 }).success).toBe(false);
    expect(EVENT_CATALOG.kycSubmitted.schema.safeParse({ ...base, previousCaseId: 'old' }).success).toBe(false);
    expect(EVENT_CATALOG.kycSubmitted.schema.safeParse({ ...base, previousCaseId: uid() }).success).toBe(true);
  });

  it('carries no customer note or document on the bus', () => {
    const parsed = EVENT_CATALOG.kycInfoRequested.schema.parse({
      userId: uid(),
      caseId: uid(),
      version: 2,
      reasonCode: 'need_address',
      requestedAt: ts(),
      customerNote: 'private',
    });
    expect(parsed).not.toHaveProperty('customerNote');
  });
});

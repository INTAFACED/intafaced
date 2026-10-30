import { describe, expect, it } from 'vitest';
import { payloadHash } from '../admin/common.js';
import { leadApprovalPayload } from './lead-applications.js';

describe('lead approval payload', () => {
  // The same vector is pinned in apps/admin/src/lib/trade-ops/copy-lead.test.ts: the console files the approval with
  // this hash and svc-trade recomputes it on confirm, so both must agree byte for byte.
  it('hashes the application, the name and the criteria', () => {
    const input = { applicationId: '55555555-5555-4555-8555-555555555555', displayName: 'TEST lead', minTrackRecordDays: 30 };
    expect(payloadHash(leadApprovalPayload(input))).toBe('sha256:fd978f4c6658cd9c150d2288f77639d25a36bee02de2c72a5247ba15b111f39f');
    expect(payloadHash(leadApprovalPayload({ ...input, minTrackRecordDays: 7 }))).not.toBe(payloadHash(leadApprovalPayload(input)));
  });
});

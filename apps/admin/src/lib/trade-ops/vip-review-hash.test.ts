import { describe, expect, it } from 'vitest';
import { vipReviewPayloadHash, vipTrialGrantPayloadHash } from './vip-review-hash';

// The same vectors are pinned in services/svc-trade/src/admin/vip-review.test.ts: svc-trade recomputes these hashes
// when a decision is applied, so the console and the service must agree byte for byte.
const APPLICATION = '55555555-5555-4555-8555-555555555555';
const REASON = 'TEST statement checked against the venue';
const TRIAL = { tierId: 'test-vip-1', days: 30 };

describe('VIP approval hashes', () => {
  it('match svc-trade for an approval, a rejection and a trial grant', () => {
    expect(vipReviewPayloadHash({ applicationId: APPLICATION, decision: 'approve', reason: REASON, trial: TRIAL })).toBe(
      'sha256:f340afb02be7d0797824dd75c7678d2cffa9ac246cb1c43de5d37fad25a66916',
    );
    // A rejection binds no trial, whatever is published.
    expect(vipReviewPayloadHash({ applicationId: APPLICATION, decision: 'reject', reason: REASON, trial: TRIAL })).toBe(
      'sha256:31253482667c472e5415384d9aa70430e776047c578bcd4ad06f0b1177050ab9',
    );
    expect(vipTrialGrantPayloadHash({ applicationId: APPLICATION, reason: REASON, trial: TRIAL })).toBe(
      'sha256:ecfec30da49b388c5b5b19d789dd758a74adda536e6ccc5f6a5e2ca75699991d',
    );
  });

  it('changes with the trial an approval would grant', () => {
    const base = { applicationId: APPLICATION, decision: 'approve' as const, reason: REASON };
    expect(vipReviewPayloadHash({ ...base, trial: null })).not.toBe(vipReviewPayloadHash({ ...base, trial: TRIAL }));
    expect(vipReviewPayloadHash({ ...base, trial: { ...TRIAL, days: 31 } })).not.toBe(vipReviewPayloadHash({ ...base, trial: TRIAL }));
  });
});

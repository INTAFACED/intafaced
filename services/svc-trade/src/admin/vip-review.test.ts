import { describe, expect, it } from 'vitest';
import { payloadHash } from './common.js';
import { vipReviewPayload, vipTrialGrantPayload } from './vip-review.js';

// The founder console computes the same hashes (apps/admin/src/lib/trade-ops/vip-review-hash.test.ts pins the same
// vectors): an approval it files must be the one this door recomputes when the decision is applied.
const APPLICATION = '55555555-5555-4555-8555-555555555555';
const REASON = 'TEST statement checked against the venue';
const TRIAL = { tierId: 'test-vip-1', days: 30 };

describe('VIP approval payloads', () => {
  it('hash to the vectors the console uses', () => {
    expect(payloadHash(vipReviewPayload({ applicationId: APPLICATION, decision: 'approve', reason: REASON, trial: TRIAL }))).toBe(
      'sha256:f340afb02be7d0797824dd75c7678d2cffa9ac246cb1c43de5d37fad25a66916',
    );
    expect(payloadHash(vipReviewPayload({ applicationId: APPLICATION, decision: 'reject', reason: REASON, trial: TRIAL }))).toBe(
      'sha256:31253482667c472e5415384d9aa70430e776047c578bcd4ad06f0b1177050ab9',
    );
    expect(payloadHash(vipTrialGrantPayload({ applicationId: APPLICATION, reason: REASON, trial: TRIAL }))).toBe(
      'sha256:ecfec30da49b388c5b5b19d789dd758a74adda536e6ccc5f6a5e2ca75699991d',
    );
  });
});

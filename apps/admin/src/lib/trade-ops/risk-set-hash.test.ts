import { describe, expect, it } from 'vitest';
import { riskSetPayloadHash } from './risk-set-hash';

describe('riskSetPayloadHash', () => {
  it('matches the hash svc-trade computes for the same change (vector taken from its payloadHash)', () => {
    expect(
      riskSetPayloadHash({
        market: 'a1b2c3d4-0000-4000-8000-000000000001',
        limits: { collar: '0.05', fatFinger: null, slippageCap: '100', throttle: null, circuitBreaker: null },
        expectedVersion: '2',
        reason: 'tighten after incident 4471',
      }),
    ).toBe('sha256:7858ae9d70b104e67eb6d64009fb753fb237bae29a00216bd5eb26e8b0bb57ec');
  });

  it('changes when any limit, the version or the reason changes', () => {
    const base = {
      market: 'm',
      limits: { collar: null, fatFinger: null, slippageCap: null, throttle: null, circuitBreaker: null },
      expectedVersion: '0',
      reason: 'a reason here',
    };
    const h = riskSetPayloadHash(base);
    expect(riskSetPayloadHash({ ...base, limits: { ...base.limits, throttle: '5' } })).not.toBe(h);
    expect(riskSetPayloadHash({ ...base, expectedVersion: '1' })).not.toBe(h);
    expect(riskSetPayloadHash({ ...base, reason: 'another reason' })).not.toBe(h);
  });
});

import { describe, expect, it } from 'vitest';
import { founderMerchantSectionSchema } from './founder-admin.js';

const MERCHANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function profile(current: Record<string, unknown>) {
  return {
    section: 'profile' as const,
    current: {
      merchantId: MERCHANT,
      displayName: 'TEST DATA Merchant',
      legalName: null,
      status: 'active' as const,
      mode: 'gateway' as const,
      kybStatus: 'approved' as const,
      kybRef: null,
      ...current,
    },
    items: [],
    nextCursor: null,
  };
}

describe('founder merchant profile fee', () => {
  it('accepts a stored fee beside a local-test starter fee', () => {
    const parsed = founderMerchantSectionSchema.parse(profile({ feeBps: 250, starterFee: { bps: 250, source: 'local_test' } }));
    expect(parsed).toMatchObject({
      section: 'profile',
      current: { feeBps: 250, starterFee: { bps: 250, source: 'local_test' } },
    });
  });

  it('accepts an explicit zero and null when the fee is unset', () => {
    expect(founderMerchantSectionSchema.parse(profile({ feeBps: 0, starterFee: null }))).toMatchObject({
      current: { feeBps: 0, starterFee: null },
    });
    expect(founderMerchantSectionSchema.parse(profile({ feeBps: null, starterFee: null }))).toMatchObject({
      current: { feeBps: null, starterFee: null },
    });
  });

  it('rejects a missing fee, a fractional fee, and a starter fee that is not local_test', () => {
    expect(founderMerchantSectionSchema.safeParse(profile({ starterFee: { bps: 250, source: 'local_test' } })).success).toBe(false);
    expect(founderMerchantSectionSchema.safeParse(profile({ feeBps: 1.5, starterFee: null })).success).toBe(false);
    expect(founderMerchantSectionSchema.safeParse(profile({ feeBps: 250, starterFee: { bps: 250, source: 'intafaced' } })).success).toBe(
      false,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { MEMBERSHIP_NOT_OFFERED, membershipOffer, parseMembershipTiers } from './membership-offer.js';

const tier = { id: 'plus', name: 'Plus', price: '9.99', assetId: 'USD', periodDays: 30, perks: ['Lower fees'] };

describe('membership owner config', () => {
  it('reads blank as not offered, never a default tier', () => {
    expect(parseMembershipTiers(undefined)).toEqual([]);
    expect(parseMembershipTiers('  ')).toEqual([]);
    expect(membershipOffer([])).toEqual({ offered: false, code: MEMBERSHIP_NOT_OFFERED });
  });

  it('shows the owner tiers when set, with the price kept as a decimal string', () => {
    const tiers = parseMembershipTiers(JSON.stringify([{ ...tier, price: '0.000000000000000001' }]));
    const offer = membershipOffer(tiers);
    expect(offer).toEqual({ offered: true, tiers: [{ ...tier, price: '0.000000000000000001' }], current: null });
  });

  it('refuses malformed JSON, a numeric price, a blank name, extra keys and repeated ids', () => {
    expect(() => parseMembershipTiers('{')).toThrow('JSON list');
    expect(() => parseMembershipTiers(JSON.stringify([{ ...tier, price: 9.99 }]))).toThrow('invalid');
    expect(() => parseMembershipTiers(JSON.stringify([{ ...tier, name: '' }]))).toThrow('invalid');
    expect(() => parseMembershipTiers(JSON.stringify([{ ...tier, bonus: 1 }]))).toThrow('invalid');
    expect(() => parseMembershipTiers(JSON.stringify([{ ...tier, price: '' }]))).toThrow('invalid');
    expect(() => parseMembershipTiers(JSON.stringify([tier, tier]))).toThrow('repeated');
  });
});

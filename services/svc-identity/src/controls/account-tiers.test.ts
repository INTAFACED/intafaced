import { describe, expect, it } from 'vitest';
import { blankTierTerms, parseAccountTiers } from './account-tiers.js';

const terms = { ratePercent: '1.5', monthlyFee: '4.99', feeAssetId: 'USD', dailyLimit: '1000', clearingDays: '2' };

describe('parseAccountTiers', () => {
  it('is unset when blank, not JSON, empty, invalid or repeated', () => {
    for (const raw of [undefined, '', '  ', 'standard', '[]', '{}', JSON.stringify([{ id: 'Standard', name: 'x', terms }])])
      expect(parseAccountTiers(raw)).toBeUndefined();
    const one = { id: 'standard', name: 'Standard', terms };
    expect(parseAccountTiers(JSON.stringify([one, one]))).toBeUndefined();
    expect(parseAccountTiers(JSON.stringify([{ ...one, terms: { ...terms, monthlyFee: 4.99 } }]))).toBeUndefined();
    expect(parseAccountTiers(JSON.stringify([{ ...one, terms: { ...terms, extra: '1' } }]))).toBeUndefined();
    expect(parseAccountTiers(JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ ...one, id: `t${i}` }))))).toBeUndefined();
  });
  it('keeps a tier with blank terms, and names them', () => {
    const tiers = parseAccountTiers(
      JSON.stringify([
        { id: 'standard', name: 'Standard', terms },
        { id: 'plus', name: 'Plus', terms: { ...terms, monthlyFee: null, clearingDays: null } },
      ]),
    );
    expect(tiers?.map((tier) => tier.id)).toEqual(['standard', 'plus']);
    expect(blankTierTerms(tiers![0]!.terms)).toEqual([]);
    expect(blankTierTerms(tiers![1]!.terms)).toEqual(['monthlyFee', 'clearingDays']);
  });
});

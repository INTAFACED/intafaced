import { describe, expect, it } from 'vitest';
import { REFERENCE_RAIL_ROUTING_PROFILES } from './decide.js';
import { parseCheckoutSuccessRates, withSuccessRates } from './success-rates-env.js';

describe('PAY_CHECKOUT_SUCCESS_RATES', () => {
  const parse = (raw: string | undefined) => parseCheckoutSuccessRates(raw, REFERENCE_RAIL_ROUTING_PROFILES);

  it('declares nothing when blank, so every rail keeps no rate', () => {
    expect(parse(undefined)).toEqual({});
    expect(parse('  ')).toEqual({});
    expect(withSuccessRates(REFERENCE_RAIL_ROUTING_PROFILES, {}).every((p) => p.successRate === undefined)).toBe(true);
  });

  it('lays each declared fraction on its rail only', () => {
    const rates = parse(' crypto-native:0.97 ');
    expect(rates).toEqual({ 'crypto-native': '0.97' });
    const profiles = withSuccessRates(REFERENCE_RAIL_ROUTING_PROFILES, rates);
    expect(profiles.find((p) => p.railId === 'crypto-native')?.successRate).toBe('0.97');
    expect(profiles.find((p) => p.railId === 'card-sandbox')?.successRate).toBeUndefined();
    // The reference profiles are not changed.
    expect(REFERENCE_RAIL_ROUTING_PROFILES.every((p) => p.successRate === undefined)).toBe(true);
    expect(parse('crypto-native:1,card-sandbox:0.5')).toEqual({ 'crypto-native': '1', 'card-sandbox': '0.5' });
  });

  it('fails boot on a typo rather than reading it as no rate or as a rate nobody declared', () => {
    for (const bad of [
      'crypto-native',
      'crypto-native:',
      ':0.9',
      'crypto-native:0',
      'crypto-native:1.5',
      'crypto-native:97%',
      'crypto-native:0.9,crypto-native:0.8',
      'bank-payout:0.9',
    ]) {
      expect(() => parse(bad), bad).toThrow(/PAY_CHECKOUT_SUCCESS_RATES/);
    }
  });
});

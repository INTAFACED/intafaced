import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { parseVerificationLimits, verificationBuyRefusal, type ActiveVerificationLimits } from './verification-limits.js';

const row = { orderMin: '10', orderMax: '40', dailyMax: '50', lifetimeMax: '80' };

function active(patch?: Record<string, unknown>): ActiveVerificationLimits {
  const parsed = parseVerificationLimits({
    currency: 'usd',
    tiers: { none: row, basic: row, full: row, institutional: row },
    ...patch,
  });
  if (parsed.status !== 'active') throw new Error(parsed.status);
  return parsed;
}

describe('verification limit table (P-disputes-security-15)', () => {
  it('treats blank as absent and refuses a partial table, a JSON number, and an extra tier', () => {
    expect(parseVerificationLimits(undefined).status).toBe('absent');
    expect(parseVerificationLimits('').status).toBe('absent');
    expect(parseVerificationLimits('  ').status).toBe('absent');
    expect(parseVerificationLimits('{').status).toBe('invalid');
    expect(
      parseVerificationLimits({
        currency: 'USD',
        tiers: { basic: { orderMin: '0', orderMax: '1', dailyMax: '1', lifetimeMax: '1' } },
      }).status,
    ).toBe('invalid');
    expect(
      parseVerificationLimits({
        currency: 'USD',
        tiers: {
          none: { orderMin: '0', orderMax: 1, dailyMax: '1', lifetimeMax: '1' },
          basic: row,
          full: row,
          institutional: row,
        },
      }).status,
    ).toBe('invalid');
    expect(
      parseVerificationLimits({
        currency: 'USD',
        tiers: { none: row, basic: row, full: row, institutional: row, guessed: row },
      }).status,
    ).toBe('invalid');
    expect(parseVerificationLimits({ currency: 'US', tiers: {} }).status).toBe('invalid');
  });

  it('keeps decimal strings and does not apply a cap in another fiat', () => {
    const config = active();
    expect(config.currency).toBe('USD');
    expect(config.tiers.basic.orderMax).toBe(parseAmount('40'));
    const base = { tier: 'basic', fiatAmount: parseAmount('20'), dailyUsed: parseAmount('0'), lifetimeUsed: parseAmount('0') };
    expect(verificationBuyRefusal(config, { ...base, fiatCurrency: 'USD' })).toBeNull();
    expect(verificationBuyRefusal(config, { ...base, fiatCurrency: 'EUR' })).toBe('p2p.verification_limit_currency');
    expect(verificationBuyRefusal(config, { ...base, fiatCurrency: 'USD', fiatAmount: parseAmount('9') })).toBe(
      'p2p.verification_order_min',
    );
    expect(verificationBuyRefusal(config, { ...base, fiatCurrency: 'USD', fiatAmount: parseAmount('41') })).toBe(
      'p2p.verification_order_max',
    );
    expect(verificationBuyRefusal(config, { ...base, fiatCurrency: 'USD', dailyUsed: parseAmount('40') })).toBe(
      'p2p.verification_daily_limit',
    );
    expect(verificationBuyRefusal(config, { ...base, fiatCurrency: 'USD', lifetimeUsed: parseAmount('70') })).toBe(
      'p2p.verification_lifetime_limit',
    );
    expect(verificationBuyRefusal(config, { ...base, tier: undefined, fiatCurrency: 'USD' })).toBe('p2p.verification_level_unwired');
    expect(verificationBuyRefusal({ status: 'absent' }, { ...base, fiatCurrency: 'NGN' })).toBeNull();
    expect(verificationBuyRefusal({ status: 'invalid' }, { ...base, fiatCurrency: 'USD' })).toBe('p2p.verification_limits_invalid');
  });
});

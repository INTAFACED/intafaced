import { describe, expect, it } from 'vitest';
import { parseKycAttemptLimit } from './attempts.js';

describe('parseKycAttemptLimit (I-kyc-compliance-10)', () => {
  it('all three unset or blank is no limit', () => {
    expect(parseKycAttemptLimit({})).toBeNull();
    expect(
      parseKycAttemptLimit({ IDENTITY_KYC_MAX_DENIALS: ' ', IDENTITY_KYC_DENIAL_WINDOW_HOURS: '', IDENTITY_KYC_LOCKOUT_HOURS: '' }),
    ).toBeNull();
  });

  it('reads the three together', () => {
    expect(
      parseKycAttemptLimit({ IDENTITY_KYC_MAX_DENIALS: '2', IDENTITY_KYC_DENIAL_WINDOW_HOURS: '24', IDENTITY_KYC_LOCKOUT_HOURS: '1' }),
    ).toEqual({
      maxDenials: 2,
      windowHours: 24,
      lockoutHours: 1,
    });
  });

  it('half a limit, or a malformed one, stops the service', () => {
    expect(() => parseKycAttemptLimit({ IDENTITY_KYC_MAX_DENIALS: '2' })).toThrow(/set together or not at all/);
    for (const bad of ['0', '-1', '1.5', 'two', '1e3', '101'])
      expect(() =>
        parseKycAttemptLimit({ IDENTITY_KYC_MAX_DENIALS: bad, IDENTITY_KYC_DENIAL_WINDOW_HOURS: '24', IDENTITY_KYC_LOCKOUT_HOURS: '1' }),
      ).toThrow(/IDENTITY_KYC_MAX_DENIALS must be a whole number/);
    expect(() =>
      parseKycAttemptLimit({ IDENTITY_KYC_MAX_DENIALS: '2', IDENTITY_KYC_DENIAL_WINDOW_HOURS: '8761', IDENTITY_KYC_LOCKOUT_HOURS: '1' }),
    ).toThrow(/IDENTITY_KYC_DENIAL_WINDOW_HOURS/);
  });
});

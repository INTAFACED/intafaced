import { describe, expect, it } from 'vitest';
import {
  disabledAnswer,
  isProof,
  isSixDigits,
  replacedAnswer,
  replaceStarted,
  stepUpBeginInput,
  stepUpProof,
  totpStatus,
} from './authenticator-api';

describe('authenticator answers and step-up request', () => {
  it('names the door the service guards, with the request id as its only field and its target', () => {
    expect(stepUpBeginInput('identity.step_up.totp_disable', 'req-1')).toEqual({
      scope: 'identity.step_up.totp_disable',
      purpose: 'account.totp.disable',
      target: 'req-1',
      fields: { clientRequestId: 'req-1' },
    });
    expect(stepUpBeginInput('identity.step_up.totp_replace', 'r').purpose).toBe('account.totp.replace');
  });

  it('reads the service answers and refuses a malformed one', () => {
    expect(totpStatus.safeParse({ enabled: true, label: null, enrolledAt: null, recoveryCodesLeft: 3 }).success).toBe(true);
    expect(totpStatus.safeParse({ enabled: true, label: null, enrolledAt: null, recoveryCodesLeft: -1 }).success).toBe(false);
    expect(disabledAnswer.safeParse({ disabled: true, recoveryCodeSpent: true }).success).toBe(true);
    expect(disabledAnswer.safeParse({ disabled: false, recoveryCodeSpent: false }).success).toBe(false);
    expect(
      replacedAnswer.safeParse({ replaced: true, recoveryCodeSpent: false, recoveryCodes: ['ABCDE-12345'], sessionsEnded: 1 }).success,
    ).toBe(true);
    // An answer without the new codes is refused: the page must never claim codes it did not get.
    expect(replacedAnswer.safeParse({ replaced: true, recoveryCodeSpent: false }).success).toBe(false);
    expect(replacedAnswer.safeParse({ replaced: true, recoveryCodeSpent: false, recoveryCodes: [], sessionsEnded: 0 }).success).toBe(false);
    expect(replaceStarted.safeParse({ secret: 'lowercase', uri: 'otpauth://x' }).success).toBe(false);
  });

  it('checks codes before anything is sent', () => {
    expect(isSixDigits(' 123456 ')).toBe(true);
    expect(isSixDigits('12345')).toBe(false);
    expect(isSixDigits('12345a')).toBe(false);
    expect(isProof('ABCDE-12345')).toBe(true);
    expect(isProof('123')).toBe(false);
  });

  it('sends six digits as the app code and anything else as a recovery code', () => {
    expect(stepUpProof(' 123456 ')).toEqual({ totpCode: '123456' });
    expect(stepUpProof('123 456')).toEqual({ totpCode: '123456' });
    expect(stepUpProof(' ABCDE-12345 ')).toEqual({ recoveryCode: 'ABCDE-12345' });
    // A mistyped app code is refused here, never sent as a wrong recovery code.
    expect(stepUpProof('1234567')).toBeNull();
    expect(stepUpProof('12345')).toBeNull();
    expect(stepUpProof('abc')).toBeNull();
  });
});

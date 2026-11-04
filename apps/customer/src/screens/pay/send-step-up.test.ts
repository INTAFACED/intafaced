import { describe, expect, it } from 'vitest';
import { stepUpAgain, stepUpProblem } from './send-step-up';

const refused = (code: string | undefined, status?: number) =>
  ({ ok: false, reason: 'error', message: code ?? 'refused', ...(code ? { code } : {}), ...(status ? { status } : {}) }) as never;

describe('Send: the owner’s fresh confirmation (J-pay-01 #5)', () => {
  it('asks again only when the bank wants a fresh confirmation or the one given was spent', () => {
    expect(stepUpAgain('bank.step_up_required')).toBe(true);
    expect(stepUpAgain('bank.step_up_used')).toBe(true);
    // A mismatch would bind the same fields again, so it is final; every other answer is too.
    expect(stepUpAgain('bank.step_up_mismatch')).toBe(false);
    expect(stepUpAgain('bank.step_up_unavailable')).toBe(false);
    expect(stepUpAgain('bank.insufficient_funds')).toBe(false);
    expect(stepUpAgain(undefined)).toBe(false);
  });

  it('says a wrong code was refused and nothing was sent', () => {
    expect(stepUpProblem(refused('auth.mfa_invalid', 401))).toBe(
      'That code didn’t match, so nothing was sent. Check your authenticator app and try again.',
    );
  });

  it('tells a person with no second factor how to get one, instead of a retry that can never pass', () => {
    expect(stepUpProblem(refused('auth.mfa_not_enrolled', 403))).toMatch(/^Sending to another person needs a code .* Add one in Security/);
  });

  it('names passkey problems, too many tries, and a session that cannot confirm', () => {
    expect(stepUpProblem(refused('stepUp.no_passkey'))).toBe('No passkey is saved on this account. Enter a code instead.');
    expect(stepUpProblem(refused('auth.webauthn_not_enrolled', 403))).toBe('No passkey is saved on this account. Enter a code instead.');
    expect(stepUpProblem(refused('auth.webauthn_invalid', 401))).toBe(
      'The browser could not read your passkey. Try again, or enter a code.',
    );
    expect(stepUpProblem(refused('auth.too_many_attempts', 429))).toBe('Too many tries. Wait a minute, then try again.');
    expect(stepUpProblem(refused(undefined, 403))).toMatch(/^This session can’t confirm a payment/);
    expect(stepUpProblem(refused(undefined, 500))).toBe('We couldn’t confirm it’s you, so nothing was sent. Try again.');
  });
});

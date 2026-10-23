import { describe, expect, it } from 'vitest';
import { passwordCopy } from './password-copy';
import { passwordIssue, passwordProblem, singleFlight, type PasswordProblem } from './password';
import type { ApiResult } from './api';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const refusal = (extra: Partial<Refusal>): Refusal => ({ ok: false, reason: 'error', message: 'x', ...extra });

describe('password rules mirrored from the identity service', () => {
  it('accepts a good password and flags the same four mistakes the server refuses', () => {
    expect(passwordIssue('correct horse battery', 'correct horse battery')).toBeNull();
    expect(passwordIssue('short', 'short')).toBe('tooShort');
    const atLimit = 'éa'.repeat(24); // 3 bytes per pair: exactly 72 bytes
    expect(new TextEncoder().encode(atLimit).length).toBe(72);
    expect(passwordIssue(atLimit, atLimit)).toBeNull();
    expect(passwordIssue(atLimit + 'x', atLimit + 'x')).toBe('tooLong');
    const emoji = '😀'.repeat(6); // the server's regex has no `u` flag, so these pass there
    expect(passwordIssue(emoji, emoji)).toBeNull();
    expect(passwordIssue('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa')).toBe('repeated');
    expect(passwordIssue('correct horse battery', 'correct horse batterY')).toBe('mismatch');
  });
});

describe('refusal mapping', () => {
  const cases: Array<[Partial<Refusal>, PasswordProblem]> = [
    [{ code: 'auth.reset_unwired', status: 412 }, 'resetOff'],
    [{ code: 'auth.reset_proof_invalid', status: 400 }, 'badCode'],
    [{ code: 'auth.password_policy', status: 400 }, 'policy'],
    [{ code: 'auth.password_unchanged', status: 400 }, 'unchanged'],
    [{ code: 'auth.invalid_credentials', status: 403, reason: 'forbidden' }, 'wrongCurrent'],
    [{ code: 'auth.too_many_attempts', status: 429 }, 'rateLimited'],
    [{ status: 429 }, 'rateLimited'],
    [{ code: 'auth.mfa_required', status: 403, reason: 'forbidden' }, 'secondStep'],
    [{ code: 'auth.privileged_enrolment_requires_invite', status: 403, reason: 'forbidden' }, 'inviteNeeded'],
    [{ code: 'auth.account_frozen', status: 403, reason: 'forbidden' }, 'inactive'],
    [{ code: 'identity.security_locked', status: 412, reason: 'error' }, 'securityLocked'],
    [{ code: 'auth.session_invalid', status: 401, reason: 'unauthorized' }, 'signedOut'],
    [{ status: 401, reason: 'unauthorized' }, 'signedOut'],
    [{ status: 404, reason: 'not_mounted' }, 'notConnected'],
    [{ status: 502, reason: 'uncertain' }, 'unconfirmed'],
    [{ reason: 'unreachable' }, 'unreachable'],
    [{ code: 'BAD_REQUEST', status: 400 }, 'invalidInput'],
    [{ status: 418 }, 'other'],
  ];
  it.each(cases)('maps %j to %s', (extra, expected) => {
    expect(passwordProblem(refusal(extra))).toBe(expected);
  });

  it('has plain English, Spanish and French words for every problem and no engineering code in them', () => {
    const problems: PasswordProblem[] = [...new Set(cases.map(([, problem]) => problem)), 'requestUnconfirmed'];
    for (const locale of ['en', 'es', 'fr'] as const) {
      const copy = passwordCopy.forLocale(locale);
      for (const problem of problems) {
        const text = copy.t(problem);
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/auth\.|BAD_REQUEST|TRPC/);
        expect(copy.languageFor(problem)).toBe(locale);
      }
    }
  });
});

describe('single flight', () => {
  it('refuses a second start while one is running and allows the next once it ends', async () => {
    const flight = singleFlight();
    let release!: () => void;
    let calls = 0;
    const first = flight.run(async () => {
      calls++;
      await new Promise<void>((resolve) => (release = resolve));
      return 'first';
    });
    expect(flight.busy).toBe(true);
    expect(await flight.run(async () => (calls++, 'second'))).toBeUndefined();
    release();
    expect(await first).toBe('first');
    expect(flight.busy).toBe(false);
    expect(await flight.run(async () => (calls++, 'third'))).toBe('third');
    expect(calls).toBe(2);
  });

  it('frees the slot when the task throws', async () => {
    const flight = singleFlight();
    await expect(flight.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(flight.busy).toBe(false);
  });
});

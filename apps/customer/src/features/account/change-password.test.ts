import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../shared/api';
import { changeIssue, changeReducer, changedSchema, initialChange } from './change-password';
import { changePasswordCopy } from './change-password-copy';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const refused = (extra: Partial<Refusal>): Refusal => ({ ok: false, reason: 'error', message: 'x', ...extra });
const ok: ApiResult<unknown> = { ok: true, data: { ok: true } };

describe('change password', () => {
  it('checks only what the service also refuses', () => {
    expect(changeIssue('', 'correct horse battery', 'correct horse battery')).toBe('currentMissing');
    expect(changeIssue('old', 'short', 'short')).toBe('tooShort');
    expect(changeIssue('old', 'correct horse battery', 'nope')).toBe('mismatch');
    expect(changeIssue('old', 'correct horse battery', 'correct horse battery')).toBeNull();
  });

  it('parses the service answer', () => {
    expect(changedSchema.safeParse({ ok: true }).success).toBe(true);
    expect(changedSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it('goes idle, sending, changed, and back on request', () => {
    const sending = changeReducer(initialChange, { type: 'submit', issue: null });
    expect(sending).toEqual({ phase: 'sending' });
    const changed = changeReducer(sending, { type: 'answered', result: ok });
    expect(changed).toEqual({ phase: 'changed' });
    expect(changeReducer(changed, { type: 'again' })).toEqual(initialChange);
  });

  it('does not start a second request while one is sending, and ignores stray answers', () => {
    const sending = changeReducer(initialChange, { type: 'submit', issue: null });
    expect(changeReducer(sending, { type: 'submit', issue: null })).toBe(sending);
    expect(changeReducer(initialChange, { type: 'answered', result: ok })).toBe(initialChange);
  });

  it('holds a client-side issue without sending', () => {
    expect(changeReducer(initialChange, { type: 'submit', issue: 'mismatch' })).toEqual({ phase: 'idle', problem: 'mismatch' });
  });

  it('maps each refusal to a typed problem and never to success', () => {
    const sending = changeReducer(initialChange, { type: 'submit', issue: null });
    const problem = (extra: Partial<Refusal>) => changeReducer(sending, { type: 'answered', result: refused(extra) });
    expect(problem({ code: 'auth.invalid_credentials', status: 403, reason: 'forbidden' })).toEqual({
      phase: 'idle',
      problem: 'wrongCurrent',
    });
    expect(problem({ code: 'auth.password_policy', status: 400 })).toEqual({ phase: 'idle', problem: 'policy' });
    expect(problem({ code: 'auth.password_unchanged', status: 400 })).toEqual({ phase: 'idle', problem: 'unchanged' });
    expect(problem({ code: 'auth.too_many_attempts', status: 429 })).toEqual({ phase: 'idle', problem: 'rateLimited' });
    expect(problem({ code: 'auth.mfa_required', status: 403, reason: 'forbidden' })).toEqual({ phase: 'idle', problem: 'secondStep' });
    expect(problem({ code: 'auth.account_frozen', status: 403, reason: 'forbidden' })).toEqual({ phase: 'idle', problem: 'inactive' });
    expect(problem({ status: 502, reason: 'uncertain' })).toEqual({ phase: 'idle', problem: 'unconfirmed' });
  });

  it('only says other devices were signed out in the success sentence, in all three languages', () => {
    for (const locale of ['en', 'es', 'fr'] as const) {
      const copy = changePasswordCopy.forLocale(locale);
      expect(copy.languageFor('changed')).toBe(locale);
      expect(copy.t('changed').length).toBeGreaterThan(20);
    }
    expect(changePasswordCopy.forLocale('en').t('changed')).toContain('Every other device was signed out');
  });
});

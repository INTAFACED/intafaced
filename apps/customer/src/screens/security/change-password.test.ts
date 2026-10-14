import { describe, expect, it } from 'vitest';
import { outcomeOf, passwordProblem } from './change-password';

const refused = (code: string, extra: Record<string, unknown> = {}) =>
  ({ ok: false, reason: 'forbidden', message: 'x', code, ...extra }) as Parameters<typeof outcomeOf>[0];

describe('passwordProblem', () => {
  it('follows the server rule: 12 characters, 72 bytes', () => {
    expect(passwordProblem('short')).toBe('short');
    expect(passwordProblem('exactly12chr')).toBeNull();
    expect(passwordProblem('é'.repeat(37))).toBe('long');
    expect(passwordProblem('a'.repeat(72))).toBeNull();
    expect(passwordProblem('a'.repeat(73))).toBe('long');
  });
});

describe('outcomeOf', () => {
  it('maps the service codes to the cases the screen has words for', () => {
    expect(outcomeOf({ ok: true, data: { ok: true } })).toEqual({ kind: 'changed' });
    expect(outcomeOf(refused('auth.invalid_credentials')).kind).toBe('wrongCurrent');
    expect(outcomeOf(refused('auth.password_policy')).kind).toBe('policy');
    expect(outcomeOf(refused('auth.password_unchanged')).kind).toBe('same');
    expect(outcomeOf(refused('auth.mfa_required')).kind).toBe('secondStep');
    expect(outcomeOf(refused('auth.too_many_attempts')).kind).toBe('locked');
    expect(outcomeOf(refused('whatever', { status: 429 })).kind).toBe('locked');
  });
  it('treats a lost answer as unknown, never as a plain failure', () => {
    expect(outcomeOf({ ok: false, reason: 'uncertain', message: 'x' }).kind).toBe('unknown');
  });
  it('keeps an unrecognised code for the support line', () => {
    expect(outcomeOf(refused('weird.code'))).toEqual({ kind: 'other', code: 'weird.code' });
  });
});

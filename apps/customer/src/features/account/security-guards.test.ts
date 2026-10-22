import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../shared/api';
import { isPreEffectRefusal, stepUpKind } from './security-guards';

const refused = (code: string, status: number, reason: Extract<ApiResult<never>, { ok: false }>['reason']) =>
  ({ ok: false, reason, message: 'Two-factor verification', code, status }) as const;

describe('isPreEffectRefusal', () => {
  it('reads the factor gate (403 auth.mfa_required) as refused before any change, for every factor change', () => {
    for (const kind of ['options', 'register', 'remove', 'setup', 'confirm'] as const) {
      expect(isPreEffectRefusal(kind, refused('auth.mfa_required', 403, 'forbidden'))).toBe(true);
    }
  });

  it('never reads it so for a global sign-out, a different status or an uncertain answer', () => {
    expect(isPreEffectRefusal('logout', refused('auth.mfa_required', 403, 'forbidden'))).toBe(false);
    expect(isPreEffectRefusal('options', refused('auth.mfa_required', 401, 'unauthorized'))).toBe(false);
    expect(isPreEffectRefusal('options', refused('auth.mfa_required', 403, 'uncertain'))).toBe(false);
    expect(isPreEffectRefusal('options', refused('auth.other', 403, 'forbidden'))).toBe(false);
  });

  it('keeps the earlier known refusals', () => {
    expect(isPreEffectRefusal('confirm', refused('auth.mfa_invalid', 401, 'unauthorized'))).toBe(true);
    expect(isPreEffectRefusal('options', refused('auth.not_found', 404, 'not_mounted'))).toBe(true);
  });
});

describe('stepUpKind', () => {
  it('resends a passkey add (from either half), a removal or an authenticator setup after "Confirm it is you"', () => {
    expect(stepUpKind('options')).toBe('options');
    expect(stepUpKind('register')).toBe('options');
    expect(stepUpKind('remove')).toBe('remove');
    expect(stepUpKind('setup')).toBe('setup');
  });

  it('never resends a confirmation, whose code has likely expired, a global sign-out or an unknown change', () => {
    expect(stepUpKind('confirm')).toBeNull();
    expect(stepUpKind('logout')).toBeNull();
    expect(stepUpKind(undefined)).toBeNull();
  });
});

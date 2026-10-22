import { describe, expect, it } from 'vitest';
import { knownAuthRefusal } from './public-auth-guards';
import { classifyRefusal } from '../../data/refusal-codes';
import { refusalCopy } from '../../data/refusals';

const refused = (code: string, status: number, reason: 'unauthorized' | 'forbidden' | 'error' | 'uncertain') =>
  ({ ok: false, reason, message: code, status, code }) as const;

describe('sign-in refusals the service answers on purpose', () => {
  it('a wrong password is a known answer, in plain words, the same for an unknown name', () => {
    expect(knownAuthRefusal('password', refused('auth.invalid_credentials', 401, 'unauthorized'))).toBe(true);
    expect(classifyRefusal('auth.invalid_credentials')).toBe('signInMismatch');
    expect(refusalCopy('auth.invalid_credentials').title).toBe('Those details did not work');
  });

  it('the pause after too many wrong passwords is a known answer, never "not confirmed"', () => {
    expect(knownAuthRefusal('password', refused('auth.too_many_attempts', 429, 'error'))).toBe(true);
    expect(knownAuthRefusal('passkey', refused('auth.too_many_attempts', 429, 'error'))).toBe(true);
    expect(classifyRefusal('auth.too_many_attempts')).toBe('tooManyTries');
  });

  it('a gateway failure stays uncertain', () => {
    expect(knownAuthRefusal('password', refused('auth.too_many_attempts', 503, 'uncertain'))).toBe(false);
    expect(knownAuthRefusal('password', refused('edge.gateway', 502, 'uncertain'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { userCopy } from './user-copy.js';
import { INSURED_REFUSED } from './auth/insured-refuse.js';

/**
 * Unit card — user-visible identity copy resolves @intafaced/i18n keys
 * 1. Promise: TRK-infra.i18n slice — auth / KYC / rank refuse strings
 * 2. Break: unknown key invents English instead of echoing the dotted name
 * 3. Done bar: known key renders catalog copy; unknown key === key string
 * 4. Class N
 * 5. Paths: svc-identity resolves catalog keys. Taken email and handle have catalog rows.
 * 6. RED: unknown key becomes a sentence
 * 7. Collision: none vs svc-academy / svc-market / packages/i18n catalog
 */
describe('userCopy — catalog keys, never invented English', () => {
  it('resolves a known catalog key from @intafaced/i18n', () => {
    expect(userCopy('error.notFound')).toBe('We could not find that.');
    expect(userCopy('auth.not_found')).toBe('We could not find that.');
    expect(userCopy('auth.session.expired')).toBe('Your session has expired. Sign in again.');
    expect(userCopy('auth.session_invalid')).toBe('Your session has expired. Sign in again.');
    expect(userCopy('auth.mfa_required')).toBe('Two-factor verification');
    expect(userCopy('error.kyc.required')).toBe('Verification is required for this action.');
    expect(userCopy('notify.identity.rank.updated.title')).toBe('Rank updated');
    expect(userCopy('auth.email_taken')).toBe('An account with that email already exists.');
    expect(userCopy('auth.handle_taken')).toBe('That handle is already taken.');
    expect(userCopy('auth.too_many_attempts')).toBe('Too many attempts. Wait before trying again, or sign in with a passkey.');
  });

  it('renders the dotted key when the key is not in the catalog', () => {
    const missing = 'identity.auth.this.key.does.not.exist';
    const rendered = userCopy(missing);

    expect(rendered).toBe(missing);
    expect(rendered).not.toMatch(/ /);
    expect(rendered).not.toMatch(/invalid credentials|please try|something went wrong|could not find/i);
  });

  it('does not invent English or screening copy for unkeyed auth/KYC codes', () => {
    const credentials = userCopy('auth.invalid_credentials');
    expect(credentials).toBe('auth.invalid_credentials');
    expect(credentials).not.toMatch(/ /);
    expect(credentials).not.toMatch(/invalid credentials/i);

    const screening = userCopy('identity.kyc.screening.this.key.does.not.exist');
    expect(screening).toBe('identity.kyc.screening.this.key.does.not.exist');
    expect(screening).not.toMatch(/sanction|ofac|pep list|cleared|blocked person/i);
    expect(screening).not.toMatch(/ /);
  });

  it('refuses an insured claim — returns the named refuse key, never the sentence', () => {
    expect(userCopy('Deposits are insured by the house.')).toBe(INSURED_REFUSED);
    expect(userCopy('insured')).toBe(INSURED_REFUSED);
    expect(userCopy('uninsured account')).not.toBe(INSURED_REFUSED);
    expect(userCopy('error.notFound')).not.toMatch(/insured/i);
  });

  it('echoes inherited object names instead of native function text', () => {
    for (const key of ['constructor', 'toString', '__proto__'] as const) {
      const rendered = userCopy(key);
      expect(rendered).toBe(key);
      expect(rendered).not.toMatch(/\[native code\]/);
      expect(rendered).not.toMatch(/\bfunction\b/);
    }
  });

  it('does not throw or render native function text for a non-string key', () => {
    const native = Object.prototype.toString;
    const tricky = {
      toString() {
        return 'function toString() { [native code] }';
      },
    };
    for (const key of [native, tricky, 1, null, undefined] as const) {
      const rendered = userCopy(key as unknown as string);
      expect(typeof rendered).toBe('string');
      expect(rendered).not.toMatch(/\[native code\]/);
      expect(rendered).not.toMatch(/\bfunction\b/);
    }
  });

  it('maps auth.account_frozen through its catalog alias', () => {
    expect(userCopy('auth.account_frozen')).toBe('You do not have access to this.');
  });
});

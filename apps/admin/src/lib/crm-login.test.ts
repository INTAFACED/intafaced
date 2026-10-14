import { describe, expect, it } from 'vitest';
import { firstLoginError, loginFieldErrors } from './crm-login';

describe('sign-in checks', () => {
  it('explains each missing field under that field', () => {
    const errors = loginFieldErrors({ identifier: '  ', password: '', totpCode: '' });
    expect(Object.keys(errors)).toEqual(['identifier', 'password', 'totpCode']);
    expect(errors.identifier).toMatch(/email or handle/);
    expect(firstLoginError(errors)).toBe('identifier');
  });
  it('has no errors when everything is filled in, and points at the first gap otherwise', () => {
    expect(loginFieldErrors({ identifier: 'a@b.c', password: 'x', totpCode: '123456' })).toEqual({});
    expect(firstLoginError({})).toBeNull();
    expect(firstLoginError(loginFieldErrors({ identifier: 'a@b.c', password: '', totpCode: '' }))).toBe('password');
  });
});

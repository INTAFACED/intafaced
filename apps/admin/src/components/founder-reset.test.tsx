import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { firstResetError, FounderReset, RESET_REFUSED, RESET_WAIT, resetFieldErrors, resetMessage } from './founder-reset';

const good = {
  identifier: 'founder',
  totpCode: '123456',
  recoveryCode: 'ABCDE-12345',
  newPassword: 'a-new-password-1',
  again: 'a-new-password-1',
};

describe('the forgotten-password page', () => {
  const html = renderToStaticMarkup(<FounderReset />);
  it('offers the two paths and says both factors are needed', () => {
    expect(html).toContain('I have my authenticator app and a recovery code');
    expect(html).toContain('I have a passkey');
    expect(html).toContain('This needs both');
    expect(html).toContain('contact Nitro');
    expect(html).toContain('href="/login"');
  });
  it('labels every field and gives the right autocomplete hints', () => {
    for (const label of ['Email or handle', 'Code from your authenticator app', 'Recovery code', 'New password', 'New password again'])
      expect(html).toContain(label);
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
  });
  it('keeps lime off the button until the form is filled in, and puts no secret in the markup', () => {
    expect(html).not.toContain('data-primary="true"');
    expect(html).not.toMatch(/value="[^"]/);
  });
});

describe('reset checks', () => {
  it('passes a complete form', () => {
    expect(resetFieldErrors(good)).toEqual({});
    expect(firstResetError({})).toBeNull();
  });
  it('explains each gap under its field and points at the first', () => {
    const errors = resetFieldErrors({ identifier: ' ', totpCode: '12', recoveryCode: '123456', newPassword: 'short', again: 'x' });
    expect(Object.keys(errors)).toEqual(['identifier', 'totpCode', 'recoveryCode', 'newPassword']);
    expect(firstResetError(errors)).toBe('identifier');
  });
  it('catches a password mismatch', () => {
    expect(resetFieldErrors({ ...good, again: 'different-password' }).again).toMatch(/match/);
  });
  it('gives one refusal for everything but the wait', () => {
    expect(resetMessage('admin.reset_refused')).toBe(RESET_REFUSED);
    expect(resetMessage('admin.authority_refused')).toBe(RESET_REFUSED);
    expect(resetMessage('')).toBe(RESET_REFUSED);
    expect(RESET_REFUSED).toBe("We couldn't reset your password with those details.");
    expect(resetMessage('admin.reset_rate_limited')).toBe(RESET_WAIT);
  });
});

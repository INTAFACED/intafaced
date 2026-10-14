import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// qr.ts needs the `uqr` package, which the parent installs. The drawing itself is covered by qr.test.ts.
vi.mock('@/lib/qr', () => ({
  qrModules: () => [
    [true, false],
    [false, true],
  ],
  qrPath: () => ({ size: 10, d: 'M4 4h1v1h-1z' }),
}));

import {
  ConfirmRemove,
  passkeyBrowserMessage,
  passwordPairErrors,
  ProofFields,
  recoveryCodesText,
  SecurityCards,
  SecurityQr,
  securityErrorMessage,
  groupSecret,
  type SecurityOverview,
} from './founder-security';

const overview: SecurityOverview = {
  totpEnrolled: true,
  totpEnrolledAt: '2026-10-01T02:00:00.000Z',
  recoveryCodesRemaining: 8,
  passkeys: [
    { id: 'abc', createdAt: '2026-10-02T02:00:00.000Z' },
    { id: 'def', name: 'Laptop' },
  ],
  passkeysAvailable: true,
  passwordChangedAt: null,
};
const cards = (extra: Partial<SecurityOverview> = {}) =>
  renderToStaticMarkup(<SecurityCards csrf="c" overview={{ ...overview, ...extra }} onChanged={() => undefined} />);

describe('the four Security cards', () => {
  it('shows one card each, in the order password, authenticator, recovery codes, passkeys', () => {
    const html = cards();
    const order = ['Password', 'Authenticator app', 'Recovery codes', 'Passkeys'].map((title) => html.indexOf(`>${title}</h2>`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('offers Change password and the passkey route for a forgotten password', () => {
    const html = cards();
    expect(html).toContain('Change password');
    expect(html).toContain('Forgot it? Sign in with your passkey, then set a new one here');
  });
  it('shows the authenticator date and the replace action', () => {
    const html = cards();
    expect(html).toContain('Set up ');
    expect(html).toContain('Replace authenticator');
  });
  it('says how many recovery codes are left, and warns when they run low', () => {
    expect(cards()).toContain('8 left');
    expect(cards()).not.toContain('running low');
    expect(cards({ recoveryCodesRemaining: 2 })).toContain('running low');
    expect(cards({ recoveryCodesRemaining: 0 })).toContain('no recovery codes left');
    expect(cards()).toContain('Get new codes');
  });
  it('lists passkeys with an amber Remove, never the danger style', () => {
    const html = cards();
    expect(html).toContain('Passkey 1');
    expect(html).toContain('Laptop');
    expect(html.match(/class="adm-irreversible"[^>]*>Remove</g)).toHaveLength(2);
    expect(html).not.toContain('adm-danger');
    expect(html).toContain('Add a passkey');
  });
  it('says plainly when passkeys cannot be loaded and offers no Add', () => {
    const html = cards({ passkeys: [], passkeysAvailable: false });
    expect(html).toContain('can’t be loaded');
    expect(html).not.toContain('Add a passkey');
  });
  it('asks for no proof until Add is chosen', () => {
    const html = cards();
    expect(html).toContain('Add a passkey');
    expect(html).not.toContain('First, prove it is you. Then your device');
  });
  it('keeps lime off every action until something is typed', () => {
    expect(cards()).not.toContain('data-primary="true"');
  });
  it('holds no secret in the markup', () => {
    expect(cards()).not.toMatch(/secret|otpauth|FACED-|value="[^"]/i);
  });
});

describe('ProofFields', () => {
  const view = (canPasskey: boolean, error?: string) =>
    renderToStaticMarkup(
      <ProofFields
        id="p"
        code=""
        onCode={() => undefined}
        error={error}
        canPasskey={canPasskey}
        busy={false}
        onPasskey={() => undefined}
      />,
    );
  it('asks for a code or a recovery code with the one-time-code hint', () => {
    const html = view(false);
    expect(html).toContain('Code from your authenticator app, or a recovery code');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).not.toContain('Use a passkey instead');
  });
  it('offers a passkey only when one exists, and puts the error next to the field', () => {
    const html = view(true, 'Nope');
    expect(html).toContain('Use a passkey instead');
    expect(html).toMatch(/role="alert"[^>]*>Nope</);
    expect(html).toContain('aria-invalid="true"');
  });
});

describe('ConfirmRemove', () => {
  const dialog = (extra: { error?: string; canPasskey?: boolean } = {}) =>
    renderToStaticMarkup(
      <ConfirmRemove
        open={false}
        label="Laptop"
        busy={false}
        code=""
        onCode={() => undefined}
        canPasskey={extra.canPasskey ?? false}
        error={extra.error}
        onPasskey={() => undefined}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
  it('names the passkey, is amber, and has a way back', () => {
    const html = dialog();
    expect(html).toContain('Remove this passkey?');
    expect(html).toContain('Laptop will stop working');
    expect(html).toContain('class="adm-irreversible"');
    expect(html).toContain('Keep it');
  });
  it('asks for a code from the app or a recovery code before it removes anything', () => {
    const html = dialog({ canPasskey: true });
    expect(html).toContain('Code from your authenticator app, or a recovery code');
    expect(html).toContain('Use a passkey instead');
    expect(html).toContain('type="submit" class="adm-irreversible"');
  });
});

describe('SecurityQr', () => {
  it('draws the code as SVG paths with a label', () => {
    const html = renderToStaticMarkup(<SecurityQr uri="otpauth://totp/x?secret=ABC" />);
    expect(html).toContain('<svg');
    expect(html).toContain('aria-label="QR code for your new authenticator app"');
    expect(html).not.toContain('otpauth');
  });
});

describe('copy', () => {
  it('covers the codes identity sends for a password change in plain words', () => {
    const msg = (upstreamCode: string, context: Parameters<typeof securityErrorMessage>[1] = 'password') =>
      securityErrorMessage({ code: 'admin.authority_refused', upstreamCode }, context);
    expect(msg('auth.invalid_credentials')).toBe('Your current password is wrong.');
    expect(msg('auth.password_unchanged')).toMatch(/different password/);
    expect(msg('auth.password_policy')).toMatch(/at least 12 characters/);
    expect(msg('auth.too_many_attempts')).toMatch(/Wait a few minutes/);
    expect(msg('auth.mfa_required')).toMatch(/authenticator code or a passkey/);
    expect(msg('auth.invalid_credentials', 'proof')).toMatch(/code or passkey/);
  });
  it('never shows a raw code', () => {
    for (const failure of [
      { code: 'admin.authority_refused', upstreamCode: 'auth.something_new', status: 401 },
      { code: 'admin.upstream_refused', status: 500 },
      { code: 'network' },
      { code: 'admin.session_required', status: 401 },
      { code: 'admin.proof_input', status: 400 },
    ]) {
      for (const context of ['load', 'password', 'proof', 'confirm', 'passkey', 'remove'] as const)
        expect(securityErrorMessage(failure, context)).not.toMatch(/admin\.|auth\./);
    }
  });
  it('explains the browser passkey prompt outcomes', () => {
    expect(passkeyBrowserMessage({ name: 'NotAllowedError' })).toMatch(/cancelled or timed out/);
    expect(passkeyBrowserMessage({ name: 'InvalidStateError' })).toMatch(/already has a passkey/);
    expect(passkeyBrowserMessage(new Error('x'))).toBeNull();
  });
  it('checks a new password pair', () => {
    expect(passwordPairErrors('short', 'short').next).toMatch(/at least 12/);
    expect(passwordPairErrors('a'.repeat(12), 'b'.repeat(12)).again).toMatch(/match/);
    expect(passwordPairErrors('a'.repeat(12), 'a'.repeat(12))).toEqual({});
    expect(passwordPairErrors('a'.repeat(201), 'a'.repeat(201)).next).toMatch(/200/);
  });
  it('formats the download and the setup key', () => {
    const text = recoveryCodesText(['AAAAA-00001', 'AAAAA-00002']);
    expect(text).toContain('AAAAA-00001\nAAAAA-00002');
    expect(text).toContain('Each code works once');
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });
});

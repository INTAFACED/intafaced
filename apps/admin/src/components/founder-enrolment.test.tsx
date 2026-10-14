import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthenticatorStep,
  DetailsStep,
  DoneStep,
  EnrolFailure,
  EnrolmentClosed,
  FounderEnrolment,
  PasskeyStep,
  RecoveryStep,
  detailsErrors,
  enrolCall,
  enrolmentErrorMessage,
  failureField,
  firstDetailsError,
  groupAccountId,
  groupSecret,
  recoveryCodesText,
} from './founder-enrolment';

const USER_ID = '8f14e45f-ceea-467a-9575-9a8e5f9c1b27';
const CODES = Array.from({ length: 10 }, (_, i) => `FACED-${String(i + 1).padStart(5, '0')}`);
const noop = () => undefined;
const values = { invite: '', email: '', handle: '', password: '', again: '' };

afterEach(() => vi.unstubAllGlobals());

describe('error copy', () => {
  const say = (
    upstreamCode: string | undefined,
    code = 'admin.upstream_refused',
    context: Parameters<typeof enrolmentErrorMessage>[1] = 'register',
  ) => enrolmentErrorMessage({ code, upstreamCode }, context);

  it('says plainly what each refusal means, without showing a raw code', () => {
    expect(say('auth.invite_used')).toBe("This invite has already been used. If that wasn't you, tell Nitro now.");
    expect(say('auth.invite_invalid')).toMatch(/isn't recognised/);
    expect(say('auth.invite_expired')).toMatch(/expired/);
    expect(say('auth.founder_enrolment_closed')).toMatch(/closed/);
    expect(say('auth.handle_taken')).toMatch(/handle is already taken/);
    expect(say('auth.email_taken')).toMatch(/email already exists/);
    expect(say('auth.mfa_invalid', undefined, 'confirm')).toMatch(/didn't match/);
    expect(say('auth.too_many_attempts', undefined, 'confirm')).toMatch(/Too many attempts/);
    expect(say(undefined, 'network')).toMatch(/Couldn't reach the server/);
    expect(say('auth.mfa_required', undefined, 'passkey')).toMatch(/fresh code/);
    expect(say('auth.mfa_invalid', undefined, 'passkey')).toMatch(/can't be used twice/);
    expect(say('auth.passkey_preview_unavailable', undefined, 'passkey')).toMatch(/local preview/);
    for (const code of ['auth.invite_used', 'auth.too_many_attempts', 'auth.mfa_required', 'admin.enrolment_required', 'surprise'])
      expect(say(code, code)).not.toMatch(/auth\.|admin\./);
  });

  it('falls back to a calm general message', () => {
    expect(say(undefined, 'something.new')).toMatch(/Something went wrong/);
    expect(say(undefined, 'admin.enrolment_required')).toMatch(/enrolment session has ended/);
    expect(say(undefined, 'admin.enrolment_expired')).toBe('Your enrolment time has run out. Ask Nitro for a new invite.');
  });

  it('puts invite, handle and email refusals next to their fields', () => {
    expect(failureField('auth.invite_used')).toBe('invite');
    expect(failureField('auth.invite_invalid')).toBe('invite');
    expect(failureField('auth.invite_expired')).toBe('invite');
    expect(failureField('auth.handle_taken')).toBe('handle');
    expect(failureField('auth.email_taken')).toBe('email');
    expect(failureField('auth.founder_enrolment_closed')).toBeNull();
    expect(failureField(undefined)).toBeNull();
  });
});

describe('formatting', () => {
  it('groups the secret in fours and the account ID for reading aloud', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupAccountId(USER_ID)).toEqual(['8f14', 'e45f', 'ceea', '467a', '9575', '9a8e', '5f9c', '1b27']);
  });

  it('writes the recovery codes file with all ten codes and no account details', () => {
    const text = recoveryCodesText(CODES);
    for (const code of CODES) expect(text).toContain(code);
    expect(text).toContain('somewhere other than your phone');
    expect(text).not.toContain('@');
  });
});

describe('details validation', () => {
  it('asks for each missing field and orders them as the page does', () => {
    const errors = detailsErrors(values);
    expect(Object.keys(errors)).toEqual(['invite', 'email', 'handle', 'password']);
    expect(firstDetailsError(errors)).toBe('invite');
  });

  it('enforces the length limits and that the two passwords match', () => {
    const ok = { invite: 'ABCD', email: 'a@b.test', handle: 'ab', password: 'a'.repeat(12), again: 'a'.repeat(12) };
    expect(detailsErrors(ok)).toEqual({});
    expect(detailsErrors({ ...ok, password: 'a'.repeat(11), again: 'a'.repeat(11) }).password).toMatch(/12/);
    expect(detailsErrors({ ...ok, password: 'a'.repeat(201), again: 'a'.repeat(201) }).password).toMatch(/200/);
    expect(detailsErrors({ ...ok, again: 'b'.repeat(12) }).again).toMatch(/don't match/);
    expect(detailsErrors({ ...ok, invite: 'x'.repeat(65) }).invite).toBeDefined();
    expect(detailsErrors({ ...ok, handle: 'h'.repeat(33) }).handle).toBeDefined();
    expect(detailsErrors({ ...ok, email: 'nope' }).email).toBeDefined();
    expect(firstDetailsError({})).toBeNull();
  });
});

describe('views', () => {
  it('renders the closed message', () => {
    expect(renderToStaticMarkup(<EnrolmentClosed />)).toContain('Enrolment is closed.');
  });

  it('starts as a check, and a refused page shows no form', () => {
    const html = renderToStaticMarkup(<FounderEnrolment />);
    expect(html).toContain('Checking');
    expect(html).not.toContain('<form');
  });

  it('step 1 labels every field with the right autocomplete and tells people to use a password manager', () => {
    const html = renderToStaticMarkup(<DetailsStep values={values} errors={{}} error="" busy={false} onChange={noop} onSubmit={noop} />);
    expect(html).toContain('password manager');
    expect(html).toContain('Invite code');
    expect(html).toContain('autoComplete="username"');
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
    expect(html).toContain('Type the password again');
    expect(html).toContain('Create account');
  });

  it('step 1 shows field errors as alerts tied to their fields, and a general error', () => {
    const html = renderToStaticMarkup(
      <DetailsStep
        values={values}
        errors={{ invite: "This invite has already been used. If that wasn't you, tell Nitro now." }}
        error="Something went wrong."
        busy={false}
        onChange={noop}
        onSubmit={noop}
      />,
    );
    expect(html).toContain('id="enrol-invite-error"');
    expect(html).toContain('aria-describedby="enrol-invite-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('already been used');
  });

  it('step 2 draws a QR code, groups the secret, and takes a 6-digit one-time code', () => {
    const html = renderToStaticMarkup(
      <AuthenticatorStep
        uri="otpauth://totp/INTAFACED:x?secret=JBSWY3DPEHPK3PXP"
        secret="JBSWY3DPEHPK3PXP"
        code=""
        error=""
        busy={false}
        loading={false}
        copied={false}
        onCode={noop}
        onCopy={noop}
        onConfirm={noop}
        onRetry={noop}
      />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('QR code for your authenticator app');
    expect(html).toContain('JBSW Y3DP EHPK 3PXP');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('>Copy<');
    expect(html).toContain('Confirm code');
  });

  it('step 2 shows a bad-code message next to the field, and a retry when the setup failed to load', () => {
    const bad = renderToStaticMarkup(
      <AuthenticatorStep
        uri="otpauth://totp/x"
        secret="JBSWY3DPEHPK3PXP"
        code="000000"
        error="That code didn't match."
        busy={false}
        loading={false}
        copied
        onCode={noop}
        onCopy={noop}
        onConfirm={noop}
        onRetry={noop}
      />,
    );
    expect(bad).toContain('id="enrol-code-error"');
    expect(bad).toContain('Copied');
    const failed = renderToStaticMarkup(
      <AuthenticatorStep
        uri=""
        secret=""
        code=""
        error="Couldn't reach the server."
        busy={false}
        loading={false}
        copied={false}
        onCode={noop}
        onCopy={noop}
        onConfirm={noop}
        onRetry={noop}
      />,
    );
    expect(failed).toContain('Try again');
    expect(failed).not.toContain('adm-enrol__qr');
    const loading = renderToStaticMarkup(
      <AuthenticatorStep
        uri=""
        secret=""
        code=""
        error=""
        busy={false}
        loading
        copied={false}
        onCode={noop}
        onCopy={noop}
        onConfirm={noop}
        onRetry={noop}
      />,
    );
    expect(loading).toContain('Preparing');
  });

  it('step 3 lists the ten codes, and Continue stays disabled until the box is ticked', () => {
    const view = (saved: boolean) =>
      renderToStaticMarkup(<RecoveryStep codes={CODES} saved={saved} onSaved={noop} onDownload={noop} onPrint={noop} onContinue={noop} />);
    const before = view(false);
    for (const code of CODES) expect(before).toContain(code);
    expect(before).toContain('Download .txt');
    expect(before).toContain('Print');
    expect(before).toContain('I have saved these somewhere other than my phone');
    expect(before).toMatch(/<button type="button" disabled="" data-primary="false">Continue/);
    expect(view(true)).toMatch(/<button type="button" data-primary="true">Continue/);
  });

  it('step 4 asks for a fresh code and says why, and keeps Skip visible', () => {
    const html = renderToStaticMarkup(
      <PasskeyStep supported code="" needsCode error="" busy={false} onCode={noop} onAdd={noop} onSkip={noop} />,
    );
    expect(html).toContain('Add a passkey on this computer');
    expect(html).toContain('Fresh 6-digit code from your authenticator app');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('Wait for the next code to appear in your app');
    expect(html).toContain('can&#x27;t be used twice');
    expect(html).toContain('>Skip<');
    // No code yet: the passkey button is not offered as ready.
    expect(html).toMatch(/<button type="submit" disabled="" data-primary="false">Add a passkey/);
  });

  it('step 4 enables the passkey button once six digits are in, and needs none when the server still holds a step-up', () => {
    const ready = renderToStaticMarkup(
      <PasskeyStep supported code="123456" needsCode error="" busy={false} onCode={noop} onAdd={noop} onSkip={noop} />,
    );
    expect(ready).toMatch(/<button type="submit" data-primary="true">Add a passkey/);
    const retry = renderToStaticMarkup(
      <PasskeyStep supported code="" needsCode={false} error="" busy={false} onCode={noop} onAdd={noop} onSkip={noop} />,
    );
    expect(retry).not.toContain('Fresh 6-digit code');
    expect(retry).toMatch(/<button type="submit" data-primary="true">Add a passkey/);
  });

  it('step 4 shows a refusal as an alert, and an unsupported browser can only skip', () => {
    const refused = renderToStaticMarkup(
      <PasskeyStep
        supported
        code=""
        needsCode
        error="Enter a fresh code from your authenticator app to add a passkey."
        busy={false}
        onCode={noop}
        onAdd={noop}
        onSkip={noop}
      />,
    );
    expect(refused).toContain('role="alert"');
    const unsupported = renderToStaticMarkup(
      <PasskeyStep supported={false} code="" needsCode error="" busy={false} onCode={noop} onAdd={noop} onSkip={noop} />,
    );
    expect(unsupported).toContain('This browser can&#x27;t create a passkey');
    expect(unsupported).not.toContain('Fresh 6-digit code');
    expect(unsupported).toContain('>Skip<');
  });

  it('the final screen shows the ID grouped in monospace with the ends marked, the instruction, and the sign-in link', () => {
    const html = renderToStaticMarkup(<DoneStep userId={USER_ID} copied={false} onCopy={noop} />);
    expect(html).toContain('Your account ID is');
    expect(html).toContain('<b>8f14</b>');
    expect(html).toContain('<b>1b27</b>');
    expect(html).not.toContain('<b>e45f</b>');
    expect(html).toContain('Send this ID to Nitro, then confirm it on a call: read out the first 4 and last 4 characters');
    expect(html).toContain('You are signed out');
    expect(html).toContain('href="/login"');
    expect(html).toContain('Copy ID');
    expect(html).toContain('<code>');
  });
});

describe('enrolCall', () => {
  it('sends the csrf header and JSON body, same-origin and uncached', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: 1 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(enrolCall('/api/enroll/finish', 'POST', 'csrf-token', {})).resolves.toEqual({ ok: 1 });
    const init = fetcher.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: '{}' });
    expect(new Headers(init.headers).get('x-intafaced-csrf')).toBe('csrf-token');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('turns a refusal into a failure carrying the upstream code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code: 'admin.upstream_refused', upstreamCode: 'auth.invite_used' }, { status: 409 })),
    );
    const failure = await enrolCall('/api/enroll/register', 'POST', null, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EnrolFailure);
    expect(failure).toMatchObject({ code: 'admin.upstream_refused', upstreamCode: 'auth.invite_used' });
  });

  it('reports a lost connection as network, and an unreadable refusal as a generic failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    await expect(enrolCall('/api/enroll/status', 'GET', null)).rejects.toMatchObject({ code: 'network' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 502 })),
    );
    await expect(enrolCall('/api/enroll/status', 'GET', null)).rejects.toMatchObject({ code: 'admin.request_failed' });
  });
});

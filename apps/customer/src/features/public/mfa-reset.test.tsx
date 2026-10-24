// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session/session';
import { AuthForm } from './AuthForm';

// "I lost my authenticator" on /login (I-signin-sessions-12, J-identity-05 #2): offered with the second step, it asks for
// the password again, then the mailed code, then shows the wait and who was told. A blank waiting setting points to Support.
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
const USER = '7c1f6b8e-2d4a-4f3b-9a5e-1b2c3d4e5f60';

const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === name);
const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

function set(name: string, value: string) {
  const input = field(name);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const RESET = '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
const secondStep = () =>
  new Response(JSON.stringify({ error: { message: 'Second step required', data: { intafacedCode: 'auth.mfa_required' } } }), {
    status: 401,
  });
const unavailable = () => new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 });
const sent: { url: string; body: unknown }[] = [];

/** The boot refresh answers "no session", `auth.login` asks for the second step, and `mfaReset.*` answers from `reset`. */
function answer(reset: Record<string, () => Response>) {
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('auth.refresh'))
      return new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 });
    if (path.includes('auth.login')) return secondStep();
    const name = Object.keys(reset).find((key) => path.includes(key));
    if (!name) return unavailable();
    sent.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return reset[name]!();
  });
}

async function lostAuthenticator() {
  await act(async () => {
    set('identifier', 'someone@example.invalid');
    set('password', 'a long enough password');
  });
  await act(async () => buttonNamed('Sign in')!.click());
  await act(async () => {
    await vi.waitFor(() => expect(buttonNamed('I lost my authenticator')).toBeDefined());
  });
  await act(async () => buttonNamed('I lost my authenticator')!.click());
}
const submit = async (name: string) => act(async () => buttonNamed(name)!.click());
const ok = (data: unknown) => () => new Response(JSON.stringify({ result: { data } }));

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  sent.length = 0;
  answer({});
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  vi.stubGlobal('PublicKeyCredential', class {});
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) },
  });
  localStorage.clear();
  history.replaceState(null, '', '/login?redirect=%2Fmoney');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <SessionProvider>
        <AuthForm register={false} />
      </SessionProvider>,
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(buttonNamed('Use a passkey')!.disabled).toBe(false));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('I lost my authenticator', () => {
  it('is offered only with the second step, and starts from the identifier already typed', async () => {
    expect(buttonNamed('I lost my authenticator')).toBeUndefined();
    await lostAuthenticator();
    expect(host.querySelector('h2')!.textContent).toBe('Reset your second step');
    expect(field('mfaResetIdentifier').value).toBe('someone@example.invalid');
    expect(field('mfaResetPassword').value).toBe('');
    expect(field('password')).toBeNull();
  });

  it('password, then the mailed code, then the wait and who was told; nothing typed stays in the fields', async () => {
    const codeExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const completesAt = new Date(Date.now() + 86_400_000).toISOString();
    answer({
      'mfaReset.start': ok({ state: 'code_sent', resetId: RESET, email: 's•••@example.invalid', codeExpiresAt }),
      'mfaReset.confirm': ok({ state: 'waiting', resetId: RESET, completesAt, told: { email: 's•••@example.invalid', sms: 'vendor.sms' } }),
    });
    await lostAuthenticator();
    await act(async () => set('mfaResetPassword', 'a long enough password'));
    await submit('Email me a code');
    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain('We emailed a 6-digit code to s•••@example.invalid'));
    });
    expect(sent[0]!.body).toMatchObject({ identifier: 'someone@example.invalid', password: 'a long enough password' });
    await act(async () => set('mfaResetCode', '123456'));
    await submit('Start the reset');
    await act(async () => {
      await vi.waitFor(() =>
        expect(host.querySelector('.public-auth-mfa-reset [role=status]')?.textContent).toContain(
          'Your second step is being reset. It waits until',
        ),
      );
    });
    expect(sent[1]!.body).toMatchObject({ resetId: RESET, code: '123456' });
    expect(host.textContent).toContain('an email went to s•••@example.invalid');
    expect(host.textContent).toContain('your phone number was not texted');
    expect(host.querySelector('input[type=password]')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('a long enough password');
  });

  it('a blank waiting time refuses in words and points to Support', async () => {
    answer({
      'mfaReset.start': () =>
        new Response(
          JSON.stringify({
            error: { message: 'unset', data: { code: 'PRECONDITION_FAILED', intafacedCode: 'identity.mfa_reset_unconfigured' } },
          }),
          { status: 412 },
        ),
    });
    await lostAuthenticator();
    await act(async () => set('mfaResetPassword', 'a long enough password'));
    await submit('Email me a code');
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[role=alert]')?.textContent).toContain('its waiting time is not set'));
    });
    expect(host.querySelector<HTMLAnchorElement>('a[href="/help"]')!.textContent).toBe('Write to Support');
  });

  it('a wrong code says so and keeps the code step', async () => {
    const codeExpiresAt = new Date(Date.now() + 600_000).toISOString();
    answer({
      'mfaReset.start': ok({ state: 'code_sent', resetId: RESET, email: 's•••@example.invalid', codeExpiresAt }),
      'mfaReset.confirm': () =>
        new Response(JSON.stringify({ error: { message: 'bad', data: { code: 'UNAUTHORIZED', intafacedCode: 'auth.code_invalid' } } }), {
          status: 401,
        }),
    });
    await lostAuthenticator();
    await act(async () => set('mfaResetPassword', 'a long enough password'));
    await submit('Email me a code');
    await act(async () => {
      await vi.waitFor(() => expect(field('mfaResetCode')).not.toBeNull());
    });
    await act(async () => set('mfaResetCode', '000000'));
    await submit('Start the reset');
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[role=alert]')?.textContent).toContain('That code is not right'));
    });
    expect(field('mfaResetCode').value).toBe('');
    expect(host.querySelector('a[href="/help"]')).toBeNull();
  });

  it('"Back to sign in" returns to the form', async () => {
    await lostAuthenticator();
    await submit('Back to sign in');
    expect(field('password')).not.toBeNull();
    expect(host.querySelector('.public-auth-mfa-reset')).toBeNull();
  });
});

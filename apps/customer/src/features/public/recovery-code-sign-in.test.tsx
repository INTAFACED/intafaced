// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session/session';
import { AuthForm } from './AuthForm';

// The second step by recovery code on /login (I-signin-sessions-12, J-identity-05 #1): "Use a recovery code" turns the
// code field into a recovery-code field, and a sign-in that spent one says so, with the count left, before moving on.
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
const USER = '7c1f6b8e-2d4a-4f3b-9a5e-1b2c3d4e5f60';

const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === name);
const labelOf = (input: HTMLInputElement) => host.querySelector(`label[for="${input.id}"]`)?.textContent ?? input.labels?.[0]?.textContent;
const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

function set(name: string, value: string) {
  const input = field(name);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** `auth.login` answers with `login`; the boot refresh answers "no session"; everything else is unavailable. */
function answerLogin(login: () => Response) {
  fetcher.mockImplementation(async (url: string) =>
    String(url).includes('auth.refresh')
      ? new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 })
      : String(url).includes('auth.login')
        ? login()
        : new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 }),
  );
}

async function signIn(code?: string) {
  await act(async () => {
    set('identifier', 'someone@example.invalid');
    set('password', 'a long enough password');
    if (code !== undefined) set('totp', code);
  });
  await act(async () => buttonNamed('Sign in')!.click());
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  answerLogin(() => new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 }));
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

describe('a recovery code at the second step', () => {
  it('offers "Use a recovery code" with the second step, and the field then asks for one', async () => {
    expect(buttonNamed('Use a recovery code')).toBeUndefined();
    answerLogin(
      () =>
        new Response(JSON.stringify({ error: { message: 'Second step required', data: { intafacedCode: 'auth.mfa_required' } } }), {
          status: 401,
        }),
    );
    await signIn();
    await act(async () => {
      await vi.waitFor(() => expect(buttonNamed('Use a recovery code')).toBeDefined());
    });
    expect(labelOf(field('totp'))).toContain('Two-factor or recovery code');
    await act(async () => buttonNamed('Use a recovery code')!.click());
    expect(labelOf(field('totp'))).toContain('Recovery code');
    expect(host.textContent).toContain('Each recovery code works once.');
    expect(buttonNamed('Use the authenticator app instead')).toBeDefined();
  });

  it('after a sign-in that spent one: the code is spent, the count left shows, and nothing moves on by itself', async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    answerLogin(
      () => new Response(JSON.stringify({ result: { data: { accessToken: 'token', expiresAt, userId: USER, recoveryCodesLeft: 7 } } })),
    );
    await signIn('ABCDE-12345');
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('.public-auth-recovery-used')).not.toBeNull());
    });
    const panel = host.querySelector('.public-auth-recovery-used')!;
    expect(panel.textContent).toContain('That recovery code is now spent');
    expect(panel.textContent).toContain('Recovery codes left: 7');
    expect(panel.textContent).not.toContain('no recovery codes left');
    expect(location.pathname).toBe('/login');
    await act(async () => buttonNamed('Continue')!.click());
    expect(location.pathname).toBe('/money');
  });

  it('shows no interruption notice beside it, and leaving the address drops it', async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    answerLogin(
      () => new Response(JSON.stringify({ result: { data: { accessToken: 'token', expiresAt, userId: USER, recoveryCodesLeft: 3 } } })),
    );
    await signIn('ABCDE-12345');
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('.public-auth-recovery-used')).not.toBeNull());
    });
    expect(host.querySelector('.public-auth-feedback')).toBeNull();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')!.textContent).toBe('Signed in with a recovery code');
    await act(async () => {
      history.pushState(null, '', '/login?redirect=%2Ftrade');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.querySelector('.public-auth-recovery-used')).toBeNull();
  });

  it('with the last code spent, it says none are left and points to Security', async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    answerLogin(
      () => new Response(JSON.stringify({ result: { data: { accessToken: 'token', expiresAt, userId: USER, recoveryCodesLeft: 0 } } })),
    );
    await signIn('ABCDE-12345');
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('.public-auth-recovery-used')).not.toBeNull());
    });
    expect(host.textContent).toContain('Recovery codes left: 0');
    expect(host.textContent).toContain('You have no recovery codes left.');
    await act(async () => buttonNamed('Open Security')!.click());
    expect(location.pathname).toBe('/uc/safe');
  });

  it('an authenticator code signs in and moves on at once', async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    answerLogin(() => new Response(JSON.stringify({ result: { data: { accessToken: 'token', expiresAt, userId: USER } } })));
    await signIn('123456');
    await act(async () => {
      await vi.waitFor(() => expect(location.pathname).toBe('/money'));
    });
    expect(host.querySelector('.public-auth-recovery-used')).toBeNull();
  });
});

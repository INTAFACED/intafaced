// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session/session';
import { CannotSignIn } from './CannotSignIn';
import { RecoverAccount } from './RecoverAccount';

// Support-assisted recovery (I-signin-sessions-24, J-identity-05 #5): /cannot-sign-in says how it works, and
// /recover-account spends the mailed link only when Recover is pressed, then never shows the token again.
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
const sent: { url: string; body: unknown }[] = [];
const TOKEN = 'A'.repeat(43);
const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === name);

function answer(redeem: () => Response) {
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('auth.refresh'))
      return new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 });
    if (path.includes('supportRecovery.redeem')) {
      sent.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return redeem();
    }
    return new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 });
  });
}
const refused =
  (code: string, status = 401) =>
  () =>
    new Response(JSON.stringify({ error: { message: code, data: { intafacedCode: code } } }), { status });

async function render(path: string, page: 'recover' | 'cannot') {
  history.replaceState(null, '', path);
  await act(async () => root.render(<SessionProvider>{page === 'recover' ? <RecoverAccount /> : <CannotSignIn />}</SessionProvider>));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  sent.length = 0;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('support recovery pages', () => {
  it('says a second person approves and nobody at Support sees the link', async () => {
    answer(refused('unused'));
    await render('/cannot-sign-in', 'cannot');
    expect(host.querySelector('h1')!.textContent).toBe('Locked out? A person answers');
    expect(host.textContent).toContain('A second member of Support must approve the case.');
    expect(host.textContent).toContain('Nobody at Support ever sees the link');
  });

  it('spends the link only on Recover, drops the token from the address bar, and says what happened', async () => {
    answer(() => new Response(JSON.stringify({ result: { data: { recovered: true } } })));
    await render(`/recover-account?token=${TOKEN}`, 'recover');
    expect(location.search).toBe('');
    expect(sent).toHaveLength(0);
    expect(host.textContent).not.toContain(TOKEN);
    await act(async () => buttonNamed('Recover')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('h1')!.textContent).toBe('Your account is recovered'));
    });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.body)).toContain(TOKEN);
    expect(host.querySelector('[role=status]')!.textContent).toContain('Sign in with your password');
  });

  it('a used or expired link reads as dead and points back to Support', async () => {
    answer(refused('identity.support_recovery_link_invalid'));
    await render(`/recover-account?token=${TOKEN}`, 'recover');
    await act(async () => buttonNamed('Recover')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('h1')!.textContent).toBe('This recovery link does not work'));
    });
    expect(host.querySelector('a[href="/cannot-sign-in"]')).not.toBeNull();
  });

  it('a page opened with no token never calls the service', async () => {
    answer(refused('unused'));
    await render('/recover-account', 'recover');
    expect(host.querySelector('h1')!.textContent).toBe('This recovery link does not work');
    expect(buttonNamed('Recover')).toBeUndefined();
  });
});

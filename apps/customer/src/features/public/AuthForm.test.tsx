// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session/session';
import { AuthForm } from './AuthForm';
import { publicAuthKey } from './public-auth-guards';

const guidance = 'Enter your email or handle before using a passkey.';
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
const nativeGet = vi.fn();
const authOptionsUrl = '/api/identity/trpc/webauthn.authOptions';

// Only the passkey options requests are the subject. The boot session refresh also goes through fetch.
function optionsCalls() {
  return fetcher.mock.calls.filter(([url]) => String(url).includes('webauthn.authOptions'));
}

function identifier() {
  return host.querySelector<HTMLInputElement>('input[name="identifier"]')!;
}
function passkey() {
  return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Use a passkey')!;
}
async function click() {
  await act(async () => passkey().click());
}
async function edit(value: string) {
  await act(async () => {
    // Use the native setter so React observes a real input event, rather than its value tracker.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(identifier(), value);
    identifier().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Node 25's built-in localStorage shadows the DOM environment's default.
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  // The boot refresh gets a definite "no session", so the form stops restoring. Everything else is unavailable.
  fetcher
    .mockReset()
    .mockImplementation(async (url: string) =>
      String(url).includes('auth.refresh')
        ? new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 })
        : new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 }),
    );
  nativeGet.mockReset();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  vi.stubGlobal('PublicKeyCredential', class {});
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: nativeGet } });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) },
  });
  localStorage.clear();
  history.replaceState(null, '', '/login');
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
  // run() returns early while the session is restoring, so wait for the boot refresh to answer.
  await act(async () => {
    await vi.waitFor(() => expect(passkey().disabled).toBe(false));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('passkey identifier at the rendered form', () => {
  it.each(['', '   '])('shows an associated field error for %j without starting a request', async (value) => {
    await edit(value);
    await click();
    const input = identifier();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(guidance);
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('.failure')).toBeNull();
    expect(optionsCalls()).toHaveLength(0);
    expect(nativeGet).not.toHaveBeenCalled();
    expect(localStorage.getItem(publicAuthKey)).toBeNull();
  });

  it('clears the field error immediately on an identifier edit', async () => {
    await click();
    await edit('passkey-dom@example.invalid');
    expect(identifier().getAttribute('aria-invalid')).toBe('false');
    expect(host.textContent).not.toContain(guidance);
    expect(optionsCalls()).toHaveLength(0);
  });

  it('captures a DOM autofill with no input event in the same invocation, with an empty password', async () => {
    await click();
    identifier().value = '  passkey-dom@example.invalid  ';
    await click();
    expect(optionsCalls()).toHaveLength(1);
    const [url, request] = optionsCalls()[0]!;
    expect(url).toBe(authOptionsUrl);
    expect(JSON.parse(request.body)).toEqual({ identifier: 'passkey-dom@example.invalid' });
    expect(identifier().value).toBe('  passkey-dom@example.invalid  ');
    expect(identifier().getAttribute('aria-invalid')).toBe('false');
    expect(host.querySelector<HTMLInputElement>('input[name="password"]')!.value).toBe('');
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it('clears missing-identifier feedback and private DOM values when the return context changes', async () => {
    await click();
    identifier().value = 'autofilled-before-departure@example.invalid';
    await act(async () => {
      history.pushState(null, '', '/login?redirect=%2Fuc%2Fsafe');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(identifier().value).toBe('');
    expect(identifier().getAttribute('aria-invalid')).toBe('false');
    expect(host.textContent).not.toContain(guidance);
    expect(optionsCalls()).toHaveLength(0);
  });

  it('does not bypass the secure-context guard when recovering DOM autofill', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    identifier().value = 'passkey-dom@example.invalid';
    await click();
    expect(optionsCalls()).toHaveLength(0);
    expect(nativeGet).not.toHaveBeenCalled();
    expect(localStorage.getItem(publicAuthKey)).toBeNull();
  });

  it('keeps one running request and aborts its original context before a late reply', async () => {
    let release!: (response: Response) => void;
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url: string, init: RequestInit) =>
      String(url).includes('webauthn.authOptions')
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : answer(url, init),
    );
    identifier().value = 'passkey-dom@example.invalid';
    await act(async () => {
      passkey().click();
      passkey().click();
    });
    expect(optionsCalls()).toHaveLength(1);
    const signal = optionsCalls()[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => {
      history.pushState(null, '', '/login?redirect=%2Fuc%2Fsafe');
      dispatchEvent(new PopStateEvent('popstate'));
      release(new Response(JSON.stringify({ error: { message: 'Late isolated response' } }), { status: 503 }));
    });
    expect(signal.aborted).toBe(true);
    expect(host.querySelector('.failure')).toBeNull();
    expect(identifier().value).toBe('');
    expect(location.search).toBe('?redirect=%2Fuc%2Fsafe');
    expect(nativeGet).not.toHaveBeenCalled();
  });
});

describe('password sign-in refusals the service names (J-identity-02 #2, #7)', () => {
  async function signInAnswered(status: number, data: Record<string, unknown>) {
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url: string, init: RequestInit) =>
      String(url).includes('auth.login')
        ? Promise.resolve(new Response(JSON.stringify({ error: { message: 'You do not have access to this.', data } }), { status }))
        : answer(url, init),
    );
    const set = (name: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      set('identifier', 'someone@example.invalid');
      set('password', 'a long enough password');
    });
    const submit = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Sign in')!;
    await act(async () => submit.click());
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('.failure')).not.toBeNull());
    });
    return host.querySelector('.failure')!;
  }

  it('rounds the lockout up to whole minutes from the service’s own wait', async () => {
    const alert = await signInAnswered(429, { intafacedCode: 'auth.too_many_attempts', retryAfterSeconds: 842 });
    expect(alert.textContent).toBe('Too many tries. You can try again in 15 min.');
  });

  it('names a frozen account and points to support', async () => {
    const alert = await signInAnswered(403, { intafacedCode: 'auth.account_frozen', accountState: 'frozen' });
    expect(alert.textContent).toContain('This account is frozen.');
    expect(alert.querySelector('a')!.getAttribute('href')).toBe('/help');
  });

  it('names a closed account as final', async () => {
    const alert = await signInAnswered(403, { intafacedCode: 'auth.account_frozen', accountState: 'closed' });
    expect(alert.textContent).toContain('A closed account cannot be reopened.');
  });

  it('falls back to the plain refusal when the service names no state', async () => {
    const alert = await signInAnswered(403, { intafacedCode: 'auth.account_frozen' });
    expect(alert.textContent).not.toContain('This account is');
  });
});

describe('language switcher on the sign-in page (RC-home-ia-05)', () => {
  it('chooses Spanish before sign-in: kept in this browser, shown at once, and nothing is sent', async () => {
    const before = fetcher.mock.calls.length;
    const select = host.querySelector<HTMLSelectElement>('[data-language-menu] select')!;
    expect(select).not.toBeNull();
    expect(host.querySelector('[data-language-kept="browser"]')?.textContent).toBe('Saved in this browser only.');
    await act(async () => {
      select.value = 'es';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(JSON.parse(localStorage.getItem('intafaced.customer.view.v1')!)).toMatchObject({ language: 'es' });
    expect(host.querySelector('[data-language-menu] label')?.textContent).toBe('Idioma');
    expect(fetcher.mock.calls.length).toBe(before);
    expect(localStorage.getItem(publicAuthKey)).toBeNull();
  });
});

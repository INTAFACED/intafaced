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
  fetcher
    .mockReset()
    .mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 }));
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
    expect(fetcher).not.toHaveBeenCalled();
    expect(nativeGet).not.toHaveBeenCalled();
    expect(localStorage.getItem(publicAuthKey)).toBeNull();
  });

  it('clears the field error immediately on an identifier edit', async () => {
    await click();
    await edit('passkey-dom@example.invalid');
    expect(identifier().getAttribute('aria-invalid')).toBe('false');
    expect(host.textContent).not.toContain(guidance);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('captures a DOM autofill with no input event in the same invocation, with an empty password', async () => {
    await click();
    identifier().value = '  passkey-dom@example.invalid  ';
    await click();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/identity/trpc/webauthn.authOptions');
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
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not bypass the secure-context guard when recovering DOM autofill', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    identifier().value = 'passkey-dom@example.invalid';
    await click();
    expect(fetcher).not.toHaveBeenCalled();
    expect(nativeGet).not.toHaveBeenCalled();
    expect(localStorage.getItem(publicAuthKey)).toBeNull();
  });

  it('keeps one running request and aborts its original context before a late reply', async () => {
    let release!: (response: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    identifier().value = 'passkey-dom@example.invalid';
    await act(async () => {
      passkey().click();
      passkey().click();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
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

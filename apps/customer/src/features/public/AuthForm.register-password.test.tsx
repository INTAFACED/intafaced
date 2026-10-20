// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session/session';
import { AuthForm } from './AuthForm';

let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
const registerCalls = () => fetcher.mock.calls.filter(([url]) => String(url).includes('auth.register'));

async function fill(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  fetcher
    .mockReset()
    .mockImplementation(async (url: string) =>
      String(url).includes('auth.refresh')
        ? new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 })
        : new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 }),
    );
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) },
  });
  history.replaceState(null, '', '/register');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <SessionProvider>
        <AuthForm register />
      </SessionProvider>,
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('input[name="handle"]')).not.toBeNull());
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('register: a password the service cannot accept is caught before it is sent', () => {
  it.each([
    ['one character repeated', 'a'.repeat(14)],
    ['more than 72 bytes', 'x'.repeat(73)],
  ])('refuses %s with the rule on screen and sends nothing', async (_name, password) => {
    await fill('handle', 'test_user');
    await fill('identifier', 'test@example.test');
    await fill('password', password);
    await submit();
    expect(host.textContent).toContain('Choose a password of at least 12 characters and at most 72 bytes, and not one character repeated.');
    expect(registerCalls()).toHaveLength(0);
  });

  it('sends a password that meets the rules', async () => {
    await fill('handle', 'test_user');
    await fill('identifier', 'test@example.test');
    await fill('password', 'a-fine-password-1');
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(registerCalls().length).toBeGreaterThan(0));
    });
  });
});

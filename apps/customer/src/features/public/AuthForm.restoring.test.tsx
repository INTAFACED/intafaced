// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider, useSession, type Session } from '../session/session';
import { AuthForm } from './AuthForm';

// What is typed while the boot refresh is answering stays when it answers. A restored session used to count as a change
// of person and wipe the fields, so Sign in then submitted an empty form (J-more-catalogue-09 #7 in Real-app journeys
// run 1138, #7113). A real change of person afterwards still drops everything typed.
let host: HTMLDivElement, root: Root;
let commit: (session: Session) => void;
const fetcher = vi.fn();
const USER = '6f0c2a4e-3b1d-4c5e-9f7a-2b8d1e0c4a6f';
const OTHER = '0b7e4d2c-9a1f-4e3b-8c5d-6f2a1e9b7c4d';
const session = (userId: string, accessToken: string): Session => ({ accessToken, expiresAt: '2099-01-01T00:00:00.000Z', userId });

const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const signIn = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Sign in')!;
const typed = () => [field('identifier').value, field('password').value];

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    // The native setter, so React sees a real input event rather than its value tracker.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function Commit() {
  commit = useSession().commit;
  return null;
}

/** Renders the sign-in form with the boot refresh held open; the returned function answers it. */
async function renderWithHeldRefresh() {
  let answer!: (response: Response) => void;
  const refresh = new Promise<Response>((resolve) => (answer = resolve));
  fetcher.mockImplementation(async (url: string) =>
    String(url).includes('auth.refresh')
      ? refresh
      : new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 }),
  );
  await act(async () =>
    root.render(
      <SessionProvider>
        <Commit />
        <AuthForm register={false} />
      </SessionProvider>,
    ),
  );
  return async (response: Response) => {
    await act(async () => {
      answer(response);
      await vi.waitFor(() => expect(signIn().disabled).toBe(false));
    });
  };
}

const restored = () => new Response(JSON.stringify({ result: { data: session(USER, 'a1') } }), { status: 200 });
const noSession = () =>
  new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Node 25's built-in localStorage shadows the DOM environment's default.
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) },
  });
  localStorage.clear();
  history.replaceState(null, '', '/login');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the sign-in form while the boot refresh is answering', () => {
  it('keeps what was typed when a restored session lands, and Sign in waits for it', async () => {
    const settle = await renderWithHeldRefresh();
    expect(signIn().disabled).toBe(true);
    await type(field('identifier'), 'someone@example.invalid');
    await type(field('password'), 'TEST-password');
    await settle(restored());
    expect(typed()).toEqual(['someone@example.invalid', 'TEST-password']);
    expect(signIn().disabled).toBe(false);
  });

  it('keeps what was typed when the refresh answers that there is no session', async () => {
    const settle = await renderWithHeldRefresh();
    await type(field('identifier'), 'someone@example.invalid');
    await type(field('password'), 'TEST-password');
    await settle(noSession());
    expect(typed()).toEqual(['someone@example.invalid', 'TEST-password']);
  });

  it('still drops what was typed when another person’s session arrives after the refresh answered', async () => {
    const settle = await renderWithHeldRefresh();
    await settle(restored());
    await type(field('identifier'), 'someone@example.invalid');
    await type(field('password'), 'TEST-password');
    await act(async () => commit(session(OTHER, 'b1')));
    expect(typed()).toEqual(['', '']);
  });

  it('still drops what was typed when a session arrives after a no-session answer', async () => {
    const settle = await renderWithHeldRefresh();
    await settle(noSession());
    await type(field('identifier'), 'someone@example.invalid');
    await act(async () => commit(session(OTHER, 'b1')));
    expect(field('identifier').value).toBe('');
  });
});

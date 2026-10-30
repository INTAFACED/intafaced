// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session/session';
import { AuthForm } from './AuthForm';

// A sign-in to an account its owner froze (J-identity-11 #3): account status is read once the session is in place, and
// the person lands on their own freeze, named with when it started and how they lift it, never on a generic error.
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

const unavailable = () => new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 });

/** `auth.login` signs in, `accountStatus.mine` answers with `status`; the boot refresh answers "no session". */
function answer(status: () => Response) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  fetcher.mockImplementation(async (url: string) =>
    String(url).includes('auth.refresh')
      ? new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 })
      : String(url).includes('auth.login')
        ? new Response(JSON.stringify({ result: { data: { accessToken: 'token', expiresAt, userId: USER } } }))
        : String(url).includes('accountStatus.mine')
          ? status()
          : unavailable(),
  );
}

const SINCE = '2026-10-29T10:00:00.000Z';
function frozenSelf(availableAt: string | null) {
  return new Response(
    JSON.stringify({
      result: {
        data: {
          state: 'frozen_self',
          reasonCode: null,
          since: SINCE,
          restrictions: [
            {
              kind: 'self_freeze',
              reasonCode: null,
              since: SINCE,
              blocks: ['create_api_key'],
              lift: { by: 'owner_after_wait', availableAt },
              capability: null,
              owner: null,
            },
          ],
          canStill: ['sign_in', 'trade'],
          cannot: [{ action: 'create_api_key', kind: 'self_freeze' }],
        },
      },
    }),
  );
}
const active = () =>
  new Response(
    JSON.stringify({
      result: { data: { state: 'active', reasonCode: null, since: null, restrictions: [], canStill: ['sign_in'], cannot: [] } },
    }),
  );

async function signIn() {
  await act(async () => {
    set('identifier', 'someone@example.invalid');
    set('password', 'a long enough password');
  });
  await act(async () => buttonNamed('Sign in')!.click());
}
const page = () => host.querySelector('[data-testid="frozen-by-you"]');

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  answer(unavailable);
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

describe('signing in to an account its owner froze', () => {
  it('lands on the freeze, named as their own, with when they can lift it, and nothing moves on by itself', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    answer(() => frozenSelf(later));
    await signIn();
    await act(async () => {
      await vi.waitFor(() => expect(page()).not.toBeNull());
    });
    expect(page()!.getAttribute('data-state')).toBe('frozen_self');
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')!.textContent).toBe('You froze this account');
    expect(page()!.querySelector('[data-testid="frozen-by-you__lift"]')!.getAttribute('data-lift')).toBe('liftAt');
    expect(page()!.textContent).toContain('You can reactivate it yourself from');
    expect(host.querySelector('.failure')).toBeNull();
    // What the freeze stops comes from identity's answer, and the session landing is never read as an interruption.
    expect(
      Array.from(page()!.querySelectorAll('[data-testid="frozen-by-you__stops"] li')).map((li) => li.getAttribute('data-action')),
    ).toEqual(['create_api_key']);
    expect(page()!.textContent).toContain('Create API keys');
    expect(host.querySelector('.public-auth-feedback')).toBeNull();
    expect(host.querySelector('form')).toBeNull();
    expect(location.pathname).toBe('/login');
    await act(async () => buttonNamed('Reactivate in Security')!.click());
    expect(location.pathname).toBe('/uc/safe');
  });

  it('says the lift is open once the wait has passed, and Continue goes where the sign-in was headed', async () => {
    answer(() => frozenSelf(new Date(Date.now() - 1_000).toISOString()));
    await signIn();
    await act(async () => {
      await vi.waitFor(() => expect(page()).not.toBeNull());
    });
    expect(page()!.querySelector('[data-testid="frozen-by-you__lift"]')!.getAttribute('data-lift')).toBe('liftNow');
    await act(async () => buttonNamed('Continue')!.click());
    expect(location.pathname).toBe('/money');
  });

  it('turns to "reactivate now" when the wait ends while the page is open', async () => {
    answer(() => frozenSelf(new Date(Date.now() + 1_500).toISOString()));
    await signIn();
    await act(async () => {
      await vi.waitFor(() => expect(page()).not.toBeNull());
    });
    const lift = () => page()!.querySelector('[data-testid="frozen-by-you__lift"]')!.getAttribute('data-lift');
    expect(lift()).toBe('liftAt');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_800));
    });
    expect(lift()).toBe('liftNow');
  });

  it('a person who leaves while the status is read is not moved on when it answers', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    answer(active);
    const plain = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('accountStatus.mine')) await held;
      return plain(url, init);
    });
    await signIn();
    expect(host.querySelector('form')).toBeNull();
    await act(async () => {
      history.pushState(null, '', '/help');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await act(async () => {
      release();
      await held;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(location.pathname).toBe('/help');
  });

  it('says reactivation is refused when the owner set no wait', async () => {
    answer(() => frozenSelf(null));
    await signIn();
    await act(async () => {
      await vi.waitFor(() => expect(page()).not.toBeNull());
    });
    expect(page()!.textContent).toContain('Reactivation is refused: no waiting time is set for lifting a freeze, so it cannot open.');
  });

  it('an active account moves on at once', async () => {
    answer(active);
    await signIn();
    await act(async () => {
      await vi.waitFor(() => expect(location.pathname).toBe('/money'));
    });
    expect(page()).toBeNull();
  });

  it('a status read that fails moves on as before; identity still refuses what a freeze stops', async () => {
    answer(unavailable);
    await signIn();
    await act(async () => {
      await vi.waitFor(() => expect(location.pathname).toBe('/money'));
    });
    expect(page()).toBeNull();
  });
});

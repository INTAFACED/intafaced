// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session/session';
import { FreezeConfirm } from './FreezeConfirm';

// The freeze link from a security notice (I-account-lifecycle-08, J-identity-11 #2): /freeze/confirm spends the link
// only when Freeze my account is pressed, drops the token from the address bar, and a second use shows the stored result.
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
const sent: { url: string; body: unknown }[] = [];
const TOKEN = 'F'.repeat(43);
const SINCE = '2026-10-29T21:00:00.000Z';
const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === name);

function answer(redeem: () => Response) {
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('auth.refresh'))
      return new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 });
    if (path.includes('freezeLink.redeem')) {
      sent.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return redeem();
    }
    return new Response(JSON.stringify({ error: { message: 'Isolated unavailable' } }), { status: 503 });
  });
}
const ok =
  (firstUse: boolean, frozenNow = true) =>
  () =>
    new Response(JSON.stringify({ result: { data: { frozen: true, since: SINCE, firstUse, frozenNow } } }));
const refused = (code: string) => () =>
  new Response(JSON.stringify({ error: { message: code, data: { intafacedCode: code } } }), { status: 401 });

async function render(path: string) {
  history.replaceState(null, '', path);
  await act(async () =>
    root.render(
      <SessionProvider>
        <FreezeConfirm />
      </SessionProvider>,
    ),
  );
}
async function press() {
  await act(async () => buttonNamed('Freeze my account')!.click());
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

describe('freeze link page', () => {
  it('spends the link only on Freeze my account, drops the token, and says the account is frozen', async () => {
    answer(ok(true));
    await render(`/freeze/confirm#token=${TOKEN}`);
    expect(location.hash).toBe('');
    expect(location.search).toBe('');
    expect(sent).toHaveLength(0);
    expect(host.textContent).not.toContain(TOKEN);
    await press();
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('h1')!.textContent).toBe('Your account is frozen'));
    });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.body)).toContain(TOKEN);
    expect(host.querySelector('[role=status] time')!.getAttribute('datetime')).toBe(SINCE);
  });

  it('a link used before shows the stored result and says nothing changed', async () => {
    answer(ok(false));
    await render(`/freeze/confirm#token=${TOKEN}`);
    await press();
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('h1')!.textContent).toBe('This link was already used'));
    });
    expect(host.querySelector('[role=status]')!.textContent).toContain('Nothing changed now.');
    expect(host.querySelector('[role=status]')!.textContent).not.toContain('lifted');
  });

  it('a used link whose freeze was lifted since says the account is not frozen now', async () => {
    answer(ok(false, false));
    await render(`/freeze/confirm#token=${TOKEN}`);
    await press();
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('h1')!.textContent).toBe('This link was already used'));
    });
    expect(host.querySelector('[role=status]')!.getAttribute('data-frozen-now')).toBe('false');
    expect(host.querySelector('[role=status]')!.textContent).toContain('your account is not frozen now');
  });

  it('an unknown link is the one dead page, and a page with no token never calls the service', async () => {
    answer(refused('identity.freeze_link_invalid'));
    await render(`/freeze/confirm#token=${TOKEN}`);
    await press();
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('h1')!.textContent).toBe('This freeze link does not work'));
    });
    await act(async () => root.unmount());
    root = createRoot(host);
    sent.length = 0;
    await render('/freeze/confirm');
    expect(host.querySelector('h1')!.textContent).toBe('This freeze link does not work');
    expect(buttonNamed('Freeze my account')).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});

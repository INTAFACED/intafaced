// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue 10314: a signed-in person on help, status, notices, fees or the developer pages saw the signed-out website header
// ("Open your account") instead of the app header.
const state = vi.hoisted(() => ({ signedIn: true }));
vi.mock('../features/session/session', async (original) => {
  const real = await original<typeof import('../features/session/session')>();
  const api = {
    query: () => new Promise(() => undefined),
    mutate: () => new Promise(() => undefined),
    call: () => new Promise(() => undefined),
    rest: () => new Promise(() => undefined),
    canWrite: () => false,
  };
  const value = () => ({
    session: state.signedIn ? { userId: '11111111-1111-4111-8111-111111111111' } : null,
    userId: state.signedIn ? '11111111-1111-4111-8111-111111111111' : null,
    api,
    restoring: false,
    restoreFailed: false,
    retryRestore: () => undefined,
    commit: () => undefined,
    clear: () => undefined,
    logout: async () => ({ ok: true, data: { ok: true } }),
    retryLogout: async () => ({ ok: true, data: { ok: true } }),
    notice: null,
    subAccountWaiting: false,
    mode: 'Personal',
    profiles: { list: [], business: null, select: () => undefined },
    enterSubAccount: async () => ({ ok: false }),
    leaveSubAccount: async () => ({ ok: false }),
  });
  return { ...real, useSession: () => value() as never, useApi: () => api as never };
});

import { App } from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await import('../features/public/PublicRoutes');
}, 60_000);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  state.signedIn = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open(path: string) {
  history.replaceState(null, '', path);
  await act(async () => root.render(<App />));
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('.public-shell')).not.toBeNull());
  });
}

// Every public room the 2026-11-23 beta sweep found, and the two the issue's done-line names.
const INFORMATION = [
  '/help',
  '/help/mule-policy',
  '/help/official-channels',
  '/status',
  '/notice',
  '/about-us',
  '/invite',
  '/partner',
  '/helpdetail',
  '/developers/quant',
  '/app',
  '/fees',
  '/rulebook',
  '/lab',
];

describe('a signed-in person keeps the app header on public pages (#10314)', () => {
  for (const path of INFORMATION) {
    it(`${path} opens inside the app frame, with one main and no website header`, async () => {
      await open(path);
      expect(host.querySelector('.if-app [data-testid="tb-tab"]')).not.toBeNull();
      expect(host.querySelector('.public-header')).toBeNull();
      expect(host.textContent).not.toContain('Open your account');
      expect(host.querySelectorAll('main')).toHaveLength(1);
    });
  }

  it('keeps the website frame on a sign-in step', async () => {
    await open('/login');
    expect(host.querySelector('.public-header')).not.toBeNull();
    expect(host.querySelector('.if-app')).toBeNull();
  });

  it('keeps the website header for a signed-out visitor, with a phone menu holding its links', async () => {
    state.signedIn = false;
    await open('/help');
    expect(host.querySelector('.if-app')).toBeNull();
    const menu = host.querySelector('.public-header details.public-menu');
    expect(menu?.querySelector('summary')?.textContent).toBe('Menu');
    expect([...(menu?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))).toEqual(['/exchange', '/help', '/about-us']);
    expect(host.querySelectorAll('main')).toHaveLength(1);
  });
});

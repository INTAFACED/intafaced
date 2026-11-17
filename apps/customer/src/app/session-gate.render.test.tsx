// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A stored session: the boot refresh is still on its way, so the session is not known yet (#8658).
const state = vi.hoisted(() => ({ restoring: true, restoreFailed: false }));
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../features/session/session', async (original) => {
  const real = await original<typeof import('../features/session/session')>();
  const api = {
    query: () => {
      reads.count += 1;
      return new Promise(() => undefined);
    },
    mutate: () => new Promise(() => undefined),
    canWrite: () => false,
  };
  const value = () => ({
    session: null,
    userId: null,
    api,
    restoring: state.restoring,
    restoreFailed: state.restoreFailed,
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

// The rooms' chunks load first, so a room the gate lets through renders inside the wait below instead of hiding behind Suspense.
beforeAll(async () => {
  await Promise.all([import('../features/public/PublicRoutes'), import('../features/protocol/ProtocolRoutes'), import('./Web3Shell')]);
}, 60_000);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.restoring = true;
  state.restoreFailed = false;
  reads.count = 0;
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
  // Let any room chunk the app would load arrive, so a room that renders early is caught.
  for (let i = 0; i < 20; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

// Rooms that open for both a signed-in and a signed-out person: `/`, public pages, a Web3 room, rooms under the shell, and
// the rooms whose own restore checks this gate replaced (#7113, #7355, #7586, #8342).
const BOTH = [
  '/',
  '/help',
  '/fees/my-tier',
  '/dex',
  '/academy',
  '/quant/editor',
  '/launch',
  '/ops',
  '/trade/bots/signals/publish',
  '/trade/bots/webhooks',
];

describe('no room renders while the stored session is still restoring (#8658)', () => {
  for (const path of BOTH) {
    it(`${path} shows only the opening state, no signed-out control, and runs no read`, async () => {
      await open(path);
      expect(host.querySelector('[data-testid="page"]')?.textContent).toContain('Opening room');
      expect(host.textContent).not.toMatch(/Sign in|Sign up|Log in|Connect wallet|signed out/i);
      expect(host.querySelector('header, nav, main h1')).toBeNull();
      expect(reads.count).toBe(0);
    });
  }

  it('renders the room once the boot refresh has answered', async () => {
    await open('/help');
    state.restoring = false;
    await act(async () => root.render(<App />));
    for (let i = 0; i < 20; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(host.textContent).not.toContain('Opening room');
    expect(host.querySelector('header')).not.toBeNull();
  });
});

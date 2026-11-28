// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { readFileSync } from 'node:fs';

const sheet = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const VOLT = sheet('./volt.css');
const PUBLIC = sheet('../features/public/public.css');
const BRAND = sheet('../../../../packages/ui/src/brand/brand.css');

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

async function open(path: string, frame: string) {
  history.replaceState(null, '', path);
  await act(async () => root.render(<App />));
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector(frame)).not.toBeNull());
  });
}

/** The header's brand link draws the lockup, mark and wordmark, and nothing else: no mark-only twin to swap in. */
function expectFullBrand(header: Element | null) {
  expect(header).not.toBeNull();
  const lockup = header!.querySelector('[data-slot="brand-lockup"]');
  expect(lockup, 'the header draws the brand lockup').not.toBeNull();
  expect(lockup!.querySelector('[data-part="wordmark"]'), 'the lockup carries the wordmark').not.toBeNull();
  const link = lockup!.closest('a');
  expect(link?.querySelectorAll('svg')).toHaveLength(1);
}

/** Rules that hide a brand part: a selector naming the brand whose block sets display: none. */
function hidingRules(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector, block]) => /brand|lockup/i.test(selector!) && /display:\s*none/.test(block!))
    .map(([, selector]) => selector!.trim());
}

// Nino, 25 Nov: the logo and wordmark the same on every screen. Every top bar, app and public, carries the mark and the
// wordmark at every width; a phone never swaps in the mark alone.
describe('every top bar carries the mark and the wordmark at every width', () => {
  it('the app bar', async () => {
    await open('/help', '.if-app');
    expectFullBrand(host.querySelector('.tb'));
  });

  it('the public header (sign in, sign up, the landing)', async () => {
    state.signedIn = false;
    await open('/login', '.public-shell');
    expectFullBrand(host.querySelector('.public-header'));
  });

  it('no stylesheet hides the brand at any width (a 390 phone included)', () => {
    // The sheets are read as written (a read that came back empty would pass anything).
    for (const sheet of [VOLT, PUBLIC, BRAND]) expect(sheet).toContain('brand');
    expect(hidingRules(VOLT)).toEqual([]);
    expect(hidingRules(PUBLIC)).toEqual([]);
    expect(hidingRules(BRAND)).toEqual([]);
  });
});

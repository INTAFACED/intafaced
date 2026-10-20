// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only. Each test chooses who is signed in, what the three identity reads answer and which profiles exist.
const USER = '12345678-1234-4234-8234-123456789abc';
const world = vi.hoisted(() => ({
  reads: {} as Record<string, () => Promise<unknown>>,
  profiles: {} as unknown,
  navigated: [] as string[],
}));
vi.mock('../features/session/session', () => ({
  useSession: () => ({
    userId: USER,
    profiles: world.profiles,
    api: { query: (_module: string, procedure: string) => world.reads[procedure]!() },
  }),
}));
vi.mock('./location', async (original) => {
  const real = await original<typeof import('./location')>();
  return { ...real, navigate: (to: string) => void world.navigated.push(to) };
});

import { AccountMenuBody } from './AccountMenu';
import { currentPreferences, savePreferences } from '../shared/preferences';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
let closed = 0;
let signedOut = 0;
const ok = (data: unknown) => () => Promise.resolve({ ok: true, data });
const fail = () => Promise.resolve({ ok: false, reason: 'error', message: 'down' });
const pending = () => new Promise(() => undefined);
const profiles = (over: Record<string, unknown> = {}) => ({
  status: 'ready',
  businesses: [],
  active: 'personal',
  business: null,
  notice: null,
  reload: vi.fn(),
  ...over,
});
const coffee = { id: 'business:b1', accountId: 'b1', name: 'TEST Coffee' };
const tick = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function open() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<AccountMenuBody close={() => closed++} onSignOut={() => signedOut++} />));
  await tick();
}
const link = (text: string) => [...host.querySelectorAll('a,button')].find((node) => node.textContent?.includes(text));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  closed = 0;
  signedOut = 0;
  world.navigated = [];
  world.profiles = profiles();
  world.reads = {
    me: ok({ userId: USER, handle: 'test_user' }),
    'profile.get': ok({ displayName: 'TEST Person', locale: 'en', region: null, version: 1 }),
    'kyc.status': ok({ tier: 'basic', records: [] }),
  };
  localStorage.clear();
  savePreferences({ activeProfile: 'personal', language: 'en' });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('account menu', () => {
  it('shows the name, handle, a short account id and the verification level', async () => {
    await open();
    const summary = host.querySelector('[data-testid="account-summary"]')!;
    expect(summary.textContent).toContain('TEST Person');
    expect(summary.textContent).toContain('@test_user');
    expect(summary.textContent).toContain('Account ID 12345678…');
    expect(summary.textContent).toContain('Verification: Basic');
    expect(summary.textContent).not.toContain(USER);
  });

  it('shows a skeleton while the reads are out, never a wrong name', async () => {
    world.reads = { me: pending, 'profile.get': pending, 'kyc.status': pending };
    await open();
    const summary = host.querySelector('[data-testid="account-summary"]')!;
    expect(summary.getAttribute('aria-busy')).toBe('true');
    expect(summary.textContent).not.toContain('TEST');
    expect(summary.textContent).not.toContain('Not shown');
  });

  it('says "Not shown" for what could not be read, and keeps what could', async () => {
    world.reads['profile.get'] = fail;
    world.reads['kyc.status'] = fail;
    await open();
    const summary = host.querySelector('[data-testid="account-summary"]')!;
    expect(summary.textContent).toContain('@test_user');
    expect(summary.textContent).toContain('Verification: Not shown');
    expect(summary.textContent).not.toContain('Not verified');
  });

  it('lists the entries in the order of the navigation spec', async () => {
    world.profiles = profiles({ businesses: [coffee] });
    await open();
    const order = [
      'Profile',
      'Personal',
      'TEST Coffee · Business',
      'Sub-accounts',
      'Language',
      'Theme',
      'Account',
      'Security',
      'Verification',
      'API keys and apps',
      'Sign out',
    ];
    const text = host.textContent ?? '';
    let at = -1;
    for (const label of order) {
      const next = text.indexOf(label, at + 1);
      expect(next, label).toBeGreaterThan(at);
      at = next;
    }
  });

  it('marks Personal active and offers to open a business account when the person has none', async () => {
    await open();
    expect(host.querySelector('[data-testid="profile-personal"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-testid="open-business"]')?.getAttribute('href')).toBe('/pay/onboarding');
  });

  it('does not offer to open a business account when the list could not be read, and says so with a way to retry', async () => {
    const reload = vi.fn();
    world.profiles = profiles({ status: 'unread', reload });
    await open();
    expect(host.querySelector('[data-testid="open-business"]')).toBeNull();
    expect(host.textContent).toContain('Business accounts could not be read. Only Personal is shown.');
    await act(async () => (link('Try again') as HTMLElement).click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('picking a business saves the choice and opens the merchant portal', async () => {
    world.profiles = profiles({ businesses: [coffee] });
    await open();
    await act(async () => (host.querySelector('[data-testid="profile-business"]') as HTMLElement).click());
    expect(currentPreferences().activeProfile).toBe('business:b1');
    expect(world.navigated).toEqual(['/pay/merchant']);
    expect(closed).toBe(1);
  });

  it('picking Personal saves the choice and stays where it is', async () => {
    savePreferences({ activeProfile: 'business:b1' });
    world.profiles = profiles({ businesses: [coffee], active: 'business:b1', business: coffee });
    await open();
    expect(host.querySelector('[data-testid="profile-business"]')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => (host.querySelector('[data-testid="profile-personal"]') as HTMLElement).click());
    expect(currentPreferences().activeProfile).toBe('personal');
    expect(world.navigated).toEqual([]);
  });

  it('says when a stored business is no longer one of theirs', async () => {
    world.profiles = profiles({ notice: 'gone' });
    await open();
    expect(host.querySelector('[data-testid="profile-gone"]')?.textContent).toContain('Personal is shown');
  });

  it('shows the language and the theme as drawn, both opening View', async () => {
    await open();
    expect(link('Language')?.getAttribute('href')).toBe('/view');
    expect(link('Language')?.textContent).toContain('English');
    expect(link('Theme')?.getAttribute('href')).toBe('/view');
    expect(link('Theme')?.textContent).toMatch(/Dark|Light/);
  });

  it('signs out through the one handler and closes the menu', async () => {
    await open();
    await act(async () => (link('Sign out') as HTMLElement).click());
    expect(signedOut).toBe(1);
    expect(closed).toBe(1);
  });
});

import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.stubGlobal('location', new URL('https://app.example.com/launch'));
vi.stubGlobal('history', { state: null, replaceState: () => undefined, pushState: () => undefined });

// The sign-in link reads the address through a browser store; on the server it is the stubbed /launch.
vi.mock('../../app/location', async (original) => {
  const real = await original<typeof import('../../app/location')>();
  return { ...real, useReturnLocation: () => '/launch', currentReturnLocation: () => '/launch' };
});

const state = { userId: null as string | null, restoreFailed: false };
vi.mock('../session/session', () => ({
  useSession: () => ({ ...state, retryRestore: () => undefined, api: {} }),
  useApi: () => ({}),
}));

import { Launch, type LaunchTab } from './LaunchAvailability';

const page = (tab: LaunchTab) => renderToString(<Launch tab={tab} />);
const PRIVATE: [LaunchTab, string][] = [
  ['Journey', '/launch/new'],
  ['Check', '/launch/check'],
  ['Participation', '/uc/innovation/myorders'],
];

describe('signed-out /launch (J-more-catalogue-01 #6, J-more-catalogue-11)', () => {
  beforeEach(() => Object.assign(state, { userId: null, restoreFailed: false }));

  it('shows the shared sign-in panel above the public catalogue', () => {
    const html = page('Catalogue');
    expect(html).toContain('Sign in to continue');
    expect(html).toContain('Anyone can read the launches and their terms.');
    expect(html).toContain('redirect=%2Flaunch"');
  });

  it('puts the sign-in panel in place of each private section, returning to its own address', () => {
    for (const [tab, path] of PRIVATE) {
      const html = page(tab);
      expect(html, tab).toContain('Sign in to continue');
      expect(html, tab).toContain(`redirect=${encodeURIComponent(path)}"`);
    }
  });

  it('keeps Requirements open signed out: it shows no account data', () => {
    expect(page('Requirements')).not.toContain('Sign in to continue');
  });

  // Before the boot refresh answers no room renders at all (App, #8658; src/app/session-gate.render.test.tsx).
  it('never says "signed out" when the boot refresh could not answer', () => {
    state.restoreFailed = true;
    for (const [tab] of PRIVATE) {
      const html = page(tab);
      expect(html, tab).toContain('We could not check your sign-in');
      expect(html, tab).not.toContain('Sign in to continue');
    }
    expect(page('Catalogue')).not.toContain('Sign in to continue');
  });

  it('shows a signed-in account no sign-in panel', () => {
    state.userId = 'u-1';
    for (const tab of ['Catalogue', 'Journey', 'Check', 'Participation'] as const)
      expect(page(tab), tab).not.toContain('Sign in to continue');
  });
});

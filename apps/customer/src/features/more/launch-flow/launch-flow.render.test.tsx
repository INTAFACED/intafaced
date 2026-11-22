import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.stubGlobal('location', new URL('https://app.example.com/launch/new'));
vi.stubGlobal('history', { state: null, replaceState: () => undefined, pushState: () => undefined });

const state = { userId: null as string | null, restoreFailed: false };
vi.mock('../../session/session', () => ({
  useSession: () => ({ ...state, retryRestore: () => undefined, api: {} }),
  useApi: () => ({}),
}));

import { LaunchCheckRoom } from './LaunchCheckRoom';
import { LaunchNewRoom } from './LaunchNewRoom';

const ROOMS = [
  ['/launch/new', 'New launch', () => renderToString(<LaunchNewRoom />)],
  ['/launch/check', 'Launch check', () => renderToString(<LaunchCheckRoom />)],
] as const;

describe('the Launch flow rooms on Volt (J-more-catalogue-01 #3 #6)', () => {
  beforeEach(() => Object.assign(state, { userId: null, restoreFailed: false }));

  it('titles each room as its section and keeps the scope line', () => {
    state.userId = 'u-1';
    for (const [path, title, page] of ROOMS) {
      const html = page();
      expect(html, path).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
      expect(html, path).toContain('Asset launch tasks and participation records');
    }
  });

  it('draws the five Launch sections as the kit switcher, the open one pressed', () => {
    state.userId = 'u-1';
    const open = { '/launch/new': 'Issuer journey', '/launch/check': 'Pre-listing check' } as const;
    for (const [path, , page] of ROOMS) {
      const html = page();
      const group = html.match(/<div class="lit-segmented" role="group" aria-label="Launch sections">(.*?)<\/div>/)?.[1] ?? '';
      expect(group, path).not.toBe('');
      for (const label of ['Launches', 'Issuer journey', 'Pre-listing check', 'Requirements', 'My participation'])
        expect(group, `${path} ${label}`).toMatch(new RegExp(`<button type="button" aria-pressed="(true|false)">${label}</button>`));
      expect(group.match(/aria-pressed="true"/g), path).toHaveLength(1);
      expect(group, path).toContain(`aria-pressed="true">${open[path]}</button>`);
      expect(group, path).not.toContain('href=');
    }
  });

  it('signed out, refuses with the shared sign-in words, returning to the section', () => {
    for (const [path, , page] of ROOMS) {
      const html = page();
      expect(html, path).toContain('Sign in to continue');
      expect(html, path).toContain('Your account context is needed before this room can show private information.');
      expect(html, path).toContain(`href="/login?redirect=${encodeURIComponent(path)}"`);
      expect(html, path).not.toContain('Issuer journey steps');
    }
  });

  it('never says "signed out" when the boot refresh could not answer, and offers Retry', () => {
    state.restoreFailed = true;
    for (const [path, , page] of ROOMS) {
      const html = page();
      expect(html, path).toContain('We could not check your sign-in');
      expect(html, path).toContain('>Retry</button>');
      expect(html, path).not.toContain('Sign in to continue');
    }
  });

  it('lays out the seven issuer steps, five blocked, and runs the check in place', () => {
    state.userId = 'u-1';
    const html = renderToString(<LaunchNewRoom />);
    expect(html.match(/data-step-state="/g)).toHaveLength(7);
    expect(html.match(/data-step-state="blocked"/g)).toHaveLength(5);
    expect(html).toContain('Blocked: issuance is on hold');
    expect(html).toMatch(/<button type="button" class="lit-button"[^>]*><span[^>]*>Run check<\/span><\/button>/);
    expect(html).not.toContain('href="/launch/check"');
    expect(html).toContain('Edit asset terms');
  });

  it('offers the deployer check, disabled until an address is entered', () => {
    state.userId = 'u-1';
    const html = renderToString(<LaunchCheckRoom />);
    expect(html).toContain('Pre-listing deployer check');
    expect(html).toContain('Deployer address');
    expect(html).toMatch(/<button disabled="" type="submit"[^>]*><span[^>]*>Run check<\/span><\/button>/);
  });
});

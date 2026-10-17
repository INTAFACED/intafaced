import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const state: { session: { userId: string } | null; restoring: boolean; restoreFailed: boolean } = {
  session: null,
  restoring: false,
  restoreFailed: false,
};
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  return { ...real, useSession: () => ({ ...state }) };
});

import { PublicHeader } from './PublicRoutes';

beforeEach(() => {
  vi.stubGlobal('location', { search: '', pathname: '/help', hash: '' });
  state.session = null;
  state.restoring = false;
  state.restoreFailed = false;
});

// Every public page in the 2026-10-17 run (/help, /helplist, /helpdetail, /notice, /announcement, /about-us, /invite, /app,
// /partner, /lab, /bzb) shared this header and offered "Sign in" to someone who was signed in.
const PUBLIC_PATHS = ['/help', '/helpdetail', '/notice', '/about-us', '/invite', '/app', '/partner', '/lab'];

describe('public header follows the session', () => {
  it('offers a signed-in visitor their account, not Sign in', () => {
    state.session = { userId: '11111111-1111-4111-8111-111111111111' };
    for (const path of PUBLIC_PATHS) {
      const html = renderToString(<PublicHeader path={path} />);
      expect(html, path).toContain('href="/home"');
      expect(html, path).toContain('Open your account');
      expect(html, path).not.toContain('Sign in');
      expect(html, path).not.toContain('/login');
    }
  });

  it('still offers a signed-out visitor Sign in', () => {
    for (const path of PUBLIC_PATHS) {
      const html = renderToString(<PublicHeader path={path} />);
      expect(html, path).toContain('Sign in');
      expect(html, path).toContain('/login');
      expect(html, path).not.toContain('Open your account');
    }
  });

  it('says neither while the session check has not answered', () => {
    state.restoring = true;
    const html = renderToString(<PublicHeader path="/help" />);
    expect(html).not.toContain('Sign in');
    expect(html).not.toContain('Open your account');
  });

  it('points to the account, where Retry lives, when the session check could not reach the service', () => {
    state.restoreFailed = true;
    const html = renderToString(<PublicHeader path="/help" />);
    expect(html).toContain('href="/home"');
    expect(html).toContain('Open your account');
    expect(html).not.toContain('Sign in');
  });

  it('keeps Create account on the sign-in page for a signed-out visitor', () => {
    const html = renderToString(<PublicHeader path="/login" />);
    expect(html).toContain('Create account');
    expect(html).toContain('/register');
  });

  it('keeps the public navigation', () => {
    const html = renderToString(<PublicHeader path="/help" />);
    expect(html).toContain('href="/help"');
    expect(html).toContain('href="/about-us"');
  });
});

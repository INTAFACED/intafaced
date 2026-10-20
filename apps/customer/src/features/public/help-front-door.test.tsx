// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const ID = '11111111-1111-4111-8111-111111111111';
const world = vi.hoisted(() => ({
  signedIn: false,
  awaiting: { ok: true, data: { count: 0, longestWaiting: null } } as unknown,
  query: undefined as unknown as (module: string, procedure: string) => Promise<unknown>,
}));

vi.mock('../session/session', () => {
  const api = { query: (module: string, procedure: string) => world.query(module, procedure), mutate: async () => ({ ok: false }) };
  return {
    useApi: () => api,
    useSession: () => ({
      api,
      userId: world.signedIn ? 'user-1' : null,
      session: world.signedIn ? { accessToken: 'token' } : null,
    }),
  };
});
vi.mock('../more/support-contact', () => ({
  useSupportContact: () => ({ status: 'ready', email: null, phone: null, chatHours: null }),
}));

import { PublicHelp } from './PublicHelp';

let host: HTMLDivElement, root: Root;
async function mount() {
  await act(async () => {
    root.render(<PublicHelp />);
  });
  await act(async () => undefined);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  history.replaceState(null, '', '/help');
  world.signedIn = false;
  world.awaiting = { ok: true, data: { count: 0, longestWaiting: null } };
  world.query = async (_module, procedure) => (procedure === 'awaitingMine' ? world.awaiting : { ok: true, data: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the help centre front door', () => {
  it('a signed-out visitor who presses the request button sees the sign-in prompt, and the search text is kept', async () => {
    await mount();
    const search = host.querySelector<HTMLInputElement>('input[name="help-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'withdrawal limit');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="request-sign-in"]')).toBeNull();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send a request')!;
    await act(async () => button.click());
    const prompt = host.querySelector('[data-testid="request-sign-in"]')!;
    expect(prompt.textContent).toContain('Sign in to send a request');
    expect(prompt.querySelector('a')!.getAttribute('href')).toBe('/login?redirect=%2Fsupport');
    expect(host.querySelector<HTMLInputElement>('input[name="help-search"]')!.value).toBe('withdrawal limit');
    expect(host.querySelector('[data-testid="action-required"]')).toBeNull();
    expect(host.innerHTML).not.toContain('mailto:');
  });

  it('a signed-in visitor with a request waiting sees the banner linking to that request', async () => {
    world.signedIn = true;
    world.awaiting = { ok: true, data: { count: 1, longestWaiting: { ticketId: ID, since: '2026-10-20T01:00:00.000Z' } } };
    await mount();
    const banner = host.querySelector('[data-testid="action-required"]')!;
    expect(banner.textContent).toContain('Action required');
    expect(banner.querySelector('a')!.getAttribute('href')).toBe(`/support?request=${ID}`);
    expect(host.textContent).toContain('Open your support requests');
    expect(host.querySelector('[data-testid="request-sign-in"]')).toBeNull();
  });

  it('says how many wait when more than one does', async () => {
    world.signedIn = true;
    world.awaiting = { ok: true, data: { count: 3, longestWaiting: { ticketId: ID, since: '2026-10-20T01:00:00.000Z' } } };
    await mount();
    expect(host.querySelector('[data-testid="action-required"]')!.textContent).toContain('3 support requests are waiting');
  });

  it('draws no banner when nothing waits', async () => {
    world.signedIn = true;
    await mount();
    expect(host.querySelector('[data-testid="action-required"]')).toBeNull();
    expect(host.querySelector('[data-testid="action-required-unread"]')).toBeNull();
  });

  it('a failed read says it could not check, never "nothing waiting"', async () => {
    world.signedIn = true;
    world.awaiting = { ok: false, reason: 'error', message: { key: 'loadFailed' } };
    await mount();
    expect(host.querySelector('[data-testid="action-required"]')).toBeNull();
    expect(host.querySelector('[data-testid="action-required-unread"]')!.textContent).toContain('could not check');
  });

  it('a signed-out visitor never asks for the waiting count', async () => {
    const asked: string[] = [];
    world.query = async (_m, procedure) => {
      asked.push(procedure);
      return { ok: true, data: [] };
    };
    await mount();
    expect(asked).not.toContain('awaitingMine');
  });
});

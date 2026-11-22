// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('./NotificationTargets', () => ({ NotificationTargets: () => null }));
const net = vi.hoisted(() => ({ setMute: [] as unknown[], muteAnswer: undefined as unknown }));
vi.mock('../session', async (original) => {
  const real = await original<typeof import('../session')>();
  const { createApiClient } = await import('../../shared/api');
  const api = createApiClient({
    token: () => 'tok',
    fetch: async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname.split('/').pop()!;
      const data =
        path === 'notify.mutePrefs'
          ? [
              { channel: 'email', muted: false },
              { channel: 'push', muted: false },
              { channel: 'sms', muted: false },
            ]
          : path === 'notify.setMute'
            ? (net.setMute.push(path), net.muteAnswer)
            : undefined;
      if (data === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ result: { data } }), { status: 200 });
    },
  });
  return { ...real, useSession: () => ({ api, mode: 'Personal', userId: 'u1' }) };
});

import { Notifications } from './Notifications';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  net.setMute = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  });
async function muteEmail() {
  await act(async () => root.render(<Notifications />));
  await settle();
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Mute Email');
  if (!button) throw new Error(`no mute button in: ${host.textContent}`);
  await act(async () => button.click());
  await settle();
  await settle();
}

describe('muting a channel', () => {
  it('says the service confirmed it when the answer shows the channel muted', async () => {
    net.muteAnswer = [
      { channel: 'email', muted: true },
      { channel: 'push', muted: false },
      { channel: 'sms', muted: false },
    ];
    await muteEmail();
    expect(net.setMute).toHaveLength(1);
    expect(host.textContent).toContain('The service confirmed that Email is muted.');
  });

  it('does not say so when the answer shows the channel still unmuted', async () => {
    net.muteAnswer = [
      { channel: 'email', muted: false },
      { channel: 'push', muted: false },
      { channel: 'sms', muted: false },
    ];
    await muteEmail();
    expect(net.setMute).toHaveLength(1);
    expect(host.textContent).not.toContain('The service confirmed that Email is muted.');
    expect(host.textContent).toContain('Email preference not confirmed');
  });
});

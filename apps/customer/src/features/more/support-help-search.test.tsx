// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const asked = vi.hoisted(() => [] as unknown[]);
vi.mock('../session/session', () => {
  const api = {
    query: async (_module: string, _procedure: string, input?: unknown) => {
      asked.push(input);
      return { ok: true, data: [] };
    },
    mutate: async () => ({ ok: false }),
  };
  return { useApi: () => api, useSession: () => ({ api, userId: 'user-1', session: { accessToken: 'token' } }) };
});

import { SupportHelpArticles } from './SupportHelpArticles';
import type { useAction } from './common';

const action = {} as ReturnType<typeof useAction>;
let host: HTMLDivElement, root: Root;
async function mount() {
  root = createRoot(host);
  await act(async () => root.render(<SupportHelpArticles action={action} onStartRequest={() => undefined} />));
  await act(async () => undefined);
}
const field = () => host.querySelector<HTMLInputElement>('input')!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  asked.length = 0;
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('words carried to the support desk (J-support-public-01 #4)', () => {
  it('runs the carried words, takes them off the address, and keeps them when the desk mounts again', async () => {
    history.replaceState(null, '', '/support?q=passkey');
    await mount();
    expect(field().value).toBe('passkey');
    expect(asked).toContainEqual({ q: 'passkey', limit: 50 });
    expect(location.pathname + location.search).toBe('/support');
    act(() => root.unmount());
    await mount();
    expect(field().value).toBe('passkey');
  });

  it("keeps the person's own later search, not the carried words", async () => {
    history.replaceState(null, '', '/support?q=passkey');
    await mount();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), 'withdraw');
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLFormElement>('form')!.requestSubmit());
    act(() => root.unmount());
    await mount();
    expect(field().value).toBe('withdraw');
  });

  it('starts empty on a fresh visit', async () => {
    history.replaceState(null, '', '/support');
    await mount();
    expect(field().value).toBe('');
    expect(asked).toContainEqual({ q: '', limit: 50 });
  });
});

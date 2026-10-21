// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only. The account side holds one `ui.view` record and one `account.display` record; each test chooses who is signed in.
const USER = '12345678-1234-4234-8234-123456789abc';
const world = vi.hoisted(() => ({
  userId: '' as string | null,
  records: {} as Record<string, { version: number; value: unknown }>,
  sent: [] as Array<{ namespace: string; value: unknown }>,
  down: false,
}));
vi.mock('../session/session', () => {
  const api = {
    async query(_module: string, _procedure: string, input: { namespace: string }) {
      if (world.down) return { ok: false, reason: 'unreachable', message: 'offline' };
      const record = world.records[input.namespace] ?? { version: 0, value: null };
      return { ok: true, data: { namespace: input.namespace, ...record } };
    },
    async mutate(_module: string, _procedure: string, input: { namespace: string; value: unknown; ifVersion: number }) {
      if (world.down) return { ok: false, reason: 'unreachable', message: 'offline' };
      world.sent.push({ namespace: input.namespace, value: input.value });
      const next = { version: input.ifVersion + 1, value: input.value };
      world.records[input.namespace] = next;
      return { ok: true, data: { namespace: input.namespace, ...next, outcome: 'stored' } };
    },
  };
  return { useSession: () => ({ api, userId: world.userId }) };
});

import { AccountViewSync, useAccountViewStatus } from './ViewSync';
import { ApplyView } from './View';
import { currentPreferences, savePreferences } from '../../shared/preferences';
import { defineCopy } from '../../shared/i18n';

// TEST data: Arabic has written copy here, as a shipped language would, so the page is drawn right-to-left.
defineCopy('test.account.language', { one: 'One' }, { ar: { one: 'واحد' } });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

function Status() {
  return <span data-testid="status">{useAccountViewStatus()}</span>;
}
async function mount() {
  await act(async () =>
    root.render(
      <>
        <AccountViewSync />
        <ApplyView />
        <Status />
      </>,
    ),
  );
  await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
}
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(700)));
const status = () => host.querySelector('[data-testid="status"]')!.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  world.userId = USER;
  world.records = {};
  world.sent = [];
  world.down = false;
  savePreferences({ language: 'en' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('interface language on the account (RC-home-ia-05)', () => {
  it('shows a language chosen on another device, right-to-left when it has written copy, after sign-in', async () => {
    world.records['account.display'] = { version: 2, value: { locale: 'ar', displayCurrency: null } };
    await mount();
    expect(currentPreferences().language).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(world.sent).toEqual([]);
    expect(status()).toBe('synced');
  });

  it('writes a language chosen here to the account once, and leaves the display currency it holds as it was', async () => {
    world.records['account.display'] = { version: 1, value: { locale: null, displayCurrency: 'BTC' } };
    await mount();
    await act(async () => void savePreferences({ language: 'fr' }));
    await settle();
    expect(world.sent).toEqual([{ namespace: 'account.display', value: { locale: 'fr', displayCurrency: 'BTC' } }]);
    await settle();
    expect(world.sent).toHaveLength(1);
    expect(status()).toBe('synced');
  });

  it('signed out, a language change stays in the browser and nothing is read or written', async () => {
    world.userId = null;
    await mount();
    await act(async () => void savePreferences({ language: 'es' }));
    await settle();
    expect(world.sent).toEqual([]);
    expect(currentPreferences().language).toBe('es');
    expect(status()).toBe('idle');
  });

  it('says not-saved when the account cannot be written, and keeps the language on this device', async () => {
    await mount();
    world.down = true;
    await act(async () => void savePreferences({ language: 'es' }));
    await settle();
    expect(status()).toBe('not-saved');
    expect(currentPreferences().language).toBe('es');
  });
});

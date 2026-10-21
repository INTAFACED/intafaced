// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const reads = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('./use-alerts', () => ({
  useAlerts: () => ({
    state: { status: 'ready', items: reads.items, evaluation: { markSource: 'live', canFire: true, code: null } },
    reload: () => undefined,
  }),
  useAlertMarkets: () => ({ status: 'ready', markets: [{ id: 'm1', label: 'BTC/USDT', quote: 'USDT' }] }),
}));
vi.mock('./use-triggers', () => ({
  useTriggers: () => ({
    state: {
      status: 'ready',
      page: {
        retentionDays: 7,
        items: [
          {
            alertId: '11111111-1111-4111-8111-111111111111',
            seq: 1,
            marketId: 'm1',
            condition: 'crossing',
            targetPrice: '100',
            markPrice: '101',
            firedAt: '2026-10-20T10:00:00.000Z',
            notificationId: null,
          },
          {
            alertId: '11111111-1111-4111-8111-111111111111',
            seq: 2,
            marketId: 'm1',
            condition: 'crossing',
            targetPrice: '100',
            markPrice: '99',
            firedAt: '2026-10-20T11:00:00.000Z',
            notificationId: null,
          },
        ],
      },
    },
    reload: () => undefined,
  }),
}));
vi.mock('./use-quota', () => ({
  useAlertQuota: () => ({ state: { status: 'ready', quota: { kind: 'price', used: 0, max: 10 } }, reload: () => undefined }),
}));
vi.mock('../../features/session/session', async (original) => {
  const real = await original<typeof import('../../features/session/session')>();
  return { ...real, useSession: () => ({ ...real.useSession(), mode: 'Personal', userId: 'u1' }) };
});

import { SessionProvider } from '../../features/session/session';
import AlertsPage from './AlertsPage';

let host: HTMLDivElement, root: Root;
const row = (patch: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  marketId: 'm1',
  kind: 'price',
  direction: 'above',
  condition: 'crossing',
  targetPrice: '100',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  ...patch,
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const mount = () =>
  act(async () =>
    root.render(
      <SessionProvider>
        <AlertsPage />
      </SessionProvider>,
    ),
  );

describe('repeating alerts on the page', () => {
  it('offers repeating only for a crossing condition', async () => {
    reads.items = [];
    await mount();
    const select = Array.from(host.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === 'crossing_up'))!;
    const pick = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    expect(host.querySelector('[data-testid="alerts-repeat"]')).toBeNull();
    await pick('crossing_up');
    expect(host.querySelector('[data-testid="alerts-repeat"]')).not.toBeNull();
    await pick('less_than');
    expect(host.querySelector('[data-testid="alerts-repeat"]')).toBeNull();
  });
  it('says how often a repeating alert has triggered, and a one-shot alert says nothing of it', async () => {
    reads.items = [
      row({ frequency: 'every_crossing', fireCount: 2, lastFiredAt: '2026-10-20T11:00:00.000Z' }),
      row({ id: '22222222-2222-4222-8222-222222222222' }),
    ];
    await mount();
    const repeats = host.querySelectorAll('[data-testid="alert-repeats"]');
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.textContent).toContain('Triggered so far: 2');
  });
  it('lists each trigger of a repeating alert as its own row', async () => {
    reads.items = [row({ frequency: 'every_crossing', fireCount: 2 })];
    await mount();
    expect(host.querySelectorAll('[data-testid="alert-trigger"]')).toHaveLength(2);
  });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const net = vi.hoisted(() => ({
  calls: [] as { path: string; limit?: number }[],
  answer: (() => undefined) as (path: string, limit?: number) => unknown,
}));
vi.mock('../session', async (original) => {
  const real = await original<typeof import('../session')>();
  const { createApiClient: make } = await import('../../shared/api');
  const api = make({
    token: () => 'tok',
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.split('/').pop()!;
      const raw = url.searchParams.get('input');
      const limit = raw ? (JSON.parse(raw) as { limit?: number }).limit : undefined;
      net.calls.push({ path, limit });
      return new Response(JSON.stringify({ result: { data: net.answer(path, limit) } }), { status: 200 });
    },
  });
  return { ...real, useSession: () => ({ api, mode: 'Personal', userId: USER }) };
});

import { PriceAlerts } from './PriceAlerts';

const USER = 'u1';
const ID = '11111111-1111-4111-8111-111111111111';
const live = { markSource: 'live', canFire: true, code: null };
// Every field svc-notify sends on an alert (`priceAlertOutput`); a plain one-shot level alert above 100.
const row = (patch: Record<string, unknown> = {}) => ({
  id: ID,
  userId: USER,
  marketId: 'm1',
  kind: 'price',
  direction: 'above',
  targetPrice: '100',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  condition: 'greater_than',
  name: null,
  message: null,
  expiresAt: null,
  updatedAt: '2026-10-17T08:00:00.000Z',
  extras: [],
  frequency: 'once',
  source: 'mark',
  fireCount: 0,
  stopReason: null,
  lastFiredAt: null,
  channels: null,
  webhookUrl: null,
  ...patch,
});
const market = { id: 'm1', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', paper: false } as never;
const someoneElse = row({ userId: 'someone-else' });

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // One tab holds the lock at once; here the panel always gets it.
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_n: string, _o: unknown, run: (lock: object) => unknown) => run({}) },
  });
  localStorage.clear();
  net.calls = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const text = () => document.body.textContent ?? '';
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const press = async (label: string) => {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`no button "${label}" in: ${text()}`);
  await act(async () => button.click());
  await flush();
  await flush();
};
const open = async () => {
  await act(async () => root.render(<PriceAlerts market={market} />));
  await press('Price alerts');
};
const sent = (path: string) => net.calls.filter((call) => call.path === path).length;

describe('price alerts panel believes only answers about this person and what was asked', () => {
  it('refuses a list that holds another person alert', async () => {
    net.answer = () => ({ items: [someoneElse], evaluation: live });
    await open();
    expect(document.body.querySelector('.price-alerts-row')).toBeNull();
    net.answer = () => ({ items: [row()], evaluation: live });
    await press('Refresh alerts');
    expect(document.body.querySelectorAll('.price-alerts-row')).toHaveLength(1);
  });

  it('sends no create when the fresh read before it holds another person alert', async () => {
    net.answer = (path, limit) => (limit === 100 ? { items: [someoneElse], evaluation: live } : { items: [], evaluation: live });
    await open();
    const price = document.body.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(price, '100');
      price.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Review price alert');
    await press('Save price alert');
    expect(text()).toContain('No request was sent.');
    expect(sent('notify.createAlert')).toBe(0);
  });

  it('does not read a create answer naming another person alert as saved', async () => {
    net.answer = (path) => (path === 'notify.createAlert' ? { alert: someoneElse, evaluation: live } : { items: [], evaluation: live });
    await open();
    const price = document.body.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(price, '100');
      price.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Review price alert');
    await press('Save price alert');
    expect(sent('notify.createAlert')).toBe(1);
    expect(text()).not.toContain('The service saved your one-shot alert.');
    expect(text()).toContain('Original alert action unconfirmed');
  });

  it('does not read a cancel answer naming another person alert as cancelled', async () => {
    net.answer = (path) =>
      path === 'notify.cancelAlert'
        ? { cancelled: true, alert: row({ userId: 'someone-else', status: 'cancelled' }) }
        : { items: [row()], evaluation: live };
    await open();
    await press('Inspect alert');
    await press('Review cancellation');
    await press('Cancel this alert');
    expect(sent('notify.cancelAlert')).toBe(1);
    expect(text()).not.toContain('The service returned this alert as cancelled.');
    expect(text()).toContain('Original alert action unconfirmed');
  });

  it('does not read a check answer naming another person alert as fired', async () => {
    net.answer = (path) =>
      path === 'notify.evaluateAlert'
        ? {
            alert: row({ userId: 'someone-else', status: 'fired', firedAt: '2026-10-17T09:00:00.000Z' }),
            evaluation: live,
            outcome: { kind: 'fire', markPrice: '101' },
          }
        : { items: [row()], evaluation: live };
    await open();
    await press('Inspect alert');
    await press('Review check now');
    await press('Check now');
    expect(sent('notify.evaluateAlert')).toBe(1);
    expect(text()).not.toContain('The service returned this alert as fired.');
    expect(text()).toContain('Original alert action unconfirmed');
  });
});

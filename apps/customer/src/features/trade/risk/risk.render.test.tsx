// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// Each test chooses who is signed in and what the reads and the one write answer.
const world = vi.hoisted(() => ({
  userId: 'u1' as string | null,
  rest: undefined as unknown as (path: string, options: { method?: string; query?: Record<string, unknown> }) => Promise<unknown>,
  positions: { status: 'loading' } as unknown,
  feed: { ok: true } as unknown,
}));
vi.mock('../../session/session', () => ({
  useSession: () => ({
    userId: world.userId,
    api: { rest: (path: string, _schema: unknown, options: never) => world.rest(path, options) },
  }),
}));
vi.mock('../../../data/hooks', () => ({ useDataEnv: () => ({ poller: { recordExternalRequest: () => undefined } }) }));
vi.mock('../../../screens/trade/futures/data', async (original) => {
  const real = await original<typeof import('../../../screens/trade/futures/data')>();
  return { ...real, useOpenPositions: () => world.positions };
});
vi.mock('../../developers/developers-api', async (original) => {
  const real = await original<typeof import('../../developers/developers-api')>();
  return { ...real, readStatusFeed: async () => world.feed };
});

import { RiskControl } from './RiskControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.userId = 'u1';
  world.positions = { status: 'ready', data: [], asOf: Date.now() };
  world.feed = {
    ok: true,
    data: {
      asOf: '2026-10-20T00:00:00Z',
      components: [],
      incidents: [],
      maintenance: [],
      history: { basis: 'incident_notices_only', days: [] },
    },
  };
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});
async function show() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<RiskControl />));
}
const wait = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const button = (text: string) => [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));

// TEST orders in two markets.
const order = (id: string, symbol: string, status = 'open') => ({ id, symbol, status, recoveryRequired: false });
const open = [order('o1', 'TEST-A/USDT'), order('o2', 'TEST-A/USDT'), order('o3', 'TEST-B/USDT')];
const position = (id: string, symbol: string, side: 'long' | 'short', contracts: string) => ({
  id,
  symbol,
  side,
  contracts,
  status: 'open',
  timestamp: 1,
});

describe('risk control room', () => {
  it('sends a signed-out visitor to sign in and reads nothing', async () => {
    world.userId = null;
    const calls: string[] = [];
    world.rest = async (path) => (calls.push(path), { ok: true, data: [] });
    await show();
    expect(host.textContent).toContain('Sign in to see your exposure');
    expect(host.querySelector('a[href^="/login"]')).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it('shows open orders by market and one cancel-all that sends a single DELETE with no market', async () => {
    const calls: Array<{ path: string; method?: string; query?: Record<string, unknown> }> = [];
    world.rest = async (path, options) => {
      calls.push({ path, method: options?.method, query: options?.query });
      return options?.method === 'DELETE'
        ? { ok: true, data: open.map((entry) => ({ ...entry, status: 'canceled' })) }
        : { ok: true, data: open };
    };
    await show();
    await wait();
    expect(host.textContent).toContain('3 open orders');
    expect(host.textContent).toContain('TEST-A/USDT: 2');
    expect(host.textContent).toContain('TEST-B/USDT: 1');
    await act(async () => button('Cancel all orders')!.click());
    expect(document.body.textContent).toContain('This cancels 3 open orders across all markets');
    await act(async () => button('Cancel all orders')!.click());
    // The dialog has its own confirm button with the same words.
    const confirm = [...document.body.querySelectorAll('button')]
      .filter((candidate) => candidate.textContent === 'Cancel all orders')
      .at(-1)!;
    await act(async () => confirm.click());
    await wait();
    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ path: '/orders' });
    expect(deletes[0]!.query).toBeUndefined();
    expect(document.body.textContent).toContain('3 orders cancelled.');
  });

  it('never sends a second cancel when the answer is lost, and says the result is unknown', async () => {
    const calls: string[] = [];
    world.rest = async (path, options) => {
      calls.push(`${options?.method ?? 'GET'} ${path}`);
      return options?.method === 'DELETE' ? { ok: false, reason: 'uncertain', message: 'lost' } : { ok: true, data: open };
    };
    await show();
    await wait();
    await act(async () => button('Cancel all orders')!.click());
    const confirm = [...document.body.querySelectorAll('button')]
      .filter((candidate) => candidate.textContent === 'Cancel all orders')
      .at(-1)!;
    await act(async () => confirm.click());
    await wait();
    expect(calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
    expect(document.body.textContent).toContain('We could not confirm the result. Nothing was sent again.');
    // The open orders were read again afterwards: the list is the record.
    expect(calls.filter((call) => call.startsWith('GET')).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps cancel-all off with no open orders and says there are none', async () => {
    world.rest = async () => ({ ok: true, data: [] });
    await show();
    await wait();
    expect(host.textContent).toContain('You have no open orders.');
    expect((button('Cancel all orders') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists live positions to select and opens the reduce-only close for the chosen ones only', async () => {
    world.rest = async () => ({ ok: true, data: [] });
    world.positions = {
      status: 'ready',
      asOf: Date.now(),
      data: [position('p1', 'TEST-PERP-A', 'long', '2'), position('p2', 'TEST-PERP-B', 'short', '5')],
    };
    await show();
    await wait();
    expect(host.textContent).toContain('2 open positions');
    expect(host.textContent).toContain('TEST-PERP-A · long · 2');
    expect(host.textContent).toContain('Select at least one position to close.');
    expect((button('Close selected positions') as HTMLButtonElement).disabled).toBe(true);
    const [first] = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => first!.click());
    expect(host.textContent).toContain('1 selected');
    await act(async () => button('Close selected positions')!.click());
    // Only the chosen position is in the close: one position, one close button.
    expect(document.body.textContent).toContain('1 position will be closed');
    expect(document.body.textContent).toContain('TEST-PERP-A Long');
    expect(button('Close 1 position')).toBeDefined();
  });

  it('says futures are off rather than showing zero positions', async () => {
    world.rest = async () => ({ ok: true, data: [] });
    world.positions = { status: 'refused', code: 'trade.futures_disabled' };
    await show();
    await wait();
    expect(host.textContent).toContain('Futures are switched off');
    expect(host.textContent).not.toContain('You have no open positions.');
  });

  it('names the approvals blocker with its code and keeps the button visible but off', async () => {
    world.rest = async () => ({ ok: true, data: [] });
    await show();
    await wait();
    expect(host.textContent).toContain('risk.approvals_source_unset');
    expect((button('Open approvals') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an unreadable status feed as unknown with its code, never as all clear', async () => {
    world.rest = async () => ({ ok: true, data: [] });
    world.feed = { ok: false, reason: 'unreachable', message: 'offline' };
    await show();
    await wait();
    expect(host.textContent).toContain('This is not an all-clear.');
    expect(host.textContent).toContain('risk.incident_feed_unset');
    expect(host.textContent).not.toContain('The status feed lists no open incident.');
  });
});

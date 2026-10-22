// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../data/types';
import type { SocketLike } from './live-candles';

// TEST markets and candles, not published figures.
const world = vi.hoisted(() => ({
  markets: { status: 'loading' } as unknown,
  candles: { status: 'ready', data: [], asOf: 0 } as unknown,
  asked: [] as string[],
}));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../features/session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
vi.mock('../trade/desk/data', () => ({ useDeskMarkets: () => world.markets }));
vi.mock('../trade/chart/candles', async (original) => ({
  ...(await original<typeof import('../trade/chart/candles')>()),
  useChartCandles: (symbol: string, interval: string) => {
    world.asked.push(`${symbol}:${interval}`);
    return world.candles;
  },
}));
vi.mock('../trade/chart/PriceChart', () => ({
  PriceChart: ({ candles, mode }: { candles: readonly Candle[]; mode: string }) => (
    <div data-testid="price-chart" data-mode={mode} data-last={candles[candles.length - 1]?.c ?? ''} />
  ),
}));
import ChartsScreen from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const market = (symbol: string) => ({
  symbol,
  base: symbol.split('/')[0]!,
  quote: symbol.split('/')[1]!,
  tickSize: '0.01',
  lotSize: '0.001',
  minAmount: '0.001',
  minCost: '5',
  open: true,
});
const bar = (t: number, c: string): Candle => ({ t, o: '1', h: '3', l: '1', c, v: '5', filled: false });
const ready = (data: Candle[]) => ({ status: 'ready', data, asOf: Date.now() });

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  onclose: SocketLike['onclose'] = null;
  send() {}
  close() {}
}

async function open(pathname = '/charts/BTC-USDT', search = '', socket?: () => SocketLike) {
  history.replaceState(null, '', pathname + search);
  root = createRoot(host);
  const mounted = root;
  const params = { symbol: decodeURIComponent(pathname.split('/')[2] ?? '') };
  await act(async () => mounted.render(<ChartsScreen path={pathname} search={search} params={params} openSocket={socket} />));
}
const pressed = (scope: ParentNode = host) =>
  [...scope.querySelectorAll('[aria-label="Chart intervals"] button[aria-pressed="true"]')].map((node) => node.textContent);
const click = (node: Element | null | undefined) => act(async () => node?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  localStorage.clear();
  world.markets = { status: 'ready', data: [market('BTC/USDT'), market('ETH/USDT')] };
  world.candles = ready([bar(0, '1'), bar(60_000, '2')]);
  world.asked = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('chart workbench', () => {
  it('draws the market in the address at the default 15m and names it', async () => {
    await open();
    expect(host.querySelector('.cw-page')?.getAttribute('data-market')).toBe('BTC/USDT');
    expect(host.querySelector('[data-testid="price-chart"]')).not.toBeNull();
    expect(pressed()).toEqual(['15m']);
    expect(world.asked).toContain('BTC/USDT:15m');
    expect((host.querySelector('.cw-head select') as HTMLSelectElement).value).toBe('BTC/USDT');
    expect(host.querySelector('a.cw-link')?.getAttribute('href')).toBe('/trade/spot/BTC-USDT');
  });

  it('opens at the interval in the address and keeps the person’s later choice', async () => {
    await open('/charts/BTC-USDT', '?interval=1h');
    expect(pressed()).toEqual(['1h']);
    await click(button('5m'));
    expect(pressed()).toEqual(['5m']);
    expect(JSON.parse(localStorage.getItem('charts-workbench:u1:main')!)).toEqual({ interval: '5m', mode: 'candles' });
  });

  it('falls back to 15m with no error when the stored interval is not offered', async () => {
    localStorage.setItem('charts-workbench:u1:main', JSON.stringify({ interval: '7m', mode: 'line' }));
    await open();
    expect(pressed()).toEqual(['15m']);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('shares the interval and style with a second chart that follows the first', async () => {
    await open();
    await click(button('Add a second chart'));
    const charts = host.querySelectorAll('section.cw');
    expect(charts).toHaveLength(2);
    await click(charts[0]!.querySelector('[aria-label="Chart intervals"] button:nth-child(5)'));
    expect(pressed(charts[0]!)).toEqual(['4h']);
    expect(pressed(host.querySelectorAll('section.cw')[1]!)).toEqual(['4h']);
    await click([...charts[1]!.querySelectorAll('button')].find((node) => node.textContent === 'Line'));
    expect([...host.querySelectorAll('[data-testid="price-chart"]')].map((node) => node.getAttribute('data-mode'))).toEqual([
      'line',
      'line',
    ]);
  });

  it('lets the second chart go its own way once it stops following', async () => {
    await open();
    await click(button('Add a second chart'));
    await click(host.querySelector('.cw-check input'));
    const second = () => host.querySelectorAll('section.cw')[1]!;
    await click([...second().querySelectorAll('button')].find((node) => node.textContent === '1m'));
    expect(pressed(second())).toEqual(['1m']);
    expect(pressed(host.querySelectorAll('section.cw')[0]!)).toEqual(['15m']);
  });

  it('says which way the chart is fed: read every 10 seconds, then live once a frame arrives', async () => {
    const socket = new FakeSocket();
    await open('/charts/BTC-USDT', '', () => socket);
    expect(host.querySelector('[data-testid="chart-feed"]')?.textContent).toContain('every 10 seconds');
    await act(async () =>
      socket.onmessage?.({ data: JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: true, market: 'm1' }] }) }),
    );
    await act(async () =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'candle',
          marketId: 'm1',
          interval: '15m',
          t: 60_000,
          o: '1',
          h: '9',
          l: '1',
          c: '9',
          v: '5',
          closed: false,
        }),
      }),
    );
    expect(host.querySelector('[data-testid="chart-feed"]')?.textContent).toContain('Live');
    expect(host.querySelector('[data-testid="price-chart"]')?.getAttribute('data-last')).toBe('9');
    expect(host.querySelector('section.cw')?.getAttribute('data-feed')).toBe('stream');
  });

  it('says so for an interval the stream does not serve', async () => {
    await open('/charts/BTC-USDT', '?interval=3m', () => new FakeSocket());
    expect(host.querySelector('[data-testid="chart-feed"]')?.textContent).toContain('This interval is read from the service');
  });

  it('shows the empty, error and refused states from the candle read', async () => {
    world.candles = { status: 'empty' };
    await open();
    expect(host.textContent).toContain('No trades in this period');
    act(() => root?.unmount());
    world.candles = { status: 'error', retry: () => undefined };
    root = null;
    await open();
    expect(host.textContent).toContain('Couldn’t load the chart');
  });

  it('names a market that is not listed instead of drawing a chart', async () => {
    await open('/charts/DOGE-USDT');
    expect(host.querySelector('[data-testid="price-chart"]')).toBeNull();
    expect(host.textContent).toContain('We couldn’t find that market');
    expect(host.querySelector('a[href="/trade"]')).not.toBeNull();
  });

  it('shows a skeleton while the market list loads', async () => {
    world.markets = { status: 'loading' };
    await open();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});

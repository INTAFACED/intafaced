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
  history: { status: 'idle' } as unknown,
  owner: {} as Record<string, unknown>,
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
vi.mock('./WorkbenchChart', () => ({
  WorkbenchChart: ({ candles, style, scheme }: { candles: readonly Candle[]; style: string; scheme: string }) => (
    <div data-testid="price-chart" data-mode={style} data-scheme={scheme} data-last={candles[candles.length - 1]?.c ?? ''} />
  ),
}));
vi.mock('./history', async (original) => ({
  ...(await original<typeof import('./history')>()),
  useChartHistory: () => ({ state: world.history, load: async () => world.history, oldestReachable: 0 }),
}));
vi.mock('./owner-values', async (original) => ({
  ...(await original<typeof import('./owner-values')>()),
  useChartOwnerValues: () => ({ status: 'ready', data: world.owner, asOf: 0 }),
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
const choose = (label: string, value: string) =>
  act(async () => {
    const select = [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))!.querySelector('select')!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  localStorage.clear();
  world.markets = { status: 'ready', data: [market('BTC/USDT'), market('ETH/USDT')] };
  world.candles = ready([bar(0, '1'), bar(60_000, '2')]);
  world.asked = [];
  world.history = { status: 'idle' };
  // TEST owner values, not published ones.
  world.owner = {
    compareCap: 3,
    chartCountLimit: 4,
    drawingCap: 50,
    brushPointCap: 2000,
    delayedBoundarySeconds: 30,
    dataClass: 'real_time',
  };
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
    expect(JSON.parse(localStorage.getItem('charts-workbench:u1:main')!)).toEqual({ interval: '5m', mode: 'candles', scheme: 'standard' });
  });

  it('falls back to 15m with no error when the stored interval is not offered', async () => {
    localStorage.setItem('charts-workbench:u1:main', JSON.stringify({ interval: '7m', mode: 'line' }));
    await open();
    expect(pressed()).toEqual(['15m']);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('refuses a layout of more than one chart while the owner limit is not set', async () => {
    world.owner = { ...world.owner, chartCountLimit: null };
    await open();
    await choose('Layout', 'grid');
    expect(host.querySelectorAll('section.cw')).toHaveLength(1);
    expect(host.querySelector('[data-code="trade.chart.owner_value_unset"]')?.textContent).toContain('isn’t set yet');
  });

  it('opens four charts that follow the first one’s market and interval in their group', async () => {
    await open();
    await choose('Layout', 'grid');
    const charts = () => host.querySelectorAll('section.cw');
    expect(charts()).toHaveLength(4);
    // The fourth leaves the group, so it no longer follows.
    await act(async () => {
      const group = host.querySelectorAll<HTMLSelectElement>('[data-cell="3"] .cg-cell-bar select')[0]!;
      group.value = 'none';
      group.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(charts()[0]!.querySelector('[aria-label="Chart intervals"] button:nth-child(5)'));
    expect([0, 1, 2].map((i) => pressed(charts()[i]!))).toEqual([['4h'], ['4h'], ['4h']]);
    expect(pressed(charts()[3]!)).toEqual(['15m']);
    await click([...charts()[1]!.querySelectorAll('button')].find((node) => node.textContent === 'Line'));
    expect([...host.querySelectorAll('[data-testid="price-chart"]')].map((node) => node.getAttribute('data-mode'))).toEqual([
      'candles',
      'line',
      'candles',
      'candles',
    ]);
  });

  it('refuses a layout past the owner limit and names both numbers', async () => {
    world.owner = { ...world.owner, chartCountLimit: 2 };
    await open();
    await choose('Layout', 'grid');
    expect(host.querySelector('[data-code="trade.chart.owner_value_unset"]')?.textContent).toContain('4 charts; the limit is 2');
    await choose('Layout', 'two-across');
    expect(host.querySelectorAll('section.cw')).toHaveLength(2);
  });

  it('maximises the chart in focus on Alt+Enter and brings the others back on the same key', async () => {
    await open();
    await choose('Layout', 'two-across');
    const cell = host.querySelector<HTMLElement>('[data-cell="1"]')!;
    const key = (init: KeyboardEventInit) =>
      act(async () => cell.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })));
    await key({ key: 'Enter', altKey: true });
    expect(host.querySelector('.cg-area')?.getAttribute('data-maximised')).toBe('1');
    expect(host.querySelector<HTMLElement>('[data-cell="0"]')!.style.display).toBe('none');
    await key({ key: 'Enter', altKey: true });
    expect(host.querySelector('.cg-area')?.getAttribute('data-maximised')).toBe('');
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
          ch: 'candles',
          market: 'm1',
          interval: '15m',
          data: { type: 'candle', marketId: 'm1', interval: '15m', t: 60_000, o: '1', h: '9', l: '1', c: '9', v: '5', closed: false },
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

  it('names the symbol and interval and offers every chart style, kept for this device', async () => {
    await open();
    expect(host.querySelector('[data-testid="chart-title"]')?.textContent).toBe('BTC/USDT · 15m');
    const styles = [...host.querySelectorAll('[aria-label="Chart style"] button')].map((node) => node.textContent);
    expect(styles).toEqual(['Candles', 'Bars', 'Line', 'Area', 'Columns', 'Heikin Ashi']);
    await click(button('Heikin Ashi'));
    expect(host.querySelector('[data-testid="price-chart"]')?.getAttribute('data-mode')).toBe('heikin-ashi');
    expect(JSON.parse(localStorage.getItem('charts-workbench:u1:main')!).mode).toBe('heikin-ashi');
  });

  it('changes the colour scheme and refuses a price source the service does not publish', async () => {
    await open();
    const select = (label: string) =>
      [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))!.querySelector('select')!;
    await act(async () => {
      select('Colours').value = 'inverted';
      select('Colours').dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="price-chart"]')?.getAttribute('data-scheme')).toBe('inverted');
    await act(async () => {
      select('Price source').value = 'bid';
      select('Price source').dispatchEvent(new Event('change', { bubbles: true }));
    });
    const note = host.querySelector('[data-code="trade.chart.basis_unpublished"]');
    expect(note?.textContent).toContain('can’t draw Best bid');
    expect(select('Price source').value).toBe('last');
  });

  it('names an interval in the address that the chart does not offer and stays on the current one', async () => {
    await open('/charts/BTC-USDT', '?interval=3d');
    const note = host.querySelector('[data-code="trade.datafeed.interval_unsupported"]');
    expect(note?.textContent).toContain('doesn’t offer the 3d interval');
    expect(pressed()).toEqual(['15m']);
  });

  it('states how deep the loaded history goes', async () => {
    world.history = { status: 'loaded', bars: [bar(-60_000, '1')], earliest: -60_000, since: -120_000 };
    await open();
    expect(host.querySelector('[data-testid="chart-depth"]')?.textContent).toContain('3 bars loaded');
    expect(host.querySelector('[data-testid="chart-depth"]')?.textContent).toContain('keeps the last 720 bars');
  });
});

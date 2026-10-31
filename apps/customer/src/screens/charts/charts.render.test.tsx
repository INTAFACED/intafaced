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
  ownerStatus: 'ready' as 'ready' | 'loading' | 'error',
  lifecycle: { status: 'ready', data: { state: 'OPEN', effectiveAt: 0, evidenceRefs: [] }, asOf: 0 } as unknown,
  bookHalt: {
    status: 'ready',
    data: { halted: false, venueHalted: false, haltedSinceMs: null, venueHaltedSinceMs: null },
    asOf: 0,
  } as unknown,
}));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../features/session/session', () => ({
  useSession: () => ({ userId: 'u1', api: { query: () => new Promise(() => {}), mutate: () => new Promise(() => {}) } }),
}));
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
// The market's state and newest trade: read as open and fresh unless a case says otherwise.
vi.mock('./market-state', async (original) => ({
  ...(await original<typeof import('./market-state')>()),
  // A read is stamped when the chart asks: a read older than the state poll allows is not current.
  useMarketLifecycle: () => {
    const life = world.lifecycle as { status: string };
    return life.status === 'ready' ? { ...life, asOf: Date.now() } : life;
  },
  useBookHalt: () => {
    const book = world.bookHalt as { status: string };
    return book.status === 'ready' ? { ...book, asOf: Date.now() } : book;
  },
  useServerClock: () => ({ status: 'ready', data: 0, asOf: Date.now() }),
  useLastTrade: () => ({ status: 'ready', data: Date.now() - 5_000, asOf: 0 }),
}));
vi.mock('./history', async (original) => ({
  ...(await original<typeof import('./history')>()),
  useChartHistory: () => ({ state: world.history, load: async () => world.history, oldestReachable: 0 }),
}));
vi.mock('./owner-values', async (original) => ({
  ...(await original<typeof import('./owner-values')>()),
  useChartOwnerValues: () =>
    world.ownerStatus === 'ready'
      ? { status: 'ready', data: world.owner, asOf: 0 }
      : world.ownerStatus === 'loading'
        ? { status: 'loading' }
        : { status: 'error', retry: () => undefined },
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
  world.lifecycle = { status: 'ready', data: { state: 'OPEN', effectiveAt: 0, evidenceRefs: [] }, asOf: 0 };
  // TEST owner values, not published ones.
  world.ownerStatus = 'ready';
  world.owner = {
    compareCap: 3,
    chartCountLimit: 4,
    drawingCap: 50,
    brushPointCap: 2000,
    delayedBoundarySeconds: 30,
    renderBudgetMs: 500,
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

  it('a halted market shows the halt as its chip, a banner with the time, and refuses the trade link by name', async () => {
    const since = Date.now() - 60_000;
    world.lifecycle = { status: 'ready', data: { state: 'HALTED', effectiveAt: since, evidenceRefs: [] }, asOf: 0 };
    await open();
    expect(host.querySelector('[data-testid="chart-status"]')?.getAttribute('data-status')).toBe('halted');
    expect(host.querySelector('[data-testid="chart-banner"]')?.getAttribute('data-kind')).toBe('halted');
    expect(host.querySelector('[data-testid="chart-banner"]')?.textContent).toContain('Halted as of');
    const trade = host.querySelector('button.cw-link') as HTMLButtonElement;
    expect(trade.disabled).toBe(true);
    expect(host.querySelector('a.cw-link')).toBeNull();
    expect(host.querySelector('#cw-trade-refusal')?.textContent).toBe('Order entry is off: this market is halted.');
  });

  it('an unreadable market state refuses the trade link too, and the chip says the state is unavailable', async () => {
    world.lifecycle = { status: 'error', retry: () => undefined };
    await open();
    expect(host.querySelector('[data-testid="chart-status"]')?.getAttribute('data-status')).toBe('lifecycle_unavailable');
    expect((host.querySelector('button.cw-link') as HTMLButtonElement).disabled).toBe(true);
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
    expect(host.querySelector('[data-code="trade.chart.owner_value_unset"]')?.textContent).toContain('which is not set');
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
    expect(host.querySelector('[data-code="trade.chart.layout_over_limit"]')?.textContent).toContain('4 charts; the limit is 2');
    await choose('Layout', 'two-across');
    expect(host.querySelectorAll('section.cw')).toHaveLength(2);
  });

  const storedGrid = (layout: string) =>
    localStorage.setItem(
      'charts-grid:u1:main',
      JSON.stringify({
        layout,
        sync: { symbol: true, interval: true, crosshair: false, range: false },
        cells: [],
        sizes: { cols: [1, 1], rows: [1, 1] },
      }),
    );
  const note = () => host.querySelector('.cg-note');
  const layoutOf = () => host.querySelector('.cg-area')?.getAttribute('data-layout');
  const altG = () =>
    act(async () =>
      host.querySelector('.cg')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true, code: 'KeyG', key: 'g' })),
    );

  it('shows one chart while a stored layout waits for the owner limit, and says it is loading', async () => {
    storedGrid('grid');
    world.ownerStatus = 'loading';
    await open();
    expect(host.querySelectorAll('section.cw')).toHaveLength(1);
    expect(note()?.textContent).toContain('Reading the chart limit');
    expect(note()?.hasAttribute('data-code')).toBe(false);
  });

  it('shows one chart with the over-limit code when a stored layout is past the limit', async () => {
    storedGrid('grid');
    world.owner = { ...world.owner, chartCountLimit: 2 };
    await open();
    expect(host.querySelectorAll('section.cw')).toHaveLength(1);
    expect(note()?.getAttribute('data-code')).toBe('trade.chart.layout_over_limit');
    expect(note()?.textContent).toContain('4 charts; the limit is 2');
  });

  it('shows one chart with the unset code when a stored layout needs a blank limit', async () => {
    storedGrid('two-across');
    world.owner = { ...world.owner, chartCountLimit: null };
    await open();
    expect(host.querySelectorAll('section.cw')).toHaveLength(1);
    expect(note()?.getAttribute('data-code')).toBe('trade.chart.owner_value_unset');
  });

  it('shows one chart with the unavailable code when the limit cannot be read', async () => {
    storedGrid('two-across');
    world.ownerStatus = 'error';
    await open();
    expect(host.querySelectorAll('section.cw')).toHaveLength(1);
    expect(note()?.getAttribute('data-code')).toBe('trade.chart.owner_value_unavailable');
  });

  it('shows a stored layout once the limit allows it, with no note', async () => {
    storedGrid('two-across');
    await open();
    expect(host.querySelectorAll('section.cw')).toHaveLength(2);
    expect(note()).toBeNull();
  });

  it('Alt+G skips a layout the limit refuses, and does nothing while the limit loads', async () => {
    world.owner = { ...world.owner, chartCountLimit: 2 };
    storedGrid('two-down');
    await open();
    expect(layoutOf()).toBe('two-down');
    await altG();
    // The four-chart grid is refused at a limit of two, so the cycle goes on to one chart.
    expect(layoutOf()).toBe('single');
  });

  it('Alt+G does nothing while the limit is loading', async () => {
    storedGrid('two-down');
    world.ownerStatus = 'loading';
    await open();
    await altG();
    expect(layoutOf()).toBe('single');
    expect(JSON.parse(localStorage.getItem('charts-grid:u1:main')!).layout).toBe('two-down');
  });

  it('lists no Tab shortcut, and the keys do nothing while the help list is open', async () => {
    await open();
    await click(button('Keyboard shortcuts'));
    const list = host.ownerDocument.querySelector('[data-testid="shortcut-list"]');
    expect(list?.textContent).not.toContain('next chart');
    expect(list?.textContent).not.toContain('Tab');
    await altG();
    expect(layoutOf()).toBe('single');
  });

  it('keeps the bars of a replay as they were when it started, when the bars change under it', async () => {
    world.candles = ready([bar(0, '1'), bar(60_000, '2'), bar(120_000, '3'), bar(180_000, '4')]);
    await open();
    await click(button('Bar replay'));
    const back = host.querySelector<HTMLInputElement>('input[name="back"]')!;
    back.value = '1';
    await act(async () => back.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const position = () => host.querySelector('[data-testid="replay-position"]')?.textContent;
    expect(position()).toBe('Replay: bar 3 of 4');
    // Older history arrives mid-replay: the cut and the count stay on the bars the replay started with.
    world.candles = ready([bar(-120_000, '0'), bar(-60_000, '0.5'), bar(0, '1'), bar(60_000, '2'), bar(120_000, '3'), bar(180_000, '4')]);
    await click(button('Step'));
    expect(position()).toBe('Replay: bar 4 of 4');
    expect(host.querySelector('[data-testid="price-chart"]')?.getAttribute('data-last')).toBe('4');
  });

  it('says why a replay with one bar cannot start, without a bar count of 0', async () => {
    world.candles = ready([bar(0, '1')]);
    await open();
    await click(button('Bar replay'));
    const back = host.querySelector<HTMLInputElement>('input[name="back"]')!;
    back.value = '1';
    await act(async () => back.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const text = host.querySelector('[data-testid="replay-note"]')?.textContent ?? '';
    expect(text).toContain('no earlier bar to replay from');
    expect(text).not.toContain('at most 0');
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

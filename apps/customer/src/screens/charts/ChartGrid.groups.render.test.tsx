// @vitest-environment happy-dom
// The grid's sync-group studies: a command reaches a chart whose studies bar mounts later, and a chart that joins a group
// after a command was issued does not replay it. The price chart is replaced by a stub that hands the add-ons a host.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../data/types';

// TEST markets and candles, not published figures.
const world = vi.hoisted(() => ({
  markets: { status: 'loading' } as unknown,
  candles: { status: 'ready', data: [], asOf: 0 } as unknown,
  owner: {} as Record<string, unknown>,
  /** Symbols whose price chart is not loaded: their add-ons do not mount. */
  unloaded: [] as string[],
}));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// The workbench reads the account's records (watchlists, layouts, templates) on mount. This stub answers none of them: every read
// stays loading, so no record is ever written over.
vi.mock('../../features/session/session', () => ({
  useSession: () => ({ userId: 'u1', api: { query: () => new Promise(() => undefined), mutate: () => new Promise(() => undefined) } }),
}));
vi.mock('../trade/desk/data', () => ({ useDeskMarkets: () => world.markets }));
vi.mock('../trade/chart/candles', async (original) => ({
  ...(await original<typeof import('../trade/chart/candles')>()),
  useChartCandles: () => world.candles,
}));
vi.mock('./WorkbenchChart', async () => {
  const React = await import('react');
  return {
    WorkbenchChart: ({
      symbol,
      candles,
      children,
    }: {
      symbol: string;
      candles: readonly Candle[];
      children?: (host: unknown, bars: readonly Candle[]) => React.ReactNode;
    }) => {
      const host = React.useMemo(() => stubHost(), []);
      if (world.unloaded.includes(symbol)) return <div data-testid="price-chart" data-symbol={symbol} />;
      return (
        <div data-testid="price-chart" data-symbol={symbol}>
          {children?.(host, candles)}
        </div>
      );
    },
  };
});
// The drawings layer is not under test here: the first chart's add-on draws nothing.
vi.mock('./drawings/DrawingsLayer', () => ({ DrawingsLayer: () => null }));
vi.mock('./owner-values', async (original) => ({
  ...(await original<typeof import('./owner-values')>()),
  useChartOwnerValues: () => ({ status: 'ready', data: world.owner, asOf: 0 }),
}));
vi.mock('./history', async (original) => ({
  ...(await original<typeof import('./history')>()),
  useChartHistory: () => ({ state: { status: 'idle' }, load: async () => ({ status: 'idle' }), oldestReachable: 0 }),
}));
import ChartsScreen from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A host with what the studies draw with: series that take data, and panes. */
function stubHost() {
  const chart = {
    addSeries: () => ({ setData() {} }),
    removeSeries() {},
    panes: () => [],
    removePane() {},
    subscribeCrosshairMove() {},
    unsubscribeCrosshairMove() {},
  };
  return {
    lib: { LineSeries: 'LineSeries', HistogramSeries: 'HistogramSeries' },
    chart,
    main: {},
    element: document.createElement('div'),
    tickSize: '0.01',
    symbol: 'BTC/USDT',
  };
}

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
const EMPTY = JSON.stringify({ studies: [], remembered: {}, legendAlways: false });

let host: HTMLDivElement;
let root: Root | null = null;

async function open() {
  history.replaceState(null, '', '/charts/BTC-USDT');
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<ChartsScreen path="/charts/BTC-USDT" search="" params={{ symbol: 'BTC-USDT' }} />));
}
const q = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = host) => scope.querySelector<T>(selector);
const slot = (i: number) => q(`[data-cell="${i}"]`)!;
const chipsOf = (i: number) => [...slot(i).querySelectorAll('.st-chip')].map((node) => node.textContent);
const labelled = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll('label')].find((node) => node.querySelector('span')?.textContent === text)?.querySelector('select') ?? null;
const choose = (select: HTMLSelectElement | null, value: string) =>
  act(async () => {
    select!.value = value;
    select!.dispatchEvent(new Event('change', { bubbles: true }));
  });
const setGroup = (i: number, group: string) => choose(labelled(slot(i), 'Group'), group);
const setMarket = (i: number, symbol: string) => choose(labelled(slot(i), 'Market'), symbol);
const chooseLayout = (value: string) => choose(labelled(host, 'Layout'), value);
/** A change in the grid that re-renders every chart: the first sync box toggled. */
const rerender = () => act(async () => q<HTMLInputElement>('.cg-sync input')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

/** Adds a study from chart `i`'s Indicators dialog, to every chart of its group when `toGroup` is set. */
async function addFrom(i: number, search: string, name: string, toGroup: boolean) {
  await act(async () =>
    [...slot(i).querySelectorAll('button')]
      .find((node) => node.textContent === 'Indicators')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await act(async () => {
    const input = document.querySelector('input[type="search"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, search);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (toGroup) {
    const box = [...document.querySelectorAll('label.st-check')].find((node) => node.textContent?.includes('sync group'))!;
    await act(async () => box.querySelector('input')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === `Add ${name}`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  localStorage.clear();
  for (const key of ['main', 'main:1', 'main:2', 'main:3']) localStorage.setItem(`charts-studies:u1:${key}`, EMPTY);
  // The desk opens in Classic, which leaves the studies bar out. These tests add studies, so they open on Advanced.
  localStorage.setItem('charts-desk:u1:main', JSON.stringify({ preset: 'advanced', side: 'right', studies: true, drawings: true }));
  world.markets = { status: 'ready', data: [market('BTC/USDT'), market('ETH/USDT')] };
  world.candles = { status: 'ready', data: [bar(0, '1'), bar(60_000, '2')], asOf: Date.now() };
  world.unloaded = [];
  // TEST owner values, not published ones.
  world.owner = {
    chartCountLimit: 4,
    compareCap: 3,
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

describe('a sync group command', () => {
  it('reaches a chart whose price chart was not loaded when it fired, once it mounts', async () => {
    await open();
    await chooseLayout('two-across');
    await setGroup(1, 'blue');
    await setMarket(1, 'ETH/USDT');
    // The second chart's price chart is not loaded while the command fires.
    world.unloaded = ['ETH/USDT'];
    await rerender();
    await addFrom(0, 'sma', 'Simple moving average', true);
    expect(chipsOf(0)).toEqual(['SMA 20']);
    expect(q('[data-cell="1"] [data-testid="price-chart"]')?.textContent).toBe('');
    world.unloaded = [];
    await rerender();
    expect(chipsOf(1)).toEqual(['SMA 20']);
  });

  it('does not reach a chart that joins the group after the command was issued', async () => {
    await open();
    await chooseLayout('grid');
    await setGroup(1, 'blue');
    await setGroup(2, 'none');
    await addFrom(0, 'sma', 'Simple moving average', true);
    expect(chipsOf(0)).toEqual(['SMA 20']);
    expect(chipsOf(1)).toEqual(['SMA 20']);
    expect(chipsOf(2)).toEqual([]);
    await setGroup(2, 'blue');
    expect(chipsOf(2)).toEqual([]);
  });
});

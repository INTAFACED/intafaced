// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../data/types';
import type { DeskMarket } from '../trade/desk/market';
import type { ChartHost } from './chart-host';

// TEST candles and markets, not published figures.
const world = vi.hoisted(() => ({ candles: new Map<string, unknown>() }));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../trade/chart/candles', async (original) => ({
  ...(await original<typeof import('../trade/chart/candles')>()),
  useChartCandles: (symbol: string) => world.candles.get(symbol),
}));
vi.mock('./owner-values', async (original) => ({
  ...(await original<typeof import('./owner-values')>()),
  useChartOwnerValues: () => ({ status: 'ready', data: { compareCap: 3 }, asOf: 0 }),
}));
import { CompareTools } from './CompareTools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bar = (t: number, c: string): Candle => ({ t, o: c, h: c, l: c, c, v: '1', filled: false });
const market = (symbol: string) => ({ symbol, tickSize: '0.01' }) as unknown as DeskMarket;
const bars = (symbol: string, closes: string[]) => ({
  status: 'ready',
  data: closes.map((c, i) => bar(60_000 * (i + 1), c)),
  asOf: 0,
});

interface FakeSeries {
  options: Record<string, unknown>;
  data: Array<{ time: number; value: number }>;
  removed: boolean;
  setData(data: unknown[]): void;
  applyOptions(options: Record<string, unknown>): void;
  dataByIndex(index: number): unknown;
}

/** A host whose chart keeps every line it was asked to add, so a test can see what is drawn now. */
function fakeHost() {
  const lines: FakeSeries[] = [];
  const chart = {
    addSeries(_definition: unknown, options: Record<string, unknown>): FakeSeries {
      const line: FakeSeries = {
        options: { ...options },
        data: [],
        removed: false,
        setData(data) {
          line.data = data as FakeSeries['data'];
        },
        applyOptions(next) {
          Object.assign(line.options, next);
        },
        dataByIndex: (index) => line.data[index] ?? null,
      };
      lines.push(line);
      return line;
    },
    removeSeries(line: FakeSeries) {
      line.removed = true;
    },
    applyOptions() {},
    timeScale: () => ({ getVisibleLogicalRange: () => null }),
    takeScreenshot: () => ({}),
  };
  const host = { lib: { LineSeries: 'LineSeries' }, chart, element: document.createElement('div') } as unknown as ChartHost;
  return { host, lines, alive: () => lines.filter((line) => !line.removed) };
}

let container: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  world.candles.set('ETH/USDT', bars('ETH/USDT', ['10', '11']));
  world.candles.set('SOL/USDT', bars('SOL/USDT', ['20', '21', '22']));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent === name)!;
const click = (name: string) => act(() => button(name).click());

describe('compare lines', () => {
  it('keeps the remaining line drawn with its own data after an earlier market is removed', () => {
    const { host, alive } = fakeHost();
    const markets = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'].map(market);
    act(() => {
      root = createRoot(container);
      root.render(
        <CompareTools
          host={host}
          market={markets[0]!}
          markets={markets}
          interval="1m"
          style="candles"
          bars={[]}
          percent={false}
          onPercent={() => undefined}
        />,
      );
    });
    // The picker offers the one not yet added, so the default pick adds ETH and then SOL.
    click('Add');
    click('Add');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(alive().map((line) => line.options.title)).toEqual(['ETH/USDT', 'SOL/USDT']);

    // Removing ETH moves SOL to the first colour slot: its line is made again, and it is drawn with its own bars.
    click('Remove ETH/USDT');
    const [solLine] = alive();
    expect(alive()).toHaveLength(1);
    expect(solLine!.options.title).toBe('SOL/USDT');
    expect(solLine!.options.priceScaleId).toBe('left');
    expect(solLine!.data.map((point) => point.value)).toEqual([20, 21, 22]);
  });
});

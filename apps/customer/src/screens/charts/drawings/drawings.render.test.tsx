// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../../data/types';
import type { ChartHost } from '../chart-host';
import { DrawingToolbar } from './DrawingToolbar';
import { ObjectTree } from './ObjectTree';
import { useDrawings, type DrawingsApi, type DrawingsOptions } from './useDrawings';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// TEST chart: bar index i is x = 10 i; price p is y = 2 (200 - p). The fake chart records the handlers the hook subscribes.
const T0 = 1_700_000_000;
const BAR_COUNT = 100;
const bars: Candle[] = Array.from({ length: BAR_COUNT }, (_, i) => ({
  t: (T0 + i * 60) * 1000,
  o: '100.00',
  h: '101.00',
  l: '99.00',
  c: '100.50',
  v: '1',
  filled: false,
}));

interface Clicks {
  click: Array<(param: { point?: { x: number; y: number } }) => void>;
  move: Array<(param: { point?: { x: number; y: number } }) => void>;
  element: HTMLElement;
}

function fakeHost(): { host: ChartHost; handlers: Clicks; attach: ReturnType<typeof vi.fn> } {
  const element = document.createElement('div');
  const handlers: Clicks = { click: [], move: [], element };
  const attach = vi.fn();
  const timeScale = {
    coordinateToLogical: (x: number) => x / 10,
    timeToCoordinate: (time: number) => ((time - T0) / 60) * 10,
  };
  const chart = {
    timeScale: () => timeScale,
    subscribeClick: (h: Clicks['click'][number]) => handlers.click.push(h),
    unsubscribeClick: (h: Clicks['click'][number]) => (handlers.click = handlers.click.filter((x) => x !== h)),
    subscribeCrosshairMove: (h: Clicks['move'][number]) => handlers.move.push(h),
    unsubscribeCrosshairMove: (h: Clicks['move'][number]) => (handlers.move = handlers.move.filter((x) => x !== h)),
    applyOptions: vi.fn(),
  };
  const main = {
    coordinateToPrice: (y: number) => 200 - y / 2,
    priceToCoordinate: (price: number) => (200 - price) * 2,
    attachPrimitive: attach,
    detachPrimitive: vi.fn(),
    getPane: () => ({ paneIndex: () => 0 }),
  };
  const host = {
    lib: {},
    chart,
    main,
    element,
    tickSize: '0.01',
    symbol: 'BTC/USDT',
  } as unknown as ChartHost;
  return { host, handlers, attach };
}

class MemoryStorage {
  private map = new Map<string, string>();
  constructor(private failWrites = false) {}
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('quota');
    this.map.set(key, value);
  }
}

let host: HTMLDivElement;
let root: Root | null = null;
let api: DrawingsApi | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ chart, options, bars: data }: { chart: ChartHost; options: DrawingsOptions; bars: Candle[] }) {
  const value = useDrawings(chart, data, options);
  api = value;
  return (
    <>
      <DrawingToolbar api={value} />
      <ObjectTree api={value} />
    </>
  );
}

const baseOptions = (storage: MemoryStorage | null = new MemoryStorage()): DrawingsOptions => ({
  userId: 'u1',
  workbench: 'main',
  symbol: 'BTC/USDT',
  tickSize: '0.01',
  limits: { drawingCap: 50, brushPointCap: 2000 },
  storage,
  newId: (() => {
    let n = 0;
    return () => `d${++n}`;
  })(),
});

async function mount(chart: ChartHost, options: DrawingsOptions) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<Harness chart={chart} options={options} bars={bars} />));
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label);
const press = (label: string) => act(async () => button(label)?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
// A click is a press and a release on the chart element, as a person makes it: placement is taken on the release.
const clickChart = (handlers: Clicks, x: number, y: number) =>
  act(async () => {
    const init = { clientX: x, clientY: y, button: 0, bubbles: true };
    handlers.element.dispatchEvent(new MouseEvent('pointerdown', init));
    window.dispatchEvent(new MouseEvent('pointerup', init));
  });
const key = (k: string, extra: KeyboardEventInit = {}) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  api = null;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

describe('drawings on the workbench chart', () => {
  it('shows the tool groups as labelled buttons', async () => {
    const { host: chart } = fakeHost();
    await mount(chart, baseOptions());
    expect(host.querySelector('[role="toolbar"][aria-label="Drawing tools"]')).not.toBeNull();
    expect(button('Trend line')).toBeDefined();
    expect(button('Parallel channel')).toBeDefined();
    expect(button('Pattern XABCD')).toBeDefined();
  });

  it('places a trend line on two clicks, stored as bar times and decimal prices', async () => {
    const fake = fakeHost();
    await mount(fake.host, baseOptions());
    await press('Trend line');
    expect(api?.tool).toBe('trend');
    await clickChart(fake.handlers, 100, 100);
    await clickChart(fake.handlers, 200, 80);
    expect(api?.drawings).toHaveLength(1);
    expect(api?.drawings[0]!.points).toEqual([
      { time: T0 + 600, price: '150.00' },
      { time: T0 + 1200, price: '160.00' },
    ]);
    // The object tree lists the exact stored values for a test to read.
    const points = host.querySelector('[data-testid="drawing-points"]')?.textContent ?? '';
    expect(points).toContain('150.00');
    expect(points).toContain('160.00');
    // The primitive is attached to the main series.
    expect(fake.attach).toHaveBeenCalled();
  });

  it('keeps drawings on this device, per person, workbench and symbol', async () => {
    const storage = new MemoryStorage();
    const fake = fakeHost();
    await mount(fake.host, baseOptions(storage));
    await press('Horizontal line');
    await clickChart(fake.handlers, 100, 100);
    expect(api?.drawings).toHaveLength(1);
    const stored = storage.getItem('charts-drawings:u1:main:BTC/USDT');
    expect(stored).toContain('"horizontal"');
    act(() => root?.unmount());
    root = null;
    host.innerHTML = '';
    const again = fakeHost();
    await mount(again.host, baseOptions(storage));
    expect(api?.drawings).toHaveLength(1);
  });

  it('deletes with the Delete key and brings the line back with Ctrl+Z at its original points', async () => {
    const fake = fakeHost();
    await mount(fake.host, baseOptions());
    await press('Trend line');
    await clickChart(fake.handlers, 100, 100);
    await clickChart(fake.handlers, 200, 80);
    const original = api!.drawings[0]!.points;
    await key('Delete');
    expect(api?.drawings).toHaveLength(0);
    await key('z', { ctrlKey: true });
    expect(api?.drawings).toHaveLength(1);
    expect(api?.drawings[0]!.points).toEqual(original);
  });

  it('shows "not saved" with a retry when the device store cannot be written', async () => {
    const fake = fakeHost();
    await mount(fake.host, baseOptions(new MemoryStorage(true)));
    await press('Horizontal line');
    await clickChart(fake.handlers, 100, 100);
    expect(host.querySelector('[data-testid="drawings-not-saved"]')?.textContent).toContain('Not saved on this device');
    expect(api?.drawings).toHaveLength(1);
  });

  it('refuses every new drawing while the drawing limit is blank, and says so', async () => {
    const fake = fakeHost();
    await mount(fake.host, { ...baseOptions(), limits: { drawingCap: null, brushPointCap: 2000 } });
    await press('Horizontal line');
    await clickChart(fake.handlers, 100, 100);
    expect(api?.drawings).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('No drawing limit is set');
  });

  it('locks a drawing so a drag or a delete refuses', async () => {
    const fake = fakeHost();
    await mount(fake.host, baseOptions());
    await press('Horizontal line');
    await clickChart(fake.handlers, 100, 100);
    await press('Lock');
    expect(api?.selected?.locked).toBe(true);
    await key('Delete');
    expect(api?.drawings).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('locked');
  });

  it('gives a Fibonacci retracement its level prices from the two points, at the tick', async () => {
    const fake = fakeHost();
    await mount(fake.host, baseOptions());
    await press('Fib retracement');
    // First point: bar 50 at 140.00 (y 120). Second point: bar 80 at 110.00 (y 180). Level L is 110 + (140 - 110) * L.
    await clickChart(fake.handlers, 500, 120);
    await clickChart(fake.handlers, 800, 180);
    expect(api?.drawings[0]!.points).toEqual([
      { time: T0 + 3000, price: '140.00' },
      { time: T0 + 4800, price: '110.00' },
    ]);
    const figures = [...host.querySelectorAll('[data-testid="drawing-figures"] li')].map((li) => li.textContent);
    expect(figures).toContain('0.618 at 128.54');
    expect(figures).toContain('0.5 at 125.00');
  });

  it('places a long position box on three clicks, with risk to reward and no order', async () => {
    const fake = fakeHost();
    await mount(fake.host, baseOptions());
    await press('Long position');
    // Entry 100.00 (y 200), stop 95.00 (y 210), target 110.00 (y 180).
    await clickChart(fake.handlers, 100, 200);
    await clickChart(fake.handlers, 200, 210);
    await clickChart(fake.handlers, 300, 180);
    expect(api?.drawings[0]!.kind).toBe('long');
    const figures = [...host.querySelectorAll('[data-testid="drawing-figures"] li')].map((li) => li.textContent ?? '');
    expect(figures.some((line) => line.includes('Reward to risk 2.00'))).toBe(true);
    expect(figures.some((line) => line.includes('Risk 5.00'))).toBe(true);
    expect(figures.some((line) => line.includes('places no order'))).toBe(true);
  });

  it('hides every drawing and clears them only after the dialog is confirmed', async () => {
    const fake = fakeHost();
    await mount(fake.host, baseOptions());
    await press('Horizontal line');
    await clickChart(fake.handlers, 100, 100);
    await press('Hide all');
    expect(api?.hiddenAll).toBe(true);
    await press('Show all');
    await press('Clear all');
    // Nothing is cleared until the in-app dialog is confirmed; its buttons sit outside the host, in the document.
    expect(api?.drawings).toHaveLength(1);
    const confirm = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Clear all' && !host.contains(node));
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(api?.drawings).toHaveLength(0);
  });
});

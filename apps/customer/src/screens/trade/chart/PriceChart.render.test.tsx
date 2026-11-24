// @vitest-environment happy-dom
// The trade price chart draws only with the page's resolved colours: an empty colour token never reaches the chart
// library, which throws "Failed to parse color" from its own code, outside any caller.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The vendored library sets window.LightweightCharts when it loads; here a recording stand-in is set instead.
vi.mock('../../../features/trade/vendor/lightweight-charts.standalone.production.js', () => ({}));
import { PriceChart } from './PriceChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKENS = [
  '--if-bg',
  '--if-fg-2',
  '--if-grid',
  '--if-line',
  '--if-up',
  '--if-down',
  '--if-vol-up',
  '--if-vol-down',
  '--if-lime',
  '--if-ma-1',
  '--if-ma-2',
  '--if-ma-3',
];
interface Options {
  layout: { background: { color: string }; textColor: string };
}
// Any method the chart calls on the stand-in returns another stand-in, so the test asserts only what reaches createChart.
const anything: unknown = new Proxy(() => anything, { get: (_t, key) => (key === 'then' ? undefined : anything), apply: () => anything });
const win: { LightweightCharts?: unknown } = window;
const createChart = vi.fn((_host: HTMLElement, _options: Options) => anything);

let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  createChart.mockClear();
  win.LightweightCharts = {
    createChart,
    CandlestickSeries: {},
    LineSeries: {},
    HistogramSeries: {},
    createSeriesMarkers: () => anything,
  };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  for (const token of TOKENS) document.documentElement.style.removeProperty(token);
  delete win.LightweightCharts;
});

async function mount() {
  root = createRoot(host);
  const mounted = root;
  await act(async () =>
    mounted.render(
      <PriceChart
        candles={[]}
        mode="candles"
        interval="1h"
        resetKey="BTC-USDT:1h"
        tickSize="0.01"
        orderLines={[]}
        fills={[]}
        timeZone="UTC"
        labels={{ buy: 'Buy', sell: 'Sell', open: 'O', high: 'H', low: 'L', close: 'C', change: 'Change', chart: 'TEST chart' }}
      />,
    ),
  );
  // The library's lazy load lands, deterministically, before the assertions.
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

describe('trade price chart colours', () => {
  it('creates no chart while its colour tokens read empty, so no empty colour reaches the library', async () => {
    await mount();
    expect(createChart).not.toHaveBeenCalled();
  });

  it('creates the chart with the resolved colours once the tokens have values', async () => {
    TOKENS.forEach((token, i) => document.documentElement.style.setProperty(token, `rgb(${i}, ${i}, ${i})`));
    await mount();
    expect(createChart).toHaveBeenCalledTimes(1);
    const options = createChart.mock.calls[0]![1];
    expect(options.layout.background.color).toBe('rgb(0, 0, 0)');
    expect(options.layout.textColor).toBe('rgb(1, 1, 1)');
  });
});

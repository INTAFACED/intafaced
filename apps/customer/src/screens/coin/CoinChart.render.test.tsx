// @vitest-environment happy-dom
// The coin chart draws only with the page's resolved colours: an empty colour token never reaches the chart library,
// which throws "Failed to parse color" from its own code, outside any caller.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The vendored library sets window.LightweightCharts when it loads; here a recording stand-in is set instead.
vi.mock('../../features/trade/vendor/lightweight-charts.standalone.production.js', () => ({}));
import { CoinChart } from './CoinChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKENS = ['--if-panel', '--if-fg-2', '--if-line-stronger', '--if-pill-active', '--if-fg', '--if-up-text', '--if-down-text'];
const series = { setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn() };
interface Options {
  layout: { background: { color: string }; textColor: string };
}
const win: { LightweightCharts?: unknown } = window;
const createChart = vi.fn((_host: HTMLElement, _options: Options) => ({
  addSeries: () => series,
  remove: vi.fn(),
  applyOptions: vi.fn(),
  timeScale: () => ({ fitContent: vi.fn(), setVisibleLogicalRange: vi.fn() }),
  subscribeCrosshairMove: vi.fn(),
  unsubscribeCrosshairMove: vi.fn(),
}));

let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  createChart.mockClear();
  win.LightweightCharts = {
    createChart,
    LineSeries: {},
    createSeriesMarkers: () => ({ setMarkers: vi.fn() }),
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
      <CoinChart
        candles={[]}
        resetKey="BTC:1D"
        tickSize="0.01"
        direction="up"
        timeZone="UTC"
        label="TEST chart"
        onScrub={() => undefined}
      />,
    ),
  );
  // The library's lazy load lands, deterministically, before the assertions.
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

describe('coin chart colours', () => {
  it('creates no chart while its colour tokens read empty, so no empty colour reaches the library', async () => {
    await mount();
    expect(createChart).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="coin-chart__host"]')).not.toBeNull();
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

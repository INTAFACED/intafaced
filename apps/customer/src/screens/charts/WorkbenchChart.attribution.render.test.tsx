// @vitest-environment happy-dom
/**
 * The chart's attribution is ours, not the engine's: the engine's in-plot logo is off, and the same words and link are
 * drawn beside the plot, outside its image (an image may hold no link: axe nested-interactive).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTION_WORDS, WorkbenchChart, attributionHref } from './WorkbenchChart';
import { SCHEME_TOKENS } from './chart-style';

vi.mock('../../features/trade/vendor/lightweight-charts.standalone.production.js', () => ({}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in engine: every call answers, and the options each chart was made with are kept. */
const made: Array<Record<string, unknown>> = [];
function anything(): unknown {
  const answers: Record<string, unknown> = {
    data: () => [],
    options: () => ({}),
    seriesType: () => 'Candlestick',
    dataByIndex: () => null,
    getVisibleLogicalRange: () => null,
  };
  return new Proxy(() => undefined, {
    get: (_t, name) => (typeof name === 'string' && name in answers ? answers[name] : () => anything()),
    apply: () => anything(),
  });
}
const engine = new Proxy(
  {
    createChart: (_host: HTMLElement, options: Record<string, unknown>) => {
      made.push(options);
      return anything();
    },
  } as Record<string, unknown>,
  { get: (t, name) => (typeof name === 'string' && name in t ? t[name] : {}) },
);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  made.length = 0;
  // Every colour the chart reads: with any of them empty it draws nothing.
  for (const name of ['--if-bg', '--if-fg-2', '--if-grid', '--if-line', ...Object.values(SCHEME_TOKENS.standard)]) {
    document.documentElement.style.setProperty(name, 'TEST');
  }
  Reflect.set(window, 'LightweightCharts', engine);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'LightweightCharts');
});

const labels = { open: 'O', high: 'H', low: 'L', close: 'C', change: 'Chg', chart: 'Price chart of BTC-USD', keys: 'keys' };

describe('WorkbenchChart attribution', () => {
  it('turns the engine logo off and draws the attribution as a link outside the chart image', async () => {
    await act(async () => {
      root.render(
        <WorkbenchChart
          candles={[]}
          chartStyle="candles"
          scheme="standard"
          resetKey="k"
          symbol="BTC-USD"
          tickSize="0.01"
          timeZone="UTC"
          labels={labels}
        />,
      );
    });
    // The engine loads through a dynamic import: the chart is made once it resolves.
    await act(async () => {
      await vi.waitFor(() => expect(made).toHaveLength(1));
    });
    expect((made[0]!.layout as { attributionLogo?: boolean }).attributionLogo).toBe(false);

    const image = container.querySelector('[role="img"]')!;
    expect(image.getAttribute('aria-label')).toBe('Price chart of BTC-USD');
    expect(image.querySelector('a')).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="wc-attribution"]')!;
    expect(link.tagName).toBe('A');
    expect(link.textContent).toBe(ATTRIBUTION_WORDS);
    expect(image.contains(link)).toBe(false);
    expect(link.closest('[role="img"]')).toBeNull();
    expect(link.getAttribute('href')).toBe(attributionHref(window.location));
    expect(link.hidden).toBe(false);
  });

  it("links where the engine's logo links: its address, with the page it sits on as the source", () => {
    const base = 'https://www.tradingview.com/?utm_medium=lwc-link&utm_campaign=lwc-chart';
    expect(attributionHref({ hostname: '', pathname: '/' })).toBe(base);
    expect(attributionHref({ hostname: 'app.example', pathname: '/charts' })).toBe(`${base}&utm_source=app.example/charts`);
    expect(ATTRIBUTION_WORDS).toBe('Charting by TradingView');
  });
});

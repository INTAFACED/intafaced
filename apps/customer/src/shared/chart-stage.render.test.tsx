// @vitest-environment happy-dom
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMainSeriesBars, type StageSeries, type StageTimeScale } from './chart-stage';

// The real chart library, not a stand-in: what is checked is where the library's own view ends up.
interface Lib {
  createChart(element: HTMLElement, options: Record<string, unknown>): Api;
  CandlestickSeries: unknown;
  HistogramSeries: unknown;
}
interface Api {
  timeScale(): StageTimeScale & { getVisibleRange(): { from: number; to: number } | null };
  addSeries(definition: unknown, options?: Record<string, unknown>, pane?: number): StageSeries;
  remove(): void;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let lib: Lib;
let container: HTMLDivElement;
let element: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  // The test DOM has no canvas to draw on; the view's arithmetic needs none, so drawing goes nowhere.
  const nowhere: Record<string, unknown> = {
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 5 }),
  };
  HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy(nowhere, { get: (t, k: string) => (k in t ? t[k] : () => undefined), set: () => true });
  } as never;
  await import('../features/trade/vendor/lightweight-charts.standalone.production.js');
  lib = (globalThis as { LightweightCharts?: Lib }).LightweightCharts!;
});
beforeEach(() => {
  container = document.createElement('div');
  element = document.createElement('div');
  document.body.append(container, element);
  root = createRoot(container);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
  element.remove();
});

// Reads a "#rrggbb" colour, as the test DOM's computed style cannot.
const hex = (colour: string) => {
  const n = parseInt(/^#([0-9a-f]{6})$/i.exec(colour)?.[1] ?? '000000', 16);
  return [n >> 16, (n >> 8) & 255, n & 255, 1];
};

const MINUTE = 60;
const NEWEST = 1_700_000_000;
/** `count` one-minute bars ending at the same newest bar, oldest first, `t` in epoch ms. */
const barsOf = (count: number) => Array.from({ length: count }, (_, i) => ({ t: (NEWEST - (count - 1 - i) * MINUTE) * 1000 }));
const candle = (bar: { t: number }) => ({ time: bar.t / 1000, open: 1, high: 2, low: 0.5, close: 1.5 });
/** The library applies a set view on its next frame. */
const frame = () => act(() => vi.advanceTimersByTime(50));

function useStage() {
  const chart = useRef<Api | null>(null);
  const main = useRef<StageSeries | null>(null);
  const other = useRef<StageSeries | null>(null);
  if (!chart.current) {
    chart.current = lib.createChart(element, {
      width: 800,
      height: 400,
      layout: { colorParsers: [hex] },
      timeScale: { rightOffset: 6 },
    });
    main.current = chart.current.addSeries(lib.CandlestickSeries);
    other.current = chart.current.addSeries(lib.HistogramSeries, {}, 1);
  }
  return { chart, main, other };
}

describe('useMainSeriesBars with older history put in front', () => {
  // `studyFirst`: another series on the chart (a study) takes the longer history before the main series does, as a
  // study's own effect does when it runs first; the time scale has then already grown when the bars are set.
  for (const studyFirst of [false, true]) {
    it(`keeps the view on the same bars${studyFirst ? ' when a study took the longer history first' : ''}`, () => {
      let stage!: ReturnType<typeof useStage>;
      function Probe({ bars }: { bars: { t: number }[] }) {
        stage = useStage();
        const { other } = stage;
        useEffect(() => {
          if (studyFirst) other.current?.setData(bars.map((bar) => ({ time: bar.t / 1000, value: 1 })));
        }, [other, bars]);
        useMainSeriesBars(stage.chart, stage.main, 'host', bars, {
          key: 'candles',
          fitKey: 'market',
          plan: () => ({ kind: 'reset' }),
          points: () => ({ points: bars.map(candle), report: null }),
        });
        return null;
      }
      act(() => root.render(<Probe bars={barsOf(240)} />));
      frame();
      // Panned to the left edge, as a pan that asks for older history leaves it: the oldest bar to the 236th.
      stage.chart.current!.timeScale().setVisibleLogicalRange({ from: -10.27, to: 234.73 });
      frame();
      const before = stage.chart.current!.timeScale().getVisibleRange();
      expect(before).toEqual({ from: NEWEST - 239 * MINUTE, to: NEWEST - 4 * MINUTE });

      act(() => root.render(<Probe bars={barsOf(699)} />));
      frame();
      expect(stage.chart.current!.timeScale().getVisibleLogicalRange()).toEqual({
        from: expect.closeTo(448.73, 6),
        to: expect.closeTo(693.73, 6),
      });
      // The newest bar in view is the same one; the view's left margin now falls on the older bars just loaded.
      expect(stage.chart.current!.timeScale().getVisibleRange()?.to).toBe(before!.to);
      act(() => root.unmount());
      stage.chart.current!.remove();
      root = createRoot(container);
    });
  }
});

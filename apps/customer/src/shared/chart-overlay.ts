/**
 * Keeping what is drawn over a Lightweight Charts chart in step with it (J-charts-desk-15: orders on the venue desk's
 * chart). The chart is the library's own object, typed here by the few calls these hooks make, so they know no screen.
 *
 * - `useChartOverlay`: the pointer over the chart and its context menu reach the screen's handlers, and the screen draws
 *   again on a pan, a zoom, a resize and once a second (the price scale moves with new bars). Everything is unsubscribed
 *   when the chart goes.
 * - `useChartPriceLines`: price lines on the chart's own canvas, drawn again only when their key changes, with the price
 *   scale taking every line in, so a line far from the bars stays on the chart to read and to drag.
 */
import { useEffect, useRef, useState } from 'react';

export interface CrosshairPoint {
  point?: { x: number; y: number };
  paneIndex?: number;
}

export interface OverlayHost {
  chart: {
    subscribeCrosshairMove(handler: (param: CrosshairPoint) => void): void;
    unsubscribeCrosshairMove(handler: (param: CrosshairPoint) => void): void;
    timeScale(): {
      subscribeVisibleLogicalRangeChange(handler: (range: { from: number; to: number } | null) => void): void;
      unsubscribeVisibleLogicalRangeChange(handler: (range: { from: number; to: number } | null) => void): void;
    };
  };
  main: {
    createPriceLine(options: Record<string, unknown>): unknown;
    removePriceLine(line: unknown): void;
    applyOptions(options: Record<string, unknown>): void;
  };
  element: HTMLElement;
}

/**
 * A venue price (a decimal string) as the chart's own float, only to place it on the price scale. Never used for an
 * amount that is sent, locked or shown as money: those stay decimal strings.
 */
export function chartPrice(price: string): number {
  return Number(price);
}

/** How often the overlay is drawn again with no event: the price scale moves as new bars arrive. */
const REDRAW_MS = 1000;

/**
 * Subscribes the screen's handlers to the chart's pointer and context menu while `host` is there, and returns a number
 * that changes whenever the overlay should be drawn again.
 */
export function useChartOverlay(
  host: OverlayHost | null,
  handlers: { onCrosshair: (param: CrosshairPoint) => void; onContextMenu: (event: MouseEvent) => void },
): number {
  const [frame, setFrame] = useState(0);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!host) return;
    let queued = false;
    const redraw = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setFrame((n) => n + 1);
      });
    };
    const onMove = (param: CrosshairPoint) => {
      redraw();
      latest.current.onCrosshair(param);
    };
    const onContext = (event: MouseEvent) => {
      event.preventDefault();
      latest.current.onContextMenu(event);
    };
    host.chart.subscribeCrosshairMove(onMove);
    host.chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    const resize = new ResizeObserver(redraw);
    resize.observe(host.element);
    const timer = window.setInterval(redraw, REDRAW_MS);
    host.element.addEventListener('contextmenu', onContext);
    return () => {
      host.chart.unsubscribeCrosshairMove(onMove);
      host.chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw);
      resize.disconnect();
      window.clearInterval(timer);
      host.element.removeEventListener('contextmenu', onContext);
    };
  }, [host]);
  return frame;
}

/** One line on the chart's canvas. `token` names the colour role (`--if-up`), read from the app's theme when drawn. */
export interface PriceLineSpec {
  price: number;
  token: string;
  lineWidth: number;
  /** The library's line style: 0 solid, 2 dashed. */
  lineStyle: number;
  title: string;
}

/** Draws `lines` on the chart's main series, again only when `key` changes (it must carry every value the lines draw). */
export function useChartPriceLines(host: OverlayHost | null, lines: readonly PriceLineSpec[], key: string): void {
  const latest = useRef(lines);
  latest.current = lines;
  useEffect(() => {
    if (!host) return;
    const specs = latest.current;
    const css = getComputedStyle(document.documentElement);
    const drawn = specs.map((line) =>
      host.main.createPriceLine({
        price: line.price,
        color: css.getPropertyValue(line.token).trim(),
        lineWidth: line.lineWidth,
        lineStyle: line.lineStyle,
        axisLabelVisible: true,
        title: line.title,
      }),
    );
    const prices = specs.map((line) => line.price);
    if (prices.length > 0)
      host.main.applyOptions({
        autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
          const base = original();
          const low = Math.min(...prices, base?.priceRange.minValue ?? Infinity);
          const high = Math.max(...prices, base?.priceRange.maxValue ?? -Infinity);
          return { ...base, priceRange: { minValue: low, maxValue: high } };
        },
      });
    return () => {
      for (const line of drawn) host.main.removePriceLine(line);
      if (prices.length > 0) host.main.applyOptions({ autoscaleInfoProvider: undefined });
    };
  }, [host, key]);
}

import { tradeCopy as copy, CopyText, choiceText, choiceNode, choiceLanguage } from './copy';
import { useEffect, useRef, useState } from 'react';
import type { OHLCV, Position } from '@intafaced/exchange-contract/schemas';
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { z } from 'zod';
import { decimalSchema, parseAmount, formatAmount } from '../../shared/money';
import { Button, EmptyState, Failure, Loading } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import type { Listing, TradeApi, Order } from './trade-api';
import { usePreferences, useResolvedTheme, savePreferences } from '../../shared/preferences';
import { TIMEFRAMES } from './trade-api';
import { PriceAlerts } from './PriceAlerts';

type Point = { time: number; value: number };
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Series = {
  applyOptions: (options: Record<string, unknown>) => void;
  update: (data: Point | Omit<Bar, 'volume'>) => void;
  setData: (data: (Point | Omit<Bar, 'volume'> | { time: number; value: number; color: string })[]) => void;
  createPriceLine: (options: Record<string, unknown>) => unknown;
  removePriceLine: (line: unknown) => void;
  priceToCoordinate: (price: number) => number | null;
  coordinateToPrice: (coordinate: number) => number | null;
};
type ChartApi = {
  applyOptions: (options: Record<string, unknown>) => void;
  addSeries: (type: unknown, options?: Record<string, unknown>, pane?: number) => Series;
  remove: () => void;
  timeScale: () => {
    getVisibleLogicalRange: () => { from: number; to: number } | null;
    setVisibleLogicalRange: (range: { from: number; to: number }) => void;
    fitContent: () => void;
    scrollToRealTime: () => void;
    coordinateToTime: (coordinate: number) => number | null;
    timeToCoordinate: (time: number) => number | null;
    subscribeVisibleLogicalRangeChange: (fn: () => void) => void;
  };
  subscribeClick: (fn: (event: { point?: { x: number; y: number }; time?: number }) => void) => void;
};
type Engine = {
  createChart: (host: HTMLElement, options: Record<string, unknown>) => ChartApi;
  CandlestickSeries: unknown;
  LineSeries: unknown;
  HistogramSeries: unknown;
};
function chartAppearance() {
  const css = getComputedStyle(document.documentElement),
    up = css.getPropertyValue('--chart-up').trim() || css.getPropertyValue('--color-positive').trim() || '#c8f64a',
    down = css.getPropertyValue('--chart-down').trim() || css.getPropertyValue('--color-negative').trim() || '#f05a68',
    background = css.getPropertyValue('--color-shell').trim() || '#111111',
    text = css.getPropertyValue('--color-muted').trim() || '#a3a3a3',
    divider = css.getPropertyValue('--color-divider').trim() || '#262626';
  return {
    chart: {
      layout: { background: { color: background }, textColor: text },
      grid: { vertLines: { color: divider }, horzLines: { color: divider } },
      rightPriceScale: { borderColor: divider },
      timeScale: { borderColor: divider },
    },
    series: { color: up, upColor: up, downColor: down, wickUpColor: up, wickDownColor: down },
  };
}
declare global {
  interface Window {
    LightweightCharts?: Engine;
  }
}
type Drawing = { kind: 'level' | 'trend' | 'rectangle'; points: [number, string][] };
export type Study = 'MA' | 'Volume' | 'VWAP' | 'RSI' | 'MACD' | 'Bollinger';
export type ChartView = { interval: string; type: string; studies: Study[] };
const drawingsSchema = z.array(
  z.object({
    kind: z.enum(['level', 'trend', 'rectangle']),
    points: z
      .array(z.tuple([z.number().int().nonnegative().safe(), decimalSchema.refine((value) => parseAmount(value) > 0n)]))
      .min(1)
      .max(2),
  }),
);
/** Numeric values are chart geometry only. They never leave this component as order data. */
function chartBars(rows: OHLCV[], type: string): Bar[] {
  let previous: Bar | undefined;
  return rows
    .map((row) => {
      const raw = {
        time: Math.floor(row[0] / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      };
      if (
        !Object.values(raw).every(Number.isFinite) ||
        raw.high < raw.low ||
        raw.high < Math.max(raw.open, raw.close) ||
        raw.low > Math.min(raw.open, raw.close)
      )
        throw new Error(copy.t('historyContainsAnInvalidCandle'));
      if (type !== 'Heikin Ashi') return raw;
      const close = (raw.open + raw.high + raw.low + raw.close) / 4,
        open = previous ? (previous.open + previous.close) / 2 : (raw.open + raw.close) / 2;
      previous = { ...raw, open, close, high: Math.max(raw.high, open, close), low: Math.min(raw.low, open, close) };
      return previous;
    })
    .sort((a, b) => a.time - b.time)
    .filter((row, index, rows) => index === 0 || row.time !== rows[index - 1]?.time);
}
function average(values: number[], period: number) {
  return values.map((_, index) =>
    index < period - 1 ? null : values.slice(index - period + 1, index + 1).reduce((sum, value) => sum + value, 0) / period,
  );
}
function ema(values: number[], period: number) {
  let current = values[0] ?? 0;
  return values.map((value) => {
    current = (value * 2) / (period + 1) + current * (1 - 2 / (period + 1));
    return current;
  });
}
function addStudies(chart: ChartApi, engine: Engine, bars: Bar[], studies: Study[]) {
  const updates: ((bars: Bar[]) => void)[] = [];
  const line = (calculate: (bars: Bar[]) => (number | null)[], color: string, pane = 0) => {
    const series = chart.addSeries(engine.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane);
    updates.push((rows) => {
      const values = calculate(rows);
      series.setData(
        rows.flatMap((bar, index) =>
          values[index] === null || values[index] === undefined ? [] : [{ time: bar.time, value: values[index] as number }],
        ),
      );
    });
  };
  if (studies.includes('MA'))
    line(
      (rows) =>
        average(
          rows.map((row) => row.close),
          20,
        ),
      '#e4bf72',
    );
  if (studies.includes('Volume')) {
    const series = chart.addSeries(engine.HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false }, 1);
    updates.push((rows) => {
      const css = getComputedStyle(document.documentElement),
        up = css.getPropertyValue('--chart-up').trim() || css.getPropertyValue('--color-positive').trim(),
        down = css.getPropertyValue('--chart-down').trim() || css.getPropertyValue('--color-negative').trim();
      series.setData(rows.map((row) => ({ time: row.time, value: row.volume, color: row.close >= row.open ? up : down })));
    });
  }
  if (studies.includes('VWAP'))
    line((rows) => {
      let volume = 0,
        value = 0;
      return rows.map((row) => {
        volume += row.volume;
        value += ((row.high + row.low + row.close) / 3) * row.volume;
        return volume ? value / volume : null;
      });
    }, '#80b7e0');
  if (studies.includes('RSI'))
    line(
      (rows) => {
        let gains = 0,
          losses = 0;
        return rows.map((row, index) => {
          const change = row.close - (rows[index - 1]?.close ?? row.close);
          if (index === 0) return null;
          if (index <= 14) {
            gains += Math.max(0, change);
            losses += Math.max(0, -change);
            if (index < 14) return null;
            gains /= 14;
            losses /= 14;
          } else {
            gains = (gains * 13 + Math.max(0, change)) / 14;
            losses = (losses * 13 + Math.max(0, -change)) / 14;
          }
          return gains === 0 && losses === 0 ? 50 : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
        });
      },
      '#e4bf72',
      2,
    );
  const macd = (rows: Bar[]) => {
    const values = rows.map((row) => row.close),
      fast = ema(values, 12),
      slow = ema(values, 26);
    return fast.map((value, index) => value - (slow[index] ?? value));
  };
  if (studies.includes('MACD')) {
    line(macd, '#80b7e0', 3);
    line((rows) => ema(macd(rows), 9), '#e4bf72', 3);
  }
  if (studies.includes('Bollinger')) {
    const band = (rows: Bar[], direction: number) => {
      const values = rows.map((row) => row.close),
        mid = average(values, 20);
      return mid.map((mean, index) =>
        mean === null
          ? null
          : mean + direction * Math.sqrt(values.slice(index - 19, index + 1).reduce((sum, value) => sum + (value - mean) ** 2, 0) / 20),
      );
    };
    line((rows) => band(rows, 0), '#a3a3a3');
    line((rows) => band(rows, 2), '#777777');
    line((rows) => band(rows, -2), '#777777');
  }
  const update = (rows: Bar[]) => updates.forEach((fn) => fn(rows));
  update(bars);
  return update;
}
export function MarketChart({
  api,
  market,
  orders,
  onStagePrice,
  accountKey,
  onStageAmend,
  positions,
  initialView,
  onViewChange,
}: {
  api: TradeApi;
  market: Listing;
  orders: Order[];
  onStagePrice: (price: string) => void;
  accountKey: string;
  onStageAmend?: (order: Order, price: string) => void;
  positions?: Position[];
  initialView?: ChartView;
  onViewChange?: (view: ChartView) => void;
}) {
  const preferences = usePreferences();
  const theme = useResolvedTheme(preferences.theme);
  const [feedStatus, setFeedStatus] = useState(copy.t('chartHistoricalPrices')),
    [countdown, setCountdown] = useState<number | null>(null);
  const barHistory = useRef<OHLCV[]>([]),
    historyReady = useRef(false),
    lastPrintAt = useRef<number | null>(null);
  const viewport = useRef<{ from: number; to: number } | null>(null),
    studyUpdate = useRef<((bars: Bar[]) => void) | null>(null),
    orderLines = useRef<unknown[]>([]),
    fillLines = useRef<unknown[]>([]);
  const positionLines = useRef<unknown[]>([]);
  const [chartRevision, setChartRevision] = useState(0);
  const [interval, setIntervalValue] = useState(initialView?.interval ?? '15m'),
    [type, setType] = useState(initialView?.type ?? 'Candles'),
    [studies, setStudies] = useState<Study[]>(initialView?.studies ?? ['Volume']),
    [drawings, setDrawings] = useState<Drawing[]>([]),
    [tool, setTool] = useState<Drawing['kind'] | null>(null),
    [compare, setCompare] = useState(''),
    [saved, setSaved] = useState<{ name: string; type: string; interval: string; studies: Study[] }[]>([]),
    [notice, setNotice] = useState(''),
    [fullscreen, setFullscreen] = useState(false),
    [multi, setMulti] = useState(false),
    [countdownVisible, setCountdownVisible] = useState(true),
    [inspected, setInspected] = useState<OHLCV | null>(null),
    [drawingsKey, setDrawingsKey] = useState<string | null>(null);
  const [showPosition, setShowPosition] = useState(true),
    [showMark, setShowMark] = useState(true),
    [showLiquidation, setShowLiquidation] = useState(true);
  const [dragging, setDragging] = useState<{ id: string; price: string; y: number } | null>(null);
  useEffect(() => {
    onViewChange?.({ interval, type, studies });
  }, [interval, type, studies, onViewChange]);
  const inspectionIndex = useRef<number | null>(null);
  const host = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLElement>(null),
    chartRef = useRef<ChartApi | null>(null),
    seriesRef = useRef<Series | null>(null),
    pending = useRef<[number, string][]>([]),
    rawPrice = useRef<Map<number, string>>(new Map());
  const fills = useResource(
    (signal) =>
      preferences.showFills
        ? api.fills(market.symbol, 100, signal)
        : Promise.resolve({ ok: true as const, data: [] as import('@intafaced/exchange-contract/schemas').Trade[] }),
    `${accountKey}:${market.id}:fills:${preferences.showFills}`,
  );
  const { resource, reload } = useResource((signal) => api.history(market.symbol, interval, signal), `${market.id}:${interval}`);
  historyReady.current = resource.status === 'ready';
  useEffect(() => {
    if (resource.status === 'ready') barHistory.current = resource.data.slice().sort((a, b) => a[0] - b[0]);
  }, [resource]);
  useEffect(() => {
    let socket: WebSocket | null = null,
      closed = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      connections = 0;
    const seen = new Set<number>();
    const span = TIMEFRAME_MS[interval as keyof typeof TIMEFRAME_MS];
    const printSchema = z.object({
      type: z.literal('trade'),
      marketId: z.string(),
      sequence: z.number().int().nonnegative().safe(),
      price: decimalSchema.refine((value) => parseAmount(value) > 0n),
      quantity: decimalSchema.refine((value) => parseAmount(value) > 0n),
      ts: z.string().datetime({ offset: true }),
      kind: z.enum(['aggressor', 'liquidation', 'block', 'bust', 'correction', 'unknown']),
    });
    const connect = () => {
      if (closed) return;
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/stream?market=${encodeURIComponent(market.id)}&channel=trades`,
      );
      socket.onopen = () => {
        if (connections++ > 0) reload();
        setFeedStatus(copy.t('waitingForAnActualTrade'));
      };
      socket.onmessage = (event) => {
        if (closed) return;
        let wire: unknown;
        try {
          wire = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = printSchema.safeParse(wire);
        if (!parsed.success || parsed.data.marketId !== market.id || seen.has(parsed.data.sequence)) return;
        const print = parsed.data;
        if (!historyReady.current || !seriesRef.current) return;
        seen.add(print.sequence);
        if (seen.size > 500) seen.delete(seen.values().next().value as number);
        if (print.kind === 'bust' || print.kind === 'correction') {
          reload();
          setFeedStatus(copy.t('refreshingCorrectedHistory'));
          return;
        }
        const bucket = Math.floor(Date.parse(print.ts) / span) * span;
        const last = barHistory.current.at(-1);
        if (last && bucket < last[0]) return;
        const next: OHLCV =
          last && bucket === last[0]
            ? [
                bucket,
                last[1],
                parseAmount(print.price) > parseAmount(last[2]) ? print.price : last[2],
                parseAmount(print.price) < parseAmount(last[3]) ? print.price : last[3],
                print.price,
                formatAmount(parseAmount(last[5]) + parseAmount(print.quantity)),
              ]
            : [bucket, print.price, print.price, print.price, print.price, print.quantity];
        if (last && bucket === last[0]) barHistory.current[barHistory.current.length - 1] = next;
        else barHistory.current.push(next);
        if (barHistory.current.length > 500) barHistory.current.shift();
        lastPrintAt.current = Date.now();
        rawPrice.current.set(Math.floor(bucket / 1000), print.price);
        const bar = chartBars(barHistory.current, type).at(-1);
        if (bar) seriesRef.current.update(type === 'Line' ? { time: bar.time, value: bar.close } : bar);
        studyUpdate.current?.(chartBars(barHistory.current, 'Candles'));
        setFeedStatus(copy.t('acceptedTrade', { printKind: String(print.kind) }));
      };
      socket.onerror = () => setFeedStatus(copy.t('tradeStreamInterrupted'));
      socket.onclose = () => {
        if (closed) return;
        setFeedStatus(copy.t('historicalPricesReconnecting'));
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    const clock = setInterval(() => {
      const end = (barHistory.current.at(-1)?.[0] ?? 0) + span;
      setCountdown(end > Date.now() ? Math.ceil((end - Date.now()) / 1000) : null);
      if (lastPrintAt.current !== null && Date.now() - lastPrintAt.current >= 15000)
        setFeedStatus(copy.t('historicalPricesTradeStreamStale'));
    }, 1000);
    return () => {
      closed = true;
      socket?.close();
      clearInterval(clock);
      clearTimeout(retry);
    };
  }, [market.id, interval, type]);
  const comparison = useResource(
    (signal) => (compare ? api.history(compare, interval, signal) : Promise.resolve({ ok: true as const, data: [] as OHLCV[] })),
    `${market.id}:${compare}:${interval}`,
  );
  useEffect(() => {
    const key = `trade-drawings:${accountKey}:${market.id}`;
    try {
      const parsed = drawingsSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? '[]'));
      setDrawings(parsed.success ? parsed.data : []);
    } catch {
      setDrawings([]);
    }
    setDrawingsKey(key);
    setCompare('');
    pending.current = [];
    inspectionIndex.current = null;
    setInspected(null);
  }, [market.id, accountKey]);
  useEffect(() => {
    if (drawingsKey !== `trade-drawings:${accountKey}:${market.id}`) return;
    try {
      localStorage.setItem(drawingsKey, JSON.stringify(drawings));
    } catch {
      setNotice(copy.t('drawingsRemainInThisWorkspaceBecauseDeviceStorageIsUnavailable'));
    }
  }, [drawings, drawingsKey, accountKey, market.id]);
  useEffect(() => {
    try {
      const data = JSON.parse(localStorage.getItem(`trade-layouts:${accountKey}`) ?? '[]') as unknown;
      if (Array.isArray(data))
        setSaved(
          data.filter((row): row is { name: string; type: string; interval: string; studies: Study[] } =>
            Boolean(
              row &&
              typeof row === 'object' &&
              'name' in row &&
              'type' in row &&
              'interval' in row &&
              'studies' in row &&
              typeof row.name === 'string' &&
              ['Candles', 'Line', 'Heikin Ashi'].includes(String(row.type)) &&
              TIMEFRAMES.includes(row.interval as (typeof TIMEFRAMES)[number]) &&
              Array.isArray(row.studies),
            ),
          ),
        );
    } catch {
      setSaved([]);
    }
  }, [accountKey]);
  useEffect(() => {
    if (!host.current || resource.status !== 'ready' || !resource.data.length) return;
    let closed = false;
    let chart: ChartApi | null = null;
    void import('./vendor/lightweight-charts.standalone.production.js').then(() => {
      if (closed || !host.current || !window.LightweightCharts) return;
      const engine = window.LightweightCharts;
      const appearance = chartAppearance();
      try {
        const bars = chartBars(barHistory.current, type);
        rawPrice.current = new Map(barHistory.current.map((row) => [Math.floor(row[0] / 1000), row[4]]));
        chart = engine.createChart(host.current, {
          autoSize: true,
          ...appearance.chart,
          layout: { ...appearance.chart.layout, fontFamily: 'Inter', fontSize: 11, attributionLogo: true },
          timeScale: { ...appearance.chart.timeScale, timeVisible: true },
          localization: {
            timeFormatter: (timestamp: number) =>
              new Intl.DateTimeFormat(preferences.language, {
                dateStyle: 'short',
                timeStyle: 'short',
                ...(preferences.timeZone === 'device' ? {} : { timeZone: preferences.timeZone === 'UTC+8' ? 'Asia/Singapore' : 'UTC' }),
              }).format(new Date(timestamp * 1000)),
          },
          crosshair: { mode: 0 },
        });
        const series = chart.addSeries(type === 'Line' ? engine.LineSeries : engine.CandlestickSeries, {
          ...appearance.series,
          borderVisible: false,
        });
        series.setData(type === 'Line' ? bars.map((bar) => ({ time: bar.time, value: bar.close })) : bars);
        studyUpdate.current = addStudies(chart, engine, chartBars(barHistory.current, 'Candles'), studies);
        orderLines.current = [];
        fillLines.current = [];
        positionLines.current = [];
        if (comparison.resource.status === 'ready' && compare) {
          const other = chartBars(comparison.resource.data, 'Line');
          chart
            .addSeries(engine.LineSeries, { color: '#80b7e0', priceScaleId: 'comparison', priceLineVisible: false, title: compare })
            .setData(other.map((bar) => ({ time: bar.time, value: bar.close })));
        }
        if (viewport.current) chart.timeScale().setVisibleLogicalRange(viewport.current);
        else chart.timeScale().fitContent();
        chartRef.current = chart;
        seriesRef.current = series;
        chart.timeScale().subscribeVisibleLogicalRangeChange(() => setChartRevision((value) => value + 1));
        setChartRevision((value) => value + 1);
        setNotice('');
        chart.subscribeClick((event) => {
          if (event.time) {
            const exact = rawPrice.current.get(event.time);
            setInspected(barHistory.current.find((row) => Math.floor(row[0] / 1000) === event.time) ?? null);
            if (exact && !tool) onStagePrice(exact);
          }
          if (tool && event.point && event.time) {
            const price = priceAtGeometry(event.point.y);
            if (price === null) return;
            pending.current.push([event.time, price]);
            if (tool === 'level' || pending.current.length === 2) {
              const points = pending.current;
              pending.current = [];
              setDrawings((current) => [...current, { kind: tool, points }]);
              setTool(null);
            }
          }
        });
      } catch (error) {
        setNotice(error instanceof Error ? error.message : copy.t('theChartCouldNotBeDrawn'));
      }
    });
    return () => {
      closed = true;
      viewport.current = chart?.timeScale().getVisibleLogicalRange() ?? null;
      chart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      studyUpdate.current = null;
    };
  }, [resource, comparison.resource, type, studies, tool, market.symbol, compare, preferences.timeZone, preferences.language]);
  useEffect(() => {
    const appearance = chartAppearance();
    chartRef.current?.applyOptions(appearance.chart);
    seriesRef.current?.applyOptions(appearance.series);
    studyUpdate.current?.(chartBars(barHistory.current, 'Candles'));
  }, [theme, preferences.upColor]);
  useEffect(() => {
    if (!host.current) return;
    const resize = new ResizeObserver(() => setChartRevision((value) => value + 1));
    resize.observe(host.current);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    orderLines.current.forEach((line) => series.removePriceLine(line));
    orderLines.current = [];
    if (preferences.showOrders)
      for (const order of orders)
        if (order.symbol === market.symbol && order.price !== null)
          orderLines.current.push(
            series.createPriceLine({
              price: Number(order.price),
              color: '#e4bf72',
              lineWidth: 1,
              lineStyle: 2,
              title: `${order.side} · ${order.id.slice(0, 6)}`,
              axisLabelVisible: true,
            }),
          );
  }, [orders, preferences.showOrders, chartRevision]);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    fillLines.current.forEach((line) => series.removePriceLine(line));
    fillLines.current = [];
    if (preferences.showFills && fills.resource.status === 'ready') {
      const css = getComputedStyle(document.documentElement);
      for (const fill of fills.resource.data)
        fillLines.current.push(
          series.createPriceLine({
            price: Number(fill.price),
            color:
              css.getPropertyValue(fill.side === 'buy' ? '--chart-up' : '--chart-down').trim() ||
              css.getPropertyValue(fill.side === 'buy' ? '--color-positive' : '--color-negative').trim(),
            lineStyle: 3,
            lineWidth: 1,
            title: copy.t('chartFill', { id: fill.id.slice(0, 6) }),
            axisLabelVisible: false,
          }),
        );
    }
  }, [fills.resource, preferences.showFills, chartRevision, theme, preferences.upColor]);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    positionLines.current.forEach((line) => series.removePriceLine(line));
    positionLines.current = [];
    for (const position of positions ?? []) {
      if (position.symbol !== market.symbol) continue;
      for (const [kind, title, value, color] of [
        ['entry', copy.t('positionEntry', { side: position.side }), position.entryPrice, 'var(--color-warning)'],
        ['mark', copy.t('positionAcceptedMark'), position.markPrice, 'var(--color-muted)'],
        ['liquidation', copy.t('positionLiquidation'), position.liquidationPrice, 'var(--color-negative)'],
      ] as const) {
        if (
          (!showPosition && kind === 'entry') ||
          (!showMark && kind === 'mark') ||
          (!showLiquidation && kind === 'liquidation') ||
          value === null ||
          parseAmount(value) <= 0n ||
          !Number.isFinite(Number(value))
        )
          continue;
        const resolvedColor = getComputedStyle(document.documentElement).getPropertyValue(color.slice(4, -1)).trim();
        positionLines.current.push(
          series.createPriceLine({ price: Number(value), color: resolvedColor, title, lineWidth: 1, lineStyle: 2, axisLabelVisible: true }),
        );
      }
    }
  }, [positions, market.symbol, chartRevision, showPosition, showMark, showLiquidation, preferences.language, theme]);

  function saveLayout() {
    const name = window.prompt(copy.t('layoutNamePrompt'));
    if (!name?.trim()) return;
    const next = [...saved.filter((row) => row.name !== name.trim()), { name: name.trim(), type, interval, studies }];
    setSaved(next);
    try {
      localStorage.setItem(`trade-layouts:${accountKey}`, JSON.stringify(next));
      setNotice(copy.t('layoutSavedOnThisDeviceAccountSynchronizationIsNotConnected'));
    } catch {
      setNotice(copy.t('browserStorageIsUnavailableThisLayoutWasNotSaved'));
    }
  }
  function priceAtGeometry(y: number): string | null {
    const series = seriesRef.current,
      rows = barHistory.current;
    if (!series || !rows.length) return null;
    const low = rows.reduce((value, row) => (parseAmount(row[3]) < value ? parseAmount(row[3]) : value), parseAmount(rows[0]![3])),
      high = rows.reduce((value, row) => (parseAmount(row[2]) > value ? parseAmount(row[2]) : value), parseAmount(rows[0]![2]));
    if (low === high) return null;
    const lowY = series.priceToCoordinate(Number(formatAmount(low))),
      highY = series.priceToCoordinate(Number(formatAmount(high)));
    if (lowY === null || highY === null || lowY === highY) return null;
    // Prices stay scaled bigint. Only pixel geometry is rounded to a rational screen coordinate.
    const numerator = BigInt(Math.round((y - lowY) * 1000000)),
      denominator = BigInt(Math.round((highY - lowY) * 1000000));
    if (denominator === 0n) return null;
    const value = low + ((high - low) * numerator) / denominator,
      tick = parseAmount(market.precision.price);
    const aligned = ((value + tick / 2n) / tick) * tick;
    return aligned > 0n ? formatAmount(aligned) : null;
  }
  const draw = (drawing: Drawing, index: number) => {
    const positions = drawing.points.map(([time, price]) => [
      chartRef.current?.timeScale().timeToCoordinate(time),
      seriesRef.current?.priceToCoordinate(Number(price)),
    ]);
    const [a, b] = positions;
    if (!a || a[0] == null || a[1] == null) return null;
    if (drawing.kind === 'level') return <line key={index} x1="0" x2="100%" y1={a[1]} y2={a[1]} />;
    if (!b || b[0] == null || b[1] == null) return null;
    return drawing.kind === 'trend' ? (
      <line key={index} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
    ) : (
      <rect
        key={index}
        x={Math.min(a[0], b[0])}
        y={Math.min(a[1], b[1])}
        width={Math.abs(a[0] - b[0])}
        height={Math.abs(a[1] - b[1])}
        fill="transparent"
      />
    );
  };
  return (
    <section
      className={`trade-chart ${fullscreen ? 'trade-chart--fullscreen' : ''}`}
      ref={frame}
      aria-label={copy.t('chartc80af2', { marketSymbol: String(market.symbol) })}
    >
      <div className="trade-chart-toolbar">
        <label className="trade-inline">
          <CopyText k="interval" />
          <select aria-label={copy.t('chartInterval')} value={interval} onChange={(event) => setIntervalValue(event.target.value)}>
            {TIMEFRAMES.map((value) => (
              <option key={value} value={value} lang={choiceLanguage(value)}>
                {choiceText(value)}
              </option>
            ))}
          </select>
        </label>
        <select aria-label={copy.t('chartType')} value={type} onChange={(event) => setType(event.target.value)}>
          {['Candles', 'Line', 'Heikin Ashi'].map((value) => (
            <option key={value} value={value} lang={choiceLanguage(value)}>
              {choiceText(value)}
            </option>
          ))}
        </select>
        <details>
          <summary>
            <CopyText k="indicators" />
          </summary>
          <div className="trade-menu">
            {(['MA', 'Volume', 'VWAP', 'RSI', 'MACD', 'Bollinger'] as Study[]).map((study) => (
              <label key={study}>
                <input
                  type="checkbox"
                  checked={studies.includes(study)}
                  onChange={() =>
                    setStudies((current) => (current.includes(study) ? current.filter((value) => value !== study) : [...current, study]))
                  }
                />
                {choiceNode(study)}
              </label>
            ))}
            <small>
              <CopyText k="maRsiMacdBollingerVwapOverLoadedHistory" />
            </small>
          </div>
        </details>
        <details>
          <summary>
            <CopyText k="draw" />
          </summary>
          <div className="trade-menu">
            {(['level', 'trend', 'rectangle'] as const).map((value) => (
              <button
                key={value}
                onClick={() => {
                  setTool(value);
                  pending.current = [];
                }}
              >
                {choiceNode(value)}
              </button>
            ))}
            <button onClick={() => setDrawings([])}>
              <CopyText k="clearDrawings" />
            </button>
            <small>
              <CopyText k="drawingsRemainInThisWorkspacePanOrZoomToRepositionThem" />
            </small>
          </div>
        </details>
        <details>
          <summary>
            <CopyText k="layouts" />
          </summary>
          <div className="trade-menu">
            <button onClick={saveLayout}>
              <CopyText k="saveLayoutOnDevice" />
            </button>
            {saved.map((layout) => (
              <button
                key={layout.name}
                onClick={() => {
                  setType(layout.type);
                  setIntervalValue(layout.interval);
                  setStudies(layout.studies);
                }}
              >
                {layout.name}
              </button>
            ))}
            <label>
              <input type="checkbox" checked={multi} onChange={(event) => setMulti(event.target.checked)} />
              <CopyText k="secondLinkedChart" />
            </label>
          </div>
        </details>
        <details>
          <summary>
            <CopyText k="view" />
          </summary>
          <div className="trade-menu">
            <label>
              <input
                type="checkbox"
                checked={preferences.showOrders}
                onChange={(event) => savePreferences({ showOrders: event.target.checked })}
              />
              <CopyText k="openOrders" />
            </label>
            <label>
              <input
                type="checkbox"
                checked={preferences.showFills}
                onChange={(event) => savePreferences({ showFills: event.target.checked })}
              />
              <CopyText k="oldFills" />
            </label>
            <label>
              <input
                type="checkbox"
                checked={showPosition}
                disabled={!positions}
                onChange={(event) => setShowPosition(event.target.checked)}
              />
              <CopyText k="positionEntryOverlay" />
            </label>
            <label>
              <input type="checkbox" checked={showMark} disabled={!positions} onChange={(event) => setShowMark(event.target.checked)} />
              <CopyText k="acceptedMark505c6f" />
            </label>
            <label>
              <input
                type="checkbox"
                checked={showLiquidation}
                disabled={!positions}
                onChange={(event) => setShowLiquidation(event.target.checked)}
              />
              <CopyText k="liquidation7f616e" />
            </label>
            <label>
              <input type="checkbox" checked={countdownVisible} onChange={(event) => setCountdownVisible(event.target.checked)} />
              <CopyText k="candleCountdown" />
            </label>
            <button disabled>
              <CopyText k="newsMarksUnavailable" />
            </button>
            <small>
              <CopyText k="noTimestampedMarketNewsServiceIsMounted" />
            </small>
            <a href="/view">
              <CopyText k="viewPreferences" />
            </a>
          </div>
        </details>
        <PriceAlerts key={[market.id, market.symbol, market.base, market.quote, market.paper, accountKey].join(':')} market={market} />
        <Button
          variant="ghost"
          aria-label={fullscreen ? copy.t('exitFullScreenChart') : copy.t('fullScreenChart')}
          onClick={() => setFullscreen(!fullscreen)}
        >
          {fullscreen ? '↙' : '⤢'}
        </Button>
      </div>
      <div className="trade-chart-context">
        <strong>{market.symbol}</strong>
        <span>
          {interval} · {type} · {preferences.timeZone}
        </span>
        <button onClick={reload}>
          <CopyText k="refreshHistory" />
        </button>
        <button onClick={() => chartRef.current?.timeScale().fitContent()}>
          <CopyText k="fit" />
        </button>
        <button onClick={() => chartRef.current?.timeScale().scrollToRealTime()}>
          <CopyText k="follow" />
        </button>
      </div>
      {inspected && (
        <p className="trade-candle-inspection">
          <CopyText k="o" />
          {inspected[1]} <CopyText k="h" />
          {inspected[2]} <CopyText k="l" />
          {inspected[3]} <CopyText k="c" />
          {inspected[4]} {market.quote} <CopyText k="v" />
          {inspected[5]} {market.base}
        </p>
      )}
      <div
        className="trade-chart-canvas"
        role="img"
        tabIndex={0}
        aria-label={copy.t('actualHistoricalPrices', { marketSymbol: String(market.symbol) })}
        aria-description={copy.t('useLeftAndRightArrowsToInspectCandlesEnterStagesThe')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setFullscreen(false);
            setTool(null);
            return;
          }
          const rows = barHistory.current;
          if (!rows.length) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            inspectionIndex.current = Math.max(0, Math.min(rows.length - 1, (inspectionIndex.current ?? rows.length) + direction));
            setInspected(rows[inspectionIndex.current] ?? null);
          } else if (event.key === 'Enter' && inspected) {
            event.preventDefault();
            if (tool) {
              pending.current.push([Math.floor(inspected[0] / 1000), inspected[4]]);
              if (tool === 'level' || pending.current.length === 2) {
                const points = pending.current;
                pending.current = [];
                setDrawings((current) => [...current, { kind: tool, points }]);
                setTool(null);
              }
            } else onStagePrice(inspected[4]);
          }
        }}
      >
        <div className="trade-engine" ref={host} />
        {resource.status === 'loading' ? (
          <Loading label={<CopyText k={'loadingMarketHistory'} />} />
        ) : resource.status === 'failed' ? (
          <Failure result={resource.failure} retry={reload} />
        ) : !barHistory.current.length ? (
          <EmptyState title={<CopyText k={'noPriceHistory'} />}>
            <CopyText k="theMarketHasNoPublishedCandlesForThisInterval" />
          </EmptyState>
        ) : null}
        <svg className="trade-drawings" aria-hidden="true" data-revision={chartRevision}>
          {drawings.map(draw)}
        </svg>
        {onStageAmend &&
          preferences.showOrders &&
          !market.paper &&
          orders
            .filter(
              (order) =>
                order.symbol === market.symbol &&
                order.type === 'limit' &&
                order.status === 'open' &&
                !order.recoveryRequired &&
                parseAmount(order.filled) === 0n &&
                order.price !== null,
            )
            .map((order) => {
              const y = dragging?.id === order.id ? dragging.y : seriesRef.current?.priceToCoordinate(Number(order.price));
              if (y === null || y === undefined || y < 0) return null;
              return (
                <button
                  className="trade-order-handle"
                  key={order.id}
                  style={{ top: y }}
                  aria-label={copy.t('changePriceForOrder', { orderId: String(order.id) })}
                  onClick={(event) => {
                    if (event.detail === 0 && order.price) onStageAmend(order, order.price);
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging({ id: order.id, price: order.price!, y });
                  }}
                  onPointerMove={(event) => {
                    if (dragging?.id !== order.id || !host.current) return;
                    const nextY = event.clientY - host.current.getBoundingClientRect().top,
                      price = priceAtGeometry(nextY);
                    if (price) setDragging({ id: order.id, price, y: nextY });
                  }}
                  onPointerUp={(event) => {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    if (dragging?.id === order.id) onStageAmend(order, dragging.price);
                    setDragging(null);
                  }}
                  onPointerCancel={() => setDragging(null)}
                >
                  ↕ {order.side} · {dragging?.id === order.id ? dragging.price : order.price}
                </button>
              );
            })}
      </div>
      <div className="trade-chart-footer">
        <span>
          {tool ? (
            <CopyText
              k={'selectToDraw'}
              params={{ toolLevelOnePoint: copy.t(tool === 'level' ? 'oneDrawingPoint' : 'twoDrawingPoints'), tool: String(tool) }}
            />
          ) : !countdownVisible || countdown === null ? (
            <CopyText k={'chartStatusWithoutCandle'} params={{ feedStatus }} />
          ) : (
            <CopyText k={'chartStatusWithCandle'} params={{ feedStatus, seconds: countdown }} />
          )}
        </span>
        <label className="trade-inline">
          <CopyText k="compare" />
          <input
            aria-label={copy.t('compareMarketSymbol')}
            value={compare}
            placeholder={copy.t('baseQuote')}
            onChange={(event) => setCompare(event.target.value.toUpperCase())}
          />
        </label>
      </div>
      {notice && (
        <p className="trade-note" role="status">
          {notice}
        </p>
      )}
      {compare && comparison.resource.status === 'failed' && <Failure result={comparison.resource.failure} retry={comparison.reload} />}
      {compare && comparison.resource.status === 'ready' && !comparison.resource.data.length && (
        <p className="trade-note">
          <CopyText k="noPublishedComparisonHistoryFor" />
          {compare}.
        </p>
      )}
      {multi && <SecondaryChart api={api} symbol={market.symbol} interval={interval} />}
    </section>
  );
}
export function SecondaryChart({
  api,
  symbol,
  interval,
  type = 'Line',
  workspace = false,
}: {
  api: TradeApi;
  symbol: string;
  interval: string;
  type?: string;
  workspace?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    chartRef = useRef<ChartApi | null>(null),
    seriesRef = useRef<Series | null>(null);
  const [failure, setFailure] = useState('');
  const preferences = usePreferences();
  const theme = useResolvedTheme(preferences.theme);
  const result = useResource((signal) => api.history(symbol, interval, signal), `${symbol}:${interval}`);
  useEffect(() => {
    if (!host.current || result.resource.status !== 'ready' || !result.resource.data.length) return;
    const rows = result.resource.data;
    let closed = false,
      chart: ChartApi | null = null;
    void import('./vendor/lightweight-charts.standalone.production.js').then(() => {
      if (closed || !host.current || !window.LightweightCharts) return;
      try {
        const engine = window.LightweightCharts,
          appearance = chartAppearance();
        chart = engine.createChart(host.current, {
          autoSize: true,
          ...appearance.chart,
          timeScale: { ...appearance.chart.timeScale, timeVisible: true },
        });
        const series = chart.addSeries(type === 'Line' ? engine.LineSeries : engine.CandlestickSeries, {
          ...appearance.series,
          borderVisible: false,
        });
        const bars = chartBars(rows, type);
        series.setData(type === 'Line' ? bars.map((row) => ({ time: row.time, value: row.close })) : bars);
        chart.timeScale().fitContent();
        chartRef.current = chart;
        seriesRef.current = series;
        setFailure('');
      } catch (error) {
        setFailure(error instanceof Error ? error.message : copy.t('secondaryChartFailure'));
      }
    });
    return () => {
      closed = true;
      chart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [result.resource, type]);
  useEffect(() => {
    const appearance = chartAppearance();
    chartRef.current?.applyOptions(appearance.chart);
    seriesRef.current?.applyOptions(appearance.series);
  }, [theme, preferences.upColor]);
  return (
    <section
      className={workspace ? 'trade-secondary-view' : undefined}
      aria-label={copy.t('secondLinkedChartc8a03f', { symbol: String(symbol) })}
    >
      <small className="trade-note">
        <CopyText k="secondChart" />
        {symbol} · {interval} <CopyText k="publishedHistory" />
      </small>
      {result.resource.status === 'loading' ? (
        <Loading label={<CopyText k={'loadingSecondChartHistory'} />} />
      ) : result.resource.status === 'failed' ? (
        <Failure result={result.resource.failure} retry={result.reload} />
      ) : !result.resource.data.length ? (
        <EmptyState title={<CopyText k={'noHistoryForTheSecondChart'} />} />
      ) : null}
      {failure && <p className="trade-refusal">{failure}</p>}
      <div className={`trade-secondary-chart ${workspace ? 'trade-secondary-chart--workspace' : ''}`} ref={host} />
    </section>
  );
}

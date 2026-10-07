import { useEffect, useRef, useState } from 'react';
import type { OHLCV } from '@intafaced/exchange-contract/schemas';
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { z } from 'zod';
import { decimalSchema, parseAmount, formatAmount } from '../../shared/money';
import { Button, EmptyState, Failure, Loading } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import type { Listing, TradeApi, Order } from './trade-api';
import { usePreferences } from '../../shared/preferences';
import { TIMEFRAMES } from './trade-api';

type Point = { time: number; value: number };
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Series = {
  update: (data: Point | Omit<Bar, 'volume'>) => void;
  setData: (data: (Point | Omit<Bar, 'volume'> | { time: number; value: number; color: string })[]) => void;
  createPriceLine: (options: Record<string, unknown>) => unknown;
  priceToCoordinate: (price: number) => number | null;
  coordinateToPrice: (coordinate: number) => number | null;
};
type ChartApi = {
  addSeries: (type: unknown, options?: Record<string, unknown>, pane?: number) => Series;
  remove: () => void;
  timeScale: () => {
    fitContent: () => void;
    scrollToRealTime: () => void;
    coordinateToTime: (coordinate: number) => number | null;
    timeToCoordinate: (time: number) => number | null;
  };
  subscribeClick: (fn: (event: { point?: { x: number; y: number }; time?: number }) => void) => void;
};
type Engine = {
  createChart: (host: HTMLElement, options: Record<string, unknown>) => ChartApi;
  CandlestickSeries: unknown;
  LineSeries: unknown;
  HistogramSeries: unknown;
};
declare global {
  interface Window {
    LightweightCharts?: Engine;
  }
}
type Drawing = { kind: 'level' | 'trend' | 'rectangle'; points: [number, number][] };
type Study = 'MA' | 'Volume' | 'VWAP' | 'RSI' | 'MACD' | 'Bollinger';
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
        throw new Error('History contains an invalid candle.');
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
  const closes = bars.map((bar) => bar.close),
    line = (values: (number | null)[], color: string, pane = 0) => {
      chart
        .addSeries(engine.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, pane)
        .setData(
          bars.flatMap((bar, index) =>
            values[index] === null || values[index] === undefined ? [] : [{ time: bar.time, value: values[index] as number }],
          ),
        );
    };
  if (studies.includes('MA')) line(average(closes, 20), '#e4bf72');
  if (studies.includes('Volume'))
    chart
      .addSeries(engine.HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false }, 1)
      .setData(bars.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? '#526a29' : '#78333b' })));
  if (studies.includes('VWAP')) {
    let volume = 0,
      value = 0;
    line(
      bars.map((bar) => {
        volume += bar.volume;
        value += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
        return volume ? value / volume : null;
      }),
      '#80b7e0',
    );
  }
  if (studies.includes('RSI')) {
    const gains = closes.map((value, index) => Math.max(0, value - (closes[index - 1] ?? value))),
      losses = closes.map((value, index) => Math.max(0, (closes[index - 1] ?? value) - value)),
      up = ema(gains, 14),
      down = ema(losses, 14);
    line(
      closes.map((_, i) => (i < 14 ? null : down[i] === 0 ? 100 : 100 - 100 / (1 + (up[i] ?? 0) / (down[i] ?? 1)))),
      '#e4bf72',
      2,
    );
  }
  if (studies.includes('MACD')) {
    const fast = ema(closes, 12),
      slow = ema(closes, 26),
      macd = fast.map((value, index) => value - (slow[index] ?? value));
    line(macd, '#80b7e0', 3);
    line(ema(macd, 9), '#e4bf72', 3);
  }
  if (studies.includes('Bollinger')) {
    const mid = average(closes, 20),
      deviation = mid.map((mean, index) =>
        mean === null ? null : Math.sqrt(closes.slice(index - 19, index + 1).reduce((sum, value) => sum + (value - mean) ** 2, 0) / 20),
      );
    line(mid, '#a3a3a3');
    line(
      mid.map((mean, index) => (mean === null ? null : mean + 2 * (deviation[index] ?? 0))),
      '#777777',
    );
    line(
      mid.map((mean, index) => (mean === null ? null : mean - 2 * (deviation[index] ?? 0))),
      '#777777',
    );
  }
}
export function MarketChart({
  api,
  market,
  orders,
  onStagePrice,
  accountKey,
}: {
  api: TradeApi;
  market: Listing;
  orders: Order[];
  onStagePrice: (price: string) => void;
  accountKey: string;
}) {
  const preferences = usePreferences();
  const [feedStatus, setFeedStatus] = useState('Historical prices'),
    [countdown, setCountdown] = useState<number | null>(null);
  const barHistory = useRef<OHLCV[]>([]),
    historyReady = useRef(false),
    lastPrintAt = useRef<number | null>(null);
  const [chartRevision, setChartRevision] = useState(0);
  const [interval, setIntervalValue] = useState('15m'),
    [type, setType] = useState('Candles'),
    [studies, setStudies] = useState<Study[]>(['Volume']),
    [drawings, setDrawings] = useState<Drawing[]>([]),
    [tool, setTool] = useState<Drawing['kind'] | null>(null),
    [compare, setCompare] = useState(''),
    [saved, setSaved] = useState<{ name: string; type: string; interval: string; studies: Study[] }[]>([]),
    [notice, setNotice] = useState(''),
    [fullscreen, setFullscreen] = useState(false),
    [multi, setMulti] = useState(false);
  const host = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLElement>(null),
    chartRef = useRef<ChartApi | null>(null),
    seriesRef = useRef<Series | null>(null),
    pending = useRef<[number, number][]>([]),
    rawPrice = useRef<Map<number, string>>(new Map());
  const fills = useResource(
    (signal) =>
      preferences.showFills
        ? api.fills(market.symbol, 100, signal)
        : Promise.resolve({ ok: true as const, data: [] as import('@intafaced/exchange-contract/schemas').Trade[] }),
    `${market.id}:fills:${preferences.showFills}`,
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
      sequence: z.number().int().nonnegative(),
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
        setFeedStatus('Waiting for an actual trade');
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
          setFeedStatus('Refreshing corrected history');
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
        setFeedStatus(`Accepted trade · ${print.kind}`);
      };
      socket.onerror = () => setFeedStatus('Trade stream interrupted');
      socket.onclose = () => {
        if (closed) return;
        setFeedStatus('Historical prices · reconnecting');
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    const clock = setInterval(() => {
      const end = (barHistory.current.at(-1)?.[0] ?? 0) + span;
      setCountdown(end > Date.now() ? Math.ceil((end - Date.now()) / 1000) : null);
      if (lastPrintAt.current !== null && Date.now() - lastPrintAt.current >= 15000)
        setFeedStatus('Historical prices · trade stream stale');
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
    setDrawings([]);
    setCompare('');
    pending.current = [];
  }, [market.id]);
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
      const css = getComputedStyle(document.documentElement),
        up = css.getPropertyValue('--color-positive').trim() || '#c8f64a',
        down = css.getPropertyValue('--color-negative').trim() || '#f05a68',
        background = css.getPropertyValue('--color-shell').trim() || '#111111',
        text = css.getPropertyValue('--color-muted').trim() || '#a3a3a3',
        divider = css.getPropertyValue('--color-divider').trim() || '#262626';
      try {
        const bars = chartBars(resource.data, type);
        rawPrice.current = new Map(resource.data.map((row) => [Math.floor(row[0] / 1000), row[4]]));
        chart = engine.createChart(host.current, {
          autoSize: true,
          layout: { background: { color: background }, textColor: text, fontFamily: 'Inter', fontSize: 11, attributionLogo: true },
          grid: { vertLines: { color: divider }, horzLines: { color: divider } },
          rightPriceScale: { borderColor: divider },
          timeScale: { borderColor: divider, timeVisible: true },
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
          upColor: up,
          downColor: down,
          wickUpColor: up,
          wickDownColor: down,
          borderVisible: false,
          color: up,
        });
        series.setData(type === 'Line' ? bars.map((bar) => ({ time: bar.time, value: bar.close })) : bars);
        addStudies(chart, engine, bars, studies);
        for (const order of preferences.showOrders ? orders : [])
          if (order.symbol === market.symbol && order.price !== null)
            series.createPriceLine({
              price: Number(order.price),
              color: '#e4bf72',
              lineWidth: 1,
              lineStyle: 2,
              title: `${order.side} · ${order.id.slice(0, 6)}`,
              axisLabelVisible: true,
            });
        if (preferences.showFills && fills.resource.status === 'ready')
          for (const fill of fills.resource.data)
            series.createPriceLine({
              price: Number(fill.price),
              color: fill.side === 'buy' ? up : down,
              lineStyle: 3,
              lineWidth: 1,
              title: `Fill ${fill.id.slice(0, 6)}`,
              axisLabelVisible: false,
            });
        if (comparison.resource.status === 'ready' && compare) {
          const other = chartBars(comparison.resource.data, 'Line');
          chart
            .addSeries(engine.LineSeries, { color: '#80b7e0', priceScaleId: 'comparison', priceLineVisible: false, title: compare })
            .setData(other.map((bar) => ({ time: bar.time, value: bar.close })));
        }
        chart.timeScale().fitContent();
        chartRef.current = chart;
        seriesRef.current = series;
        setChartRevision((value) => value + 1);
        setNotice('');
        chart.subscribeClick((event) => {
          if (event.time) {
            const exact = rawPrice.current.get(event.time);
            if (exact && !tool) onStagePrice(exact);
          }
          if (tool && event.point && event.time) {
            const price = series.coordinateToPrice(event.point.y);
            if (price === null) return;
            pending.current.push([event.time, price]);
            if (tool === 'level' || pending.current.length === 2) {
              setDrawings((current) => [...current, { kind: tool, points: pending.current }]);
              pending.current = [];
              setTool(null);
            }
          }
        });
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'The chart could not be drawn.');
      }
    });
    return () => {
      closed = true;
      chart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [
    resource,
    comparison.resource,
    type,
    studies,
    tool,
    market.symbol,
    orders,
    compare,
    preferences.upColor,
    preferences.theme,
    preferences.timeZone,
    preferences.showOrders,
    preferences.showFills,
    fills.resource,
  ]);
  function saveLayout() {
    const name = window.prompt('Name this chart layout');
    if (!name?.trim()) return;
    const next = [...saved.filter((row) => row.name !== name.trim()), { name: name.trim(), type, interval, studies }];
    setSaved(next);
    try {
      localStorage.setItem(`trade-layouts:${accountKey}`, JSON.stringify(next));
      setNotice('Layout saved on this device. Account synchronization is not connected.');
    } catch {
      setNotice('Browser storage is unavailable; this layout was not saved.');
    }
  }
  const draw = (drawing: Drawing, index: number) => {
    const positions = drawing.points.map(([time, price]) => [
      chartRef.current?.timeScale().timeToCoordinate(time),
      seriesRef.current?.priceToCoordinate(price),
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
    <section className={`trade-chart ${fullscreen ? 'trade-chart--fullscreen' : ''}`} ref={frame} aria-label={`${market.symbol} chart`}>
      <div className="trade-chart-toolbar">
        <label className="trade-inline">
          Interval
          <select aria-label="Chart interval" value={interval} onChange={(event) => setIntervalValue(event.target.value)}>
            {TIMEFRAMES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <select aria-label="Chart type" value={type} onChange={(event) => setType(event.target.value)}>
          {['Candles', 'Line', 'Heikin Ashi'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <details>
          <summary>Indicators</summary>
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
                {study}
              </label>
            ))}
            <small>MA 20 · RSI 14 · MACD 12/26/9 · Bollinger 20/2 · VWAP over visible history</small>
          </div>
        </details>
        <details>
          <summary>Draw</summary>
          <div className="trade-menu">
            {(['level', 'trend', 'rectangle'] as const).map((value) => (
              <button
                key={value}
                onClick={() => {
                  setTool(value);
                  pending.current = [];
                }}
              >
                {value}
              </button>
            ))}
            <button onClick={() => setDrawings([])}>Clear drawings</button>
            <small>Drawings remain in this workspace. Pan or zoom to reposition them. Account synchronization is not connected.</small>
          </div>
        </details>
        <details>
          <summary>Layouts</summary>
          <div className="trade-menu">
            <button onClick={saveLayout}>Save layout on device</button>
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
              Second linked chart
            </label>
          </div>
        </details>
        <Button
          variant="ghost"
          aria-label={fullscreen ? 'Exit full screen chart' : 'Full screen chart'}
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
        <button onClick={reload}>Refresh history</button>
        <button onClick={() => chartRef.current?.timeScale().fitContent()}>Fit</button>
        <button onClick={() => chartRef.current?.timeScale().scrollToRealTime()}>Follow</button>
      </div>
      <div className="trade-chart-canvas" role="img" aria-label={`Actual ${market.symbol} historical prices`}>
        <div className="trade-engine" ref={host} />
        {resource.status === 'loading' ? (
          <Loading label="Loading market history" />
        ) : resource.status === 'failed' ? (
          <Failure result={resource.failure} retry={reload} />
        ) : !resource.data.length ? (
          <EmptyState title="No price history">The market has no published candles for this interval.</EmptyState>
        ) : null}
        <svg className="trade-drawings" aria-hidden="true" data-revision={chartRevision}>
          {drawings.map(draw)}
        </svg>
      </div>
      <div className="trade-chart-footer">
        <span>
          {tool
            ? `Select ${tool === 'level' ? 'one point' : 'two points'} to draw ${tool}`
            : `${feedStatus}${countdown === null ? '' : ` · Candle ${countdown}s`} · Select a candle to stage its exact close price`}
        </span>
        <label className="trade-inline">
          Compare
          <input
            aria-label="Compare market symbol"
            value={compare}
            placeholder="BASE/QUOTE"
            onChange={(event) => setCompare(event.target.value.toUpperCase())}
          />
        </label>
      </div>
      {notice && (
        <p className="trade-note" role="status">
          {notice}
        </p>
      )}
      {multi && <SecondaryChart api={api} symbol={market.symbol} interval={interval} />}
    </section>
  );
}
function SecondaryChart({ api, symbol, interval }: { api: TradeApi; symbol: string; interval: string }) {
  const host = useRef<HTMLDivElement>(null);
  const result = useResource((signal) => api.history(symbol, interval, signal), `${symbol}:${interval}`);
  useEffect(() => {
    if (!host.current || result.resource.status !== 'ready' || !window.LightweightCharts) return;
    const engine = window.LightweightCharts,
      chart = engine.createChart(host.current, { autoSize: true, layout: { background: { color: '#111' }, textColor: '#a3a3a3' } });
    chart
      .addSeries(engine.LineSeries, { color: '#c8f64a' })
      .setData(chartBars(result.resource.data, 'Line').map((row) => ({ time: row.time, value: row.close })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [result.resource]);
  return <div className="trade-secondary-chart" ref={host} aria-label={`Second linked ${symbol} chart`} />;
}

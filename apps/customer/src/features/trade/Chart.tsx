import {
  tradeError,
  TradeOriginalMessage,
  tradeCopy as copy,
  CopyText,
  choiceText,
  choiceNode,
  choiceLanguage,
  tradeDate,
  TradeFailure as Failure,
} from './copy';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { OHLCV, Position } from '@intafaced/exchange-contract/schemas';
import { TIMEFRAME_MS } from '@intafaced/exchange-contract/schemas';
import { z } from 'zod';
import { decimalSchema, parseAmount, formatAmount } from '../../shared/money';
import { Button, EmptyState, Loading } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import type { Listing, TradeApi, Order } from './trade-api';
import {
  usePreferences,
  useResolvedTheme,
  savePreferences,
  useDailyPreferenceEpoch,
  currentDailyPreferenceEpoch,
  type Preferences,
} from '../../shared/preferences';
import { authoredRefusal, type ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { useSession } from '../session/session';
import type { DailyMetadata, DailyPlan } from './zoned-daily-history';
import { TIMEFRAMES } from './trade-api';
import { PriceAlerts } from './PriceAlerts';
import { utc8DailyStart } from './daily-history';
import { currentSharedCardRoute, subscribeSharedCardRoute } from '../more/blueprint-shared-card-contract';

type HistorySnapshot = { rows: readonly OHLCV[]; metadata?: DailyMetadata; plan?: DailyPlan };
async function readHistory(
  api: TradeApi,
  symbol: string,
  interval: string,
  preferences: Preferences,
  signal: AbortSignal,
): Promise<ApiResult<HistorySnapshot>> {
  if (interval === '1d' && preferences.dailyStart === 'zoned') return api.zonedDailyHistory(symbol, preferences.dailyZone, signal);
  const result = await (interval === '1d' && preferences.dailyStart === 'utc8'
    ? api.dailyHistory(symbol, signal)
    : api.history(symbol, interval, signal));
  return result.ok ? { ok: true, data: { rows: result.data } } : result;
}
const readerIdentities = new WeakMap<object, number>();
let readerIdentity = 0;
function identity(value: object | null) {
  if (!value) return 0;
  let id = readerIdentities.get(value);
  if (id === undefined) {
    id = ++readerIdentity;
    readerIdentities.set(value, id);
  }
  return id;
}
/** Feature-owned admission includes API, actor, mount, refresh and the
 * synchronously observed daily epoch. Retained handlers use the same gate. */
function useChartHistory(
  api: TradeApi,
  symbol: string,
  interval: string,
  preferences: Preferences,
  owner = '',
  refresh = 0,
  empty = false,
  admit?: () => boolean,
) {
  const { session } = useSession();
  const epoch = useDailyPreferenceEpoch();
  const route = useSyncExternalStore(subscribeSharedCardRoute, currentSharedCardRoute);
  const [revision, setRevision] = useState(0);
  const key = `${identity(api)}:${identity(session)}:${owner}:${symbol}:${interval}:${preferences.dailyStart}:${preferences.dailyZone}:${epoch}:${route.epoch}:${refresh}:${revision}:${empty}`;
  const observed = useRef<{ key: string } | null>(null);
  if (observed.current?.key !== key) observed.current = { key };
  const captured = observed.current;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    observed.current === captured &&
    currentDailyPreferenceEpoch() === epoch &&
    currentSharedCardRoute() === route &&
    (admit?.() ?? true);
  const [state, setState] = useState<{ key: string; resource: Resource<HistorySnapshot> }>({ key, resource: { status: 'loading' } });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, resource: { status: 'loading' } });
    if (current())
      void (
        empty
          ? Promise.resolve({ ok: true as const, data: { rows: [] as OHLCV[] } })
          : readHistory(api, symbol, interval, preferences, controller.signal)
      )
        .then((result) => {
          if (!controller.signal.aborted && current())
            setState({ key, resource: result.ok ? { status: 'ready', data: result.data } : { status: 'failed', failure: result } });
        })
        .catch(() => {
          if (!controller.signal.aborted && current())
            setState({ key, resource: { status: 'failed', failure: authoredRefusal('error', { key: 'loadFailed' }) } });
        });
    return () => controller.abort();
  }, [key]);
  return {
    resource: state.key === key && current() ? state.resource : { status: 'loading' as const },
    current,
    reload: () => {
      if (current()) {
        observed.current = null;
        setRevision((value) => value + 1);
      }
    },
    key,
  };
}
function ZonedSource({ metadata }: { metadata: DailyMetadata }) {
  return (
    <div className="trade-note" data-zoned-source="">
      <strong>
        <CopyText k="dailyZoneSnapshot" params={{ zone: metadata.zone }} />
      </strong>
      <br />
      <CopyText
        k="dailyZoneWindow"
        params={{
          source: metadata.sourceInterval,
          days: metadata.priorDates,
          since: tradeDate(metadata.sinceMs),
          read: tradeDate(metadata.readAtMs),
        }}
      />
      <br />
      <CopyText k="dailyZoneLimits" />
    </div>
  );
}

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
  panes: () => { setStretchFactor: (factor: number) => void }[];
  paneSize: (index?: number) => { width: number; height: number };
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
function chartBars(rows: readonly OHLCV[], type: string): Bar[] {
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
        throw tradeError('historyContainsAnInvalidCandle');
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
  let nextPane = 1;
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
    const series = chart.addSeries(engine.HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false }, nextPane++);
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
      nextPane++,
    );
  const macd = (rows: Bar[]) => {
    const values = rows.map((row) => row.close),
      fast = ema(values, 12),
      slow = ema(values, 26);
    return fast.map((value, index) => value - (slow[index] ?? value));
  };
  if (studies.includes('MACD')) {
    const pane = nextPane++;
    line(macd, '#80b7e0', pane);
    line((rows) => ema(macd(rows), 9), '#e4bf72', pane);
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
  stageDestination = 'ticket',
  accountKey,
  onStageAmend,
  onInspectOrders,
  positions,
  initialView,
  onViewChange,
}: {
  api: TradeApi;
  market: Listing;
  orders: Order[];
  onStagePrice: (price: string, current?: () => boolean) => void;
  stageDestination?: 'ticket' | 'trade';
  accountKey: string;
  onStageAmend?: (order: Order, price: string) => void;
  onInspectOrders?: () => void;
  positions?: Position[];
  initialView?: ChartView;
  onViewChange?: (view: ChartView) => void;
}) {
  const preferences = usePreferences();
  const theme = useResolvedTheme(preferences.theme);
  const [feed, setFeedStatus] = useState<
      | { key: 'acceptedTrade'; printKind: string }
      | {
          key:
            | 'chartHistoricalPrices'
            | 'waitingForAnActualTrade'
            | 'refreshingCorrectedHistory'
            | 'tradeStreamInterrupted'
            | 'historicalPricesReconnecting'
            | 'historicalPricesTradeStreamStale';
        }
    >({ key: 'chartHistoricalPrices' }),
    [countdown, setCountdown] = useState<number | null>(null);
  const barHistory = useRef<OHLCV[]>([]),
    historyReady = useRef(false),
    lastPrintAt = useRef<number | null>(null);
  const viewport = useRef<{ from: number; to: number } | null>(null),
    studyUpdate = useRef<((bars: Bar[]) => void) | null>(null),
    orderLines = useRef<unknown[]>([]),
    fillLines = useRef<unknown[]>([]);
  const positionLines = useRef<unknown[]>([]);
  const feedStatus = feed.key === 'acceptedTrade' ? copy.t(feed.key, { printKind: feed.printKind }) : copy.t(feed.key);
  const [chartRevision, setChartRevision] = useState(0);
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 980px)');
    const update = () => setPhone(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  const currentOrders = useRef(orders);
  currentOrders.current = orders;
  const [focusedOrder, setFocusedOrder] = useState<string | null>(null);
  const [interval, setIntervalValue] = useState(initialView?.interval ?? '15m'),
    [type, setType] = useState(initialView?.type ?? 'Candles'),
    [studies, setStudies] = useState<Study[]>(initialView?.studies ?? ['Volume']),
    [drawings, setDrawings] = useState<Drawing[]>([]),
    [compare, setCompare] = useState(''),
    [saved, setSaved] = useState<{ name: string; type: string; interval: string; studies: Study[] }[]>([]),
    [notice, setNotice] = useState<ReactNode>(''),
    [fullscreen, setFullscreen] = useState(false),
    [multi, setMulti] = useState(false),
    [countdownVisible, setCountdownVisible] = useState(true),
    [drawingsKey, setDrawingsKey] = useState<string | null>(null);
  // A single immutable snapshot binds the immediate guard and rendered action.
  // Same-candle/Escape gestures publish too; React cannot bail on a reused row.
  const [inspection, writeInspection] = useState<{ row: OHLCV | null; tool: Drawing['kind'] | null }>({ row: null, tool: null });
  const { row: inspected, tool } = inspection;
  const currentInspection = useRef(inspection);
  function setInspected(value: OHLCV | null) {
    const next = { ...currentInspection.current, row: value };
    currentInspection.current = next;
    writeInspection(next);
  }
  function setTool(value: Drawing['kind'] | null) {
    const next = { ...currentInspection.current, tool: value };
    currentInspection.current = next;
    writeInspection(next);
  }
  const derivedDaily = interval === '1d' && preferences.dailyStart !== 'nativeUTC';
  const zonedDaily = interval === '1d' && preferences.dailyStart === 'zoned';
  const [linkedRevision, setLinkedRevision] = useState(0);
  const linkedRefresh = useRef<object>({});
  const linkedRefreshToken = linkedRefresh.current;
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
  useEffect(() => {
    const pane = frame.current;
    if (!fullscreen || !pane) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = new Map<HTMLElement, boolean>();
    let branch = pane;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      branch = parent;
      if (parent === document.body) break;
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFullscreen(false);
        setTool(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        pane!.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[inert]'),
      );
      const first = controls[0],
        last = controls.at(-1),
        active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        pane!.focus();
      } else if (event.shiftKey && (active === first || active === pane)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || active === pane)) {
        event.preventDefault();
        first.focus();
      }
    }
    pane.addEventListener('keydown', keyboard);
    (pane.querySelector<HTMLElement>('.trade-chart-canvas[tabindex]') ?? pane).focus();
    return () => {
      pane.removeEventListener('keydown', keyboard);
      for (const [element, wasInert] of background) element.inert = wasInert;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [fullscreen]);
  const fills = useResource(
    (signal) =>
      preferences.showFills
        ? api.fills(market.symbol, 100, signal)
        : Promise.resolve({ ok: true as const, data: [] as import('@intafaced/exchange-contract/schemas').Trade[] }),
    `${accountKey}:${market.id}:fills:${preferences.showFills}`,
  );
  const history = useChartHistory(api, market.symbol, interval, preferences, `${accountKey}:${market.id}`, linkedRevision);
  const { resource, reload } = history;
  const historyKey = history.key;
  const selectionCurrent = () =>
    history.current() && currentInspection.current === inspection && inspected !== null && barHistory.current.includes(inspected);
  historyReady.current = resource.status === 'ready';
  useEffect(() => {
    if (resource.status === 'ready') barHistory.current = resource.data.rows.slice().sort((a, b) => a[0] - b[0]);
    else {
      barHistory.current = [];
      rawPrice.current.clear();
    }
    pending.current = [];
    inspectionIndex.current = null;
    setInspected(null);
    setDragging(null);
    setFocusedOrder(null);
  }, [resource]);
  useEffect(() => {
    lastPrintAt.current = null;
    setCountdown(null);
    if (derivedDaily) {
      const nextBoundary = zonedDaily && resource.status === 'ready' ? resource.data.metadata?.nextBoundaryMs : undefined;
      const update = () => {
        if (!history.current()) return;
        const now = Date.now();
        setCountdown(
          zonedDaily
            ? nextBoundary === undefined
              ? null
              : Math.max(0, Math.ceil((nextBoundary - now) / 1000))
            : Math.ceil((utc8DailyStart(now) + TIMEFRAME_MS['1d'] - now) / 1000),
        );
      };
      update();
      const clock = setInterval(update, 1000);
      return () => clearInterval(clock);
    }
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
      if (closed || !history.current()) return;
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/stream?market=${encodeURIComponent(market.id)}&channel=trades`,
      );
      socket.onopen = () => {
        if (!history.current()) return;
        if (connections++ > 0) reload();
        setFeedStatus({ key: 'waitingForAnActualTrade' });
      };
      socket.onmessage = (event) => {
        if (closed || !history.current()) return;
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
          setFeedStatus({ key: 'refreshingCorrectedHistory' });
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
        setFeedStatus({ key: 'acceptedTrade', printKind: String(print.kind) });
      };
      socket.onerror = () => {
        if (history.current()) setFeedStatus({ key: 'tradeStreamInterrupted' });
      };
      socket.onclose = () => {
        if (closed || !history.current()) return;
        setFeedStatus({ key: 'historicalPricesReconnecting' });
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    const clock = setInterval(() => {
      if (!history.current()) return;
      const end = (barHistory.current.at(-1)?.[0] ?? 0) + span;
      setCountdown(end > Date.now() ? Math.ceil((end - Date.now()) / 1000) : null);
      if (lastPrintAt.current !== null && Date.now() - lastPrintAt.current >= 15000)
        setFeedStatus({ key: 'historicalPricesTradeStreamStale' });
    }, 1000);
    return () => {
      closed = true;
      socket?.close();
      clearInterval(clock);
      clearTimeout(retry);
    };
  }, [market.id, interval, type, derivedDaily, historyKey, zonedDaily, zonedDaily ? resource : null]);
  const comparison = useChartHistory(api, compare, interval, preferences, `${accountKey}:${market.id}:compare`, linkedRevision, !compare);
  function refreshHistory() {
    if (!history.current()) return;
    // Invalidate held linked reads and imports in this event turn, before
    // React renders the secondary's next refreshRevision.
    linkedRefresh.current = {};
    reload();
    comparison.reload();
    setLinkedRevision((revision) => revision + 1);
  }
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
      setNotice(<CopyText k={'drawingsRemainInThisWorkspaceBecauseDeviceStorageIsUnavailable'} />);
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
    if (!host.current || resource.status !== 'ready' || !resource.data.rows.length || !history.current()) return;
    let closed = false;
    let chart: ChartApi | null = null;
    void import('./vendor/lightweight-charts.standalone.production.js').then(() => {
      if (closed || !history.current() || !comparison.current() || !host.current || !window.LightweightCharts) return;
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
        if (phone) chart.panes().forEach((pane, index) => pane.setStretchFactor(index === 0 ? 4 : 1));
        orderLines.current = [];
        fillLines.current = [];
        positionLines.current = [];
        if (comparison.resource.status === 'ready' && compare) {
          const other = chartBars(comparison.resource.data.rows, 'Line');
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
          if (closed || !history.current() || !comparison.current()) return;
          if (event.time) {
            const exact = rawPrice.current.get(event.time);
            setInspected(barHistory.current.find((row) => Math.floor(row[0] / 1000) === event.time) ?? null);
            if (exact && !tool && stageDestination === 'ticket') onStagePrice(exact);
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
        setNotice(error instanceof Error ? <TradeOriginalMessage source={error} /> : <CopyText k={'theChartCouldNotBeDrawn'} />);
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
  }, [
    resource,
    comparison.resource,
    type,
    studies,
    tool,
    market.symbol,
    compare,
    preferences.timeZone,
    preferences.language,
    historyKey,
    comparison.key,
    phone,
    onStagePrice,
    stageDestination,
  ]);
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
    const shownPrices = new Set<bigint>();
    if (preferences.showOrders)
      for (const order of orders)
        if (order.symbol === market.symbol && order.price !== null) {
          const exactPrice = parseAmount(order.price);
          if (phone && shownPrices.has(exactPrice)) continue;
          shownPrices.add(exactPrice);
          orderLines.current.push(
            series.createPriceLine({
              price: Number(order.price),
              color: '#e4bf72',
              lineWidth: 1,
              lineStyle: 2,
              title: phone ? '' : `${order.side} · ${order.id.slice(0, 6)}`,
              axisLabelVisible: !phone,
            }),
          );
        }
  }, [orders, market.symbol, preferences.showOrders, chartRevision, phone]);
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
      setNotice(<CopyText k={'layoutSavedOnThisDeviceAccountSynchronizationIsNotConnected'} />);
    } catch {
      setNotice(<CopyText k={'browserStorageIsUnavailableThisLayoutWasNotSaved'} />);
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
  const lowerPanes = studies.filter((study) => ['Volume', 'RSI', 'MACD'].includes(study)).length;
  const pricePane = chartRef.current?.paneSize(0);
  const chartOrders = orders.filter((order) => order.symbol === market.symbol && order.price !== null);
  const eligible = (order: Order) =>
    order.type === 'limit' && order.status === 'open' && !order.recoveryRequired && parseAmount(order.filled) === 0n;
  const orderCurrent = (order: Order) => history.current() && currentOrders.current.includes(order);
  type Target = { order: Order; index: number; x: number; y: number; group?: number };
  const targets: Target[] = [];
  if (resource.status === 'ready' && preferences.showOrders && !market.paper && pricePane) {
    const capacity = Math.max(0, Math.floor((pricePane.width - 16) / 48));
    const groups = new Map<bigint, { rows: Order[]; eligible: number }>();
    for (const order of chartOrders) {
      const price = parseAmount(order.price!);
      const group = groups.get(price) ?? { rows: [], eligible: 0 };
      group.rows.push(order);
      if (eligible(order)) group.eligible++;
      groups.set(price, group);
    }
    for (const order of chartOrders) {
      const index = orders.indexOf(order);
      const y = dragging?.id === order.id ? dragging.y : seriesRef.current?.priceToCoordinate(Number(order.price));
      if (y == null) continue;
      if (!phone) {
        if (eligible(order) && y >= 0) targets.push({ order, index, x: 8, y });
        continue;
      }
      // Price Y is never shifted to make a hit target fit. Crowded or edge
      // orders remain available through the original management table.
      if (y < 22 || y + 22 > pricePane.height) continue;
      const group = groups.get(parseAmount(order.price!))!;
      const grouped = group.eligible > capacity;
      if (grouped ? order !== group.rows[0] || !onInspectOrders : !eligible(order)) continue;
      for (let slot = 0; slot < capacity; slot++) {
        const x = 8 + slot * 48;
        if (targets.some((target) => Math.abs(target.y - y) < 44 && Math.abs(target.x - x) < 44)) continue;
        targets.push({ order, index, x, y, ...(grouped ? { group: group.rows.length } : {}) });
        break;
      }
    }
  }
  const orderDetail = chartOrders.find((order) => order.id === (dragging?.id ?? focusedOrder));
  return (
    <section
      data-testid="trade-chart"
      className={`trade-chart ${fullscreen ? 'trade-chart--fullscreen' : ''}`}
      data-derived-linked={derivedDaily && multi ? '' : undefined}
      ref={frame}
      aria-label={copy.t('chartc80af2', { marketSymbol: String(market.symbol) })}
      role={fullscreen ? 'dialog' : undefined}
      aria-modal={fullscreen ? true : undefined}
      tabIndex={fullscreen ? -1 : undefined}
    >
      <div data-testid="trade-chart-toolbar" className="trade-chart-toolbar">
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
        {interval === '1d' && (
          <label className="trade-inline">
            <CopyText k="dailyStart" />
            <select
              aria-label={copy.t('dailyStart')}
              value={preferences.dailyStart}
              onChange={(event) => {
                if (history.current()) savePreferences({ dailyStart: event.target.value as Preferences['dailyStart'] });
              }}
            >
              <option value="nativeUTC">{copy.t('dailyStartNative')}</option>
              <option value="utc8">{copy.t('dailyStartUtc8')}</option>
              <option value="zoned">{preferences.dailyZone}</option>
            </select>
          </label>
        )}
        {interval === '1d' && (
          <a className="trade-zone-link" href="/view">
            <CopyText k="dailyZoneChoose" />
          </a>
        )}
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
                <span lang="und">{layout.name}</span>
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
          <span lang="zxx">{interval}</span> · {choiceNode(type)} · <span lang="zxx">{preferences.timeZone}</span>
        </span>
        <button onClick={refreshHistory}>
          <CopyText k="refreshHistory" />
        </button>
        <button onClick={() => chartRef.current?.timeScale().fitContent()}>
          <CopyText k="fit" />
        </button>
        <button onClick={() => chartRef.current?.timeScale().scrollToRealTime()}>
          <CopyText k="follow" />
        </button>
      </div>
      {zonedDaily && resource.status === 'ready' && resource.data.metadata && <ZonedSource metadata={resource.data.metadata} />}
      {derivedDaily && !zonedDaily && (
        <div className="trade-note">
          <strong>
            <CopyText k="dailyHistorySource" />
          </strong>
          <br />
          <CopyText k="dailyHistoryScope" /> <CopyText k="dailyHistoryOrdering" />
        </div>
      )}
      {inspected && resource.status === 'ready' && (
        <p data-testid="trade-candle-inspection" className="trade-candle-inspection">
          {derivedDaily && (
            <>
              <CopyText k="dailyHistoryInspection" params={{ start: tradeDate(inspected[0]) }} />
              <br />
            </>
          )}
          <CopyText k="o" />
          {inspected[1]} <CopyText k="h" />
          {inspected[2]} <CopyText k="l" />
          {inspected[3]} <CopyText k="c" />
          {inspected[4]} {market.quote} <CopyText k="v" />
          {inspected[5]} {market.base}
        </p>
      )}
      <div
        data-testid="trade-chart-canvas"
        className="trade-chart-canvas"
        style={{ '--trade-phone-chart-height': `${Math.max(420, 288 + lowerPanes * 66)}px` } as CSSProperties}
        role="group"
        tabIndex={0}
        aria-label={copy.t('actualHistoricalPrices', { marketSymbol: String(market.symbol) })}
        aria-description={copy.t(
          stageDestination === 'trade' ? 'holdingChartKeyboard' : 'useLeftAndRightArrowsToInspectCandlesEnterStagesThe',
        )}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setFullscreen(false);
            setTool(null);
            return;
          }
          if (event.target !== event.currentTarget) return;
          if (resource.status !== 'ready' || !history.current()) return;
          const rows = barHistory.current;
          if (!rows.length) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            inspectionIndex.current = Math.max(0, Math.min(rows.length - 1, (inspectionIndex.current ?? rows.length) + direction));
            setInspected(rows[inspectionIndex.current] ?? null);
          } else if (event.key === 'Enter' && inspected && selectionCurrent()) {
            event.preventDefault();
            if (tool) {
              pending.current.push([Math.floor(inspected[0] / 1000), inspected[4]]);
              if (tool === 'level' || pending.current.length === 2) {
                const points = pending.current;
                pending.current = [];
                setDrawings((current) => [...current, { kind: tool, points }]);
                setTool(null);
              }
            } else if (stageDestination === 'trade') onStagePrice(inspected[4], selectionCurrent);
            else onStagePrice(inspected[4]);
          }
        }}
      >
        <div
          data-testid="trade-engine"
          className="trade-engine"
          ref={host}
          style={{ visibility: resource.status === 'ready' ? undefined : 'hidden' }}
        />
        {resource.status === 'loading' ? (
          <Loading label={<CopyText k={'loadingMarketHistory'} />} />
        ) : resource.status === 'failed' ? (
          <>
            <Failure result={resource.failure} retry={refreshHistory} />
            {zonedDaily && (
              <button
                className="trade-daily-refresh"
                onClick={() => {
                  if (history.current()) savePreferences({ dailyStart: 'nativeUTC' });
                }}
              >
                <CopyText k="dailyZoneFallback" />
              </button>
            )}
          </>
        ) : !barHistory.current.length ? (
          <EmptyState title={<CopyText k={'noPriceHistory'} />}>
            <CopyText
              k={zonedDaily ? 'dailyZoneEmpty' : derivedDaily ? 'dailyHistoryEmpty' : 'theMarketHasNoPublishedCandlesForThisInterval'}
            />
          </EmptyState>
        ) : null}
        <svg className="trade-drawings" aria-hidden="true" data-revision={chartRevision}>
          {resource.status === 'ready' && drawings.map(draw)}
        </svg>
        {onStageAmend &&
          targets.map(({ order, index, x, y, group }) => (
            <button
              className={`trade-order-handle ${phone ? 'trade-order-handle--compact' : ''}`}
              key={order.id}
              style={{ top: y, left: x }}
              aria-label={
                group
                  ? `${copy.t('openOrders')} · ${group} · ${order.price} ${market.quote}`
                  : copy.t('changePriceForOrder', { orderId: String(order.id) })
              }
              onFocus={() => {
                if (orderCurrent(order)) setFocusedOrder(order.id);
              }}
              onBlur={() => setFocusedOrder(null)}
              onClick={(event) => {
                if (!orderCurrent(order)) return;
                if (group) onInspectOrders?.();
                else if (event.detail === 0 && order.price) onStageAmend(order, order.price);
              }}
              onPointerDown={(event) => {
                if (group || !orderCurrent(order)) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging({ id: order.id, price: order.price!, y });
              }}
              onPointerMove={(event) => {
                if (!orderCurrent(order) || dragging?.id !== order.id || !host.current) return;
                const rawY = event.clientY - host.current.getBoundingClientRect().top;
                const nextY = phone ? Math.max(22, Math.min((pricePane?.height ?? 44) - 22, rawY)) : rawY;
                const price = priceAtGeometry(nextY);
                if (price) setDragging({ id: order.id, price, y: nextY });
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                if (orderCurrent(order) && dragging?.id === order.id) onStageAmend(order, dragging.price);
                setDragging(null);
              }}
              onPointerCancel={() => setDragging(null)}
            >
              {phone
                ? (group ?? `${order.side === 'buy' ? 'B' : 'S'}${index + 1}`)
                : `↕ ${order.side} · ${dragging?.id === order.id ? dragging.price : order.price}`}
            </button>
          ))}
      </div>
      {stageDestination === 'trade' && inspected && !tool && resource.status === 'ready' && selectionCurrent() && (
        <div className="trade-holding-close">
          <span className="muted">
            <CopyText k="holdingSelectedClose" params={{ base: market.base, quote: market.quote }} />
          </span>
          <strong className="numeric">{inspected[4]}</strong>
          <Button
            onClick={() => {
              if (selectionCurrent()) onStagePrice(inspected[4], selectionCurrent);
            }}
          >
            <CopyText k="holdingUseClose" />
          </Button>
          <span className="muted">
            <CopyText k="holdingDraftOnly" params={{ symbol: market.symbol }} />
          </span>
        </div>
      )}
      {phone && preferences.showOrders && chartOrders.length > 0 && onInspectOrders && (
        <div className="trade-order-inspection">
          <button
            onClick={() => {
              if (history.current()) onInspectOrders();
            }}
          >
            <CopyText k="openOrders" /> · {chartOrders.length} ↘
          </button>
          {orderDetail && (
            <span>
              {orderDetail.id} · {orderDetail.side} · {dragging?.id === orderDetail.id ? dragging.price : orderDetail.price} {market.quote}
            </span>
          )}
        </div>
      )}
      <div className="trade-chart-footer">
        <span>
          {tool ? (
            <CopyText
              k={'selectToDraw'}
              params={{ toolLevelOnePoint: copy.t(tool === 'level' ? 'oneDrawingPoint' : 'twoDrawingPoints'), tool: choiceText(tool) }}
            />
          ) : derivedDaily ? (
            countdownVisible && countdown !== null && resource.status === 'ready' ? (
              countdown === 0 && zonedDaily ? (
                <CopyText k="dailyZoneRefreshDue" />
              ) : (
                <CopyText k="dailyHistoryCountdown" params={{ seconds: countdown }} />
              )
            ) : (
              <CopyText k={zonedDaily ? 'dailyZoneSelected' : 'dailyHistorySource'} params={{ zone: preferences.dailyZone }} />
            )
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
        <p className="trade-note" role="status" lang="und">
          {notice}
        </p>
      )}
      {compare && comparison.resource.status === 'failed' && <Failure result={comparison.resource.failure} retry={comparison.reload} />}
      {compare && derivedDaily && comparison.resource.status === 'loading' && (
        <Loading label={<CopyText k="dailyHistoryComparisonLoading" />} />
      )}
      {compare && zonedDaily && comparison.resource.status === 'ready' && comparison.resource.data.metadata && (
        <ZonedSource metadata={comparison.resource.data.metadata} />
      )}
      {compare && comparison.resource.status === 'ready' && !comparison.resource.data.rows.length && (
        <p className="trade-note">
          <CopyText k="noPublishedComparisonHistoryFor" />
          {compare}.
        </p>
      )}
      {multi && (
        <SecondaryChart
          api={api}
          symbol={market.symbol}
          interval={interval}
          refreshRevision={linkedRevision}
          admitRefresh={() => linkedRefresh.current === linkedRefreshToken}
        />
      )}
    </section>
  );
}
export function SecondaryChart({
  api,
  symbol,
  interval,
  type = 'Line',
  workspace = false,
  refreshRevision = 0,
  admitRefresh,
}: {
  api: TradeApi;
  symbol: string;
  interval: string;
  type?: string;
  workspace?: boolean;
  refreshRevision?: number;
  admitRefresh?: () => boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    chartRef = useRef<ChartApi | null>(null),
    seriesRef = useRef<Series | null>(null);
  const [failure, setFailure] = useState<ReactNode>('');
  const preferences = usePreferences();
  const theme = useResolvedTheme(preferences.theme);
  const derivedDaily = interval === '1d' && preferences.dailyStart !== 'nativeUTC';
  const zonedDaily = interval === '1d' && preferences.dailyStart === 'zoned';
  const result = useChartHistory(api, symbol, interval, preferences, 'secondary', refreshRevision, false, admitRefresh);
  useEffect(() => {
    if (!host.current || result.resource.status !== 'ready' || !result.resource.data.rows.length || !result.current()) return;
    const rows = result.resource.data.rows;
    let closed = false,
      chart: ChartApi | null = null;
    void import('./vendor/lightweight-charts.standalone.production.js').then(() => {
      if (closed || !result.current() || !host.current || !window.LightweightCharts) return;
      try {
        const engine = window.LightweightCharts,
          appearance = chartAppearance();
        chart = engine.createChart(host.current, {
          autoSize: true,
          ...appearance.chart,
          timeScale: { ...appearance.chart.timeScale, timeVisible: true },
          localization: {
            timeFormatter: (timestamp: number) =>
              new Intl.DateTimeFormat(preferences.language, {
                dateStyle: 'short',
                timeStyle: 'short',
                ...(preferences.timeZone === 'device' ? {} : { timeZone: preferences.timeZone === 'UTC+8' ? 'Asia/Singapore' : 'UTC' }),
              }).format(new Date(timestamp * 1000)),
          },
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
        setFailure(error instanceof Error ? <TradeOriginalMessage source={error} /> : <CopyText k="secondaryChartFailure" />);
      }
    });
    return () => {
      closed = true;
      chart?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [result.resource, type, preferences.timeZone, preferences.language, result.key]);
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
        {symbol} · {interval} {zonedDaily ? preferences.dailyZone : <CopyText k={derivedDaily ? 'dailyStartUtc8' : 'publishedHistory'} />}
      </small>
      {zonedDaily && result.resource.status === 'ready' && result.resource.data.metadata && (
        <ZonedSource metadata={result.resource.data.metadata} />
      )}
      {derivedDaily && !zonedDaily && (
        <div className="trade-note">
          <strong>
            <CopyText k="dailyHistorySource" />
          </strong>
          <br />
          <CopyText k="dailyHistoryScope" /> <CopyText k="dailyHistoryOrdering" />
          <button className="trade-daily-refresh" onClick={result.reload}>
            <CopyText k="dailyHistoryRefresh" />
          </button>
        </div>
      )}
      {zonedDaily && (
        <button className="trade-daily-refresh" onClick={result.reload}>
          <CopyText k="dailyHistoryRefresh" />
        </button>
      )}
      {result.resource.status === 'loading' ? (
        <Loading label={<CopyText k={'loadingSecondChartHistory'} />} />
      ) : result.resource.status === 'failed' ? (
        <>
          <Failure result={result.resource.failure} retry={result.reload} />
          {zonedDaily && (
            <button
              className="trade-daily-refresh"
              onClick={() => {
                if (result.current()) savePreferences({ dailyStart: 'nativeUTC' });
              }}
            >
              <CopyText k="dailyZoneFallback" />
            </button>
          )}
        </>
      ) : !result.resource.data.rows.length ? (
        <EmptyState title={<CopyText k={'noHistoryForTheSecondChart'} />} />
      ) : null}
      {failure && result.resource.status === 'ready' && (
        <p className="trade-refusal" lang="und">
          {failure}
        </p>
      )}
      <div
        className={`trade-secondary-chart ${workspace ? 'trade-secondary-chart--workspace' : ''}`}
        ref={host}
        style={{ visibility: result.resource.status === 'ready' ? undefined : 'hidden' }}
      />
    </section>
  );
}

/**
 * Live candles for the chart workbench. The chart reads the polled history (`useChartCandles`) and, where the
 * service offers it, the candle channel of the multiplexed stream (`/ws/stream`, channel `candles`) keeps the
 * open bar current. When the socket is closed, refused or the interval is not one the stream serves, the poll
 * alone draws the chart and the page says so. A frame is state, not an event: the newest frame for a bar replaces
 * the one before it, so a dropped frame is repaired by the next. Prices stay decimal strings.
 */
import { useEffect, useRef, useState } from 'react';
import type { Candle } from '../../data/types';
import type { ChartInterval } from '../trade/chart/candles';

/** The intervals the stream serves (services/svc-ws/src/mux/protocol.ts MUX_INTERVALS). Every other interval is polled. */
export const STREAM_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export const isStreamInterval = (interval: ChartInterval): boolean => (STREAM_INTERVALS as readonly string[]).includes(interval);

export type StreamMode = 'stream' | 'poll';
export const RECONNECT_MS = 5_000;

export interface CandleFrame {
  marketId: string;
  interval: string;
  candle: Candle;
  closed: boolean;
}
export type Incoming =
  | { kind: 'candle'; frame: CandleFrame }
  | { kind: 'ack'; ok: boolean; marketId: string | null }
  | { kind: 'unavailable' }
  | { kind: 'other' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const DECIMAL = /^-?\d+(\.\d+)?$/;
const isDecimal = (value: unknown): value is string => typeof value === 'string' && DECIMAL.test(value);

/** One text frame from the door. Anything malformed is `other` and changes nothing. */
export function parseIncoming(text: string): Incoming {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'other' };
  }
  if (!isRecord(body)) return { kind: 'other' };
  // The door wraps every channel frame: `{ ch: 'candles', market, interval, data: <frame> }`. Only the acknowledgement
  // and the errors are top level.
  const inner = body.ch === 'candles' && isRecord(body.data) ? body.data : null;
  if (inner?.type === 'candle') {
    const { marketId, interval, t, o, h, l, c, v, closed } = inner;
    if (
      typeof marketId !== 'string' ||
      typeof interval !== 'string' ||
      typeof t !== 'number' ||
      !Number.isFinite(t) ||
      !isDecimal(o) ||
      !isDecimal(h) ||
      !isDecimal(l) ||
      !isDecimal(c) ||
      !isDecimal(v)
    )
      return { kind: 'other' };
    return { kind: 'candle', frame: { marketId, interval, closed: closed === true, candle: { t, o, h, l, c, v, filled: false } } };
  }
  if (inner?.type === 'status' && inner.code === 'candles.unavailable') return { kind: 'unavailable' };
  if (body.op === 'ack' && body.for === 'subscribe' && Array.isArray(body.results)) {
    const first = body.results[0];
    if (!isRecord(first)) return { kind: 'ack', ok: false, marketId: null };
    return { kind: 'ack', ok: first.ok === true, marketId: typeof first.market === 'string' ? first.market : null };
  }
  if (body.op === 'error') return { kind: 'ack', ok: false, marketId: null };
  return { kind: 'other' };
}

/**
 * The polled bars with the live bar laid over them: the same bucket is replaced, a newer one is appended, an older
 * one (already in the history) is ignored. No bar is invented between them.
 */
export function mergeLive(polled: readonly Candle[], live: Candle | null): readonly Candle[] {
  if (live === null || polled.length === 0) return polled;
  const last = polled[polled.length - 1]!;
  if (live.t < last.t) return polled;
  if (live.t === last.t) return [...polled.slice(0, -1), live];
  return [...polled, live];
}

export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type OpenSocket = (url: string) => SocketLike;
const defaultOpen: OpenSocket = (url) => new WebSocket(url) as unknown as SocketLike;
export const streamUrl = (): string => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/stream`;

export interface CandleStream {
  mode: StreamMode;
  /** The newest frame for the symbol and interval, or null before one arrived. */
  live: Candle | null;
}
interface Held extends CandleStream {
  symbol: string;
  interval: ChartInterval;
}

/** Keeps one socket for `symbol` and `interval`; the poll stays the fallback whenever the socket is not delivering. */
export function useCandleStream(symbol: string, interval: ChartInterval, open: OpenSocket = defaultOpen): CandleStream {
  const [held, setState] = useState<Held>({ mode: 'poll', live: null, symbol, interval });
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    setState({ mode: 'poll', live: null, symbol, interval });
    if (!isStreamInterval(interval) || typeof WebSocket === 'undefined') return;
    let closed = false;
    let socket: SocketLike | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let marketId: string | null = null;
    let refused = false;
    const connect = () => {
      if (closed) return;
      marketId = null;
      refused = false;
      try {
        socket = openRef.current(streamUrl());
      } catch {
        retry = setTimeout(connect, RECONNECT_MS);
        return;
      }
      const mine = socket;
      mine.onopen = () => {
        mine.send(JSON.stringify({ op: 'subscribe', id: 'candles', channels: [{ ch: 'candles', market: symbol, interval }] }));
      };
      mine.onmessage = (event) => {
        if (closed || socket !== mine) return;
        const incoming = parseIncoming(String(event.data));
        if (incoming.kind === 'ack') {
          if (incoming.ok) marketId = incoming.marketId;
          else {
            refused = true;
            setState((now) => ({ ...now, mode: 'poll' }));
          }
        } else if (incoming.kind === 'unavailable') setState((now) => ({ ...now, mode: 'poll' }));
        else if (incoming.kind === 'candle') {
          const { frame } = incoming;
          if (refused || frame.interval !== interval || (marketId !== null && frame.marketId !== marketId)) return;
          setState({ mode: 'stream', live: frame.candle, symbol, interval });
        }
      };
      const lost = () => {
        if (closed || socket !== mine) return;
        socket = null;
        setState((now) => ({ ...now, mode: 'poll' }));
        retry = setTimeout(connect, RECONNECT_MS);
      };
      mine.onerror = lost;
      mine.onclose = lost;
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      const current = socket;
      socket = null;
      current?.close();
    };
  }, [symbol, interval]);
  // A frame held from another symbol or interval (the effect resets after the first render with new props) is never shown.
  return held.symbol === symbol && held.interval === interval ? { mode: held.mode, live: held.live } : { mode: 'poll', live: null };
}

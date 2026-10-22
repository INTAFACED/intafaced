// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../data/types';
import {
  RECONNECT_MS,
  isStreamInterval,
  mergeLive,
  parseIncoming,
  useCandleStream,
  type CandleStream,
  type SocketLike,
} from './live-candles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bar = (t: number, c: string): Candle => ({ t, o: '1', h: '3', l: '1', c, v: '5', filled: false });
// The door's real shape (services/svc-ws/src/mux/session.ts #sinkFor): the hub frame sits in `data` of a channel envelope.
const envelope = (data: object, market = 'm1', interval = '1m') => JSON.stringify({ ch: 'candles', market, interval, data });
const frame = (t: number, c: string, extra: object = {}) =>
  envelope({ type: 'candle', marketId: 'm1', interval: '1m', t, o: '1', h: '3', l: '1', c, v: '5', closed: false, ...extra });

describe('parseIncoming', () => {
  it('reads a candle frame as decimal strings and nothing else', () => {
    const got = parseIncoming(frame(60_000, '2.5'));
    expect(got).toEqual({
      kind: 'candle',
      frame: {
        marketId: 'm1',
        interval: '1m',
        closed: false,
        candle: { t: 60_000, o: '1', h: '3', l: '1', c: '2.5', v: '5', filled: false },
      },
    });
  });
  it('ignores a candle frame that is not inside the channel envelope, as the door never sends one', () => {
    expect(
      parseIncoming(JSON.stringify({ type: 'candle', marketId: 'm1', interval: '1m', t: 1, o: '1', h: '1', l: '1', c: '1', v: '1' })),
    ).toEqual({ kind: 'other' });
  });
  it('drops frames that are not JSON, not objects, or carry a price that is not a decimal', () => {
    expect(parseIncoming('nope')).toEqual({ kind: 'other' });
    expect(parseIncoming('[]')).toEqual({ kind: 'other' });
    expect(parseIncoming(frame(1, '1e9'))).toEqual({ kind: 'other' });
    expect(parseIncoming(frame(1, 'NaN'))).toEqual({ kind: 'other' });
    expect(parseIncoming(envelope({ type: 'candle', marketId: 'm1' }))).toEqual({ kind: 'other' });
  });
  it('reads the acknowledgement, a refusal and the unavailable notice', () => {
    expect(parseIncoming(JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: true, market: 'm1' }] }))).toEqual({
      kind: 'ack',
      ok: true,
      marketId: 'm1',
    });
    expect(parseIncoming(JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: false, code: 'unknown_market' }] }))).toEqual({
      kind: 'ack',
      ok: false,
      marketId: null,
    });
    expect(parseIncoming(JSON.stringify({ op: 'error', code: 'unavailable' }))).toEqual({ kind: 'ack', ok: false, marketId: null });
    expect(parseIncoming(envelope({ type: 'status', code: 'candles.unavailable', marketId: 'm1', interval: '1m' }))).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('mergeLive', () => {
  const polled = [bar(0, '1'), bar(60_000, '2')];
  it('replaces the open bar, appends a newer one and ignores an older one', () => {
    expect(mergeLive(polled, bar(60_000, '9'))).toEqual([bar(0, '1'), bar(60_000, '9')]);
    expect(mergeLive(polled, bar(120_000, '3'))).toEqual([...polled, bar(120_000, '3')]);
    expect(mergeLive(polled, bar(-60_000, '3'))).toBe(polled);
  });
  it('leaves the history alone with no live bar or no history', () => {
    expect(mergeLive(polled, null)).toBe(polled);
    expect(mergeLive([], bar(0, '1'))).toEqual([]);
  });
  it('serves six intervals on the stream and polls the rest', () => {
    expect(isStreamInterval('15m')).toBe(true);
    expect(isStreamInterval('3m')).toBe(false);
    expect(isStreamInterval('1w')).toBe(false);
  });
});

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  onclose: SocketLike['onclose'] = null;
  sent: string[] = [];
  closedByUs = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closedByUs = true;
  }
}

describe('useCandleStream', () => {
  let host: HTMLDivElement;
  let sockets: FakeSocket[];
  let seen: CandleStream;
  const open = (url: string) => {
    expect(url).toMatch(/^wss?:\/\/.+\/ws\/stream$/);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  function Probe({ symbol, interval }: { symbol: string; interval: '1m' | '3m' }) {
    const state = useCandleStream(symbol, interval, open);
    useEffect(() => {
      seen = state;
    });
    return null;
  }
  const mount = async (interval: '1m' | '3m' = '1m', symbol = 'BTC/USDT') => {
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe, { symbol, interval })));
    return root;
  };
  const say = (socket: FakeSocket, text: string) => act(async () => socket.onmessage?.({ data: text }));

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    sockets = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  it('subscribes to the candle channel, goes live on the first frame and keeps polling until then', async () => {
    const root = await mount();
    expect(sockets).toHaveLength(1);
    expect(seen.mode).toBe('poll');
    await act(async () => sockets[0]!.onopen?.({}));
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      op: 'subscribe',
      id: 'candles',
      channels: [{ ch: 'candles', market: 'BTC/USDT', interval: '1m' }],
    });
    await say(sockets[0]!, JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: true, market: 'm1' }] }));
    expect(seen.mode).toBe('poll');
    await say(sockets[0]!, frame(60_000, '2.5'));
    expect(seen.mode).toBe('stream');
    expect(seen.live?.c).toBe('2.5');
    await act(async () => root.unmount());
    expect(sockets[0]!.closedByUs).toBe(true);
  });

  it('drops a frame for another market or interval', async () => {
    await mount();
    await say(sockets[0]!, JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: true, market: 'm1' }] }));
    await say(sockets[0]!, frame(60_000, '2', { marketId: 'other' }));
    await say(sockets[0]!, frame(60_000, '2', { interval: '1h' }));
    expect(seen.live).toBeNull();
    expect(seen.mode).toBe('poll');
  });

  it('falls back to the poll when the socket closes and reconnects after a pause', async () => {
    await mount();
    await say(sockets[0]!, JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: true, market: 'm1' }] }));
    await say(sockets[0]!, frame(60_000, '2.5'));
    expect(seen.mode).toBe('stream');
    await act(async () => sockets[0]!.onclose?.({}));
    expect(seen.mode).toBe('poll');
    expect(sockets).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(RECONNECT_MS));
    expect(sockets).toHaveLength(2);
  });

  it('polls when the subscription is refused or the feed says it is unavailable', async () => {
    await mount();
    await say(sockets[0]!, JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: false, code: 'unknown_market' }] }));
    expect(seen.mode).toBe('poll');
    await say(sockets[0]!, frame(60_000, '2.5'));
    expect(seen).toEqual({ mode: 'poll', live: null });
  });

  it('goes back to polling when a live feed reports itself unavailable', async () => {
    await mount();
    await say(sockets[0]!, JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: true, market: 'm1' }] }));
    await say(sockets[0]!, frame(60_000, '2.5'));
    expect(seen.mode).toBe('stream');
    await say(sockets[0]!, envelope({ type: 'status', code: 'candles.unavailable', marketId: 'm1', interval: '1m' }));
    expect(seen.mode).toBe('poll');
  });

  it('never shows a frame held from the interval before a change', async () => {
    const root = await mount();
    await say(sockets[0]!, JSON.stringify({ op: 'ack', for: 'subscribe', results: [{ i: 0, ok: true, market: 'm1' }] }));
    await say(sockets[0]!, frame(60_000, '2.5'));
    expect(seen.live?.c).toBe('2.5');
    await act(async () => root.render(createElement(Probe, { symbol: 'BTC/USDT', interval: '3m' })));
    expect(seen).toEqual({ mode: 'poll', live: null });
    expect(sockets[0]!.closedByUs).toBe(true);
  });

  it('opens no socket for an interval the stream does not serve', async () => {
    await mount('3m');
    expect(sockets).toHaveLength(0);
    expect(seen).toEqual({ mode: 'poll', live: null });
  });
});

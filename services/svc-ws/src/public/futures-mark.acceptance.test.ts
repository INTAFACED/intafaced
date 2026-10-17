/**
 * Public `futures.mark.<symbol>` frames.
 * A fresh published mark is delivered on the test clock. An unlisted symbol
 * and a missing feed are refused. A stale mark, and a blank freshness limit,
 * produce no mark frame.
 */
import { describe, expect, it } from 'vitest';
import { DepthHub } from '../depth/hub.js';
import type { DepthSource } from '../depth/source.js';
import { TradeHub } from '../trade/hub.js';
import { CandleHub } from '../mux/candle-hub.js';
import { MuxSession, type MuxSocket } from '../mux/session.js';
import { TickerHub } from '../mux/ticker-hub.js';
import {
  FRESHNESS_LIMIT_KEY,
  FRESHNESS_LIMIT_UNSET,
  MARK_UNAVAILABLE,
  MemoryMarkFeed,
  futuresMarkChannel,
  parseTickerMark,
} from './futures-mark.js';

const SYMBOL = 'BTC/USDT:USDT';
const NOW = Date.parse('2026-10-17T04:00:00.000Z');
const FRESHNESS_SECONDS = 60;

class Socket implements MuxSocket {
  bufferedBytes = 0;
  readonly frames: Array<Record<string, unknown>> = [];
  closed: { code: number; reason: string } | null = null;
  send(frame: string): void {
    this.frames.push(JSON.parse(frame) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

class StubSource implements DepthSource {
  async markets(): Promise<readonly string[]> {
    return [];
  }
  async snapshot(): Promise<{
    type: 'snapshot';
    marketId: string;
    sequence: number;
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
  }> {
    return { type: 'snapshot', marketId: 'm1', sequence: 1, bids: [], asks: [] };
  }
}

function session(input: { freshness?: number; feed?: MemoryMarkFeed; listed?: boolean }): { socket: Socket; session: MuxSession } {
  const depth = new DepthHub(new StubSource(), {
    depthLimit: 5,
    highWaterBytes: 1000,
    maxLagTicks: 3,
    maxConnections: 10,
    muxMaxConnections: 10,
    marketsRefreshMs: 0,
  });
  const socket = new Socket();
  const mux = new MuxSession(socket, {
    depth,
    trades: new TradeHub({
      highWaterBytes: 1000,
      maxLagTicks: 3,
      maxConnections: 10,
      muxMaxConnections: 10,
      recentLimit: 10,
      ensureKnownMarket: (id) => depth.ensureKnownMarket(id),
    }),
    tickers: new TickerHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: 10, throttleMs: 1000 }),
    candles: new CandleHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: 10 }),
    resolver: {
      async resolve(market: string) {
        if (input.listed === false || market === 'NOPE/USDT:USDT') return null;
        return { id: 'market-btc-perp', symbol: market };
      },
    },
    maxSubscriptions: 10,
    maxOpsPerSecond: 100,
    highWaterBytes: 1000,
    log: { info: () => undefined, warn: () => undefined },
    clock: () => NOW,
    markFeed: input.feed,
    markFreshnessSeconds: input.freshness,
  });
  return { socket, session: mux };
}

function markFrames(socket: Socket): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => typeof frame.channel === 'string' && frame.channel.startsWith('futures.mark.'));
}

async function subscribe(mux: MuxSession, channels: string[]): Promise<void> {
  mux.onMessage(JSON.stringify({ op: 'subscribe', channels }));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('futures mark stream', () => {
  it('delivers one mark frame inside the test clock, with the feed timestamp and no account fields', async () => {
    const feed = new MemoryMarkFeed();
    feed.set({ symbol: SYMBOL, price: '64000.50', observedAt: new Date(NOW - 1_000).toISOString() });
    const { socket, session: mux } = session({ freshness: FRESHNESS_SECONDS, feed });
    await subscribe(mux, [futuresMarkChannel(SYMBOL)]);
    expect(markFrames(socket)).toEqual([
      {
        channel: futuresMarkChannel(SYMBOL),
        type: 'mark',
        symbol: SYMBOL,
        price: '64000.50',
        observedAt: new Date(NOW - 1_000).toISOString(),
      },
    ]);
    expect(markFrames(socket)[0]).not.toHaveProperty('userId');
    expect(markFrames(socket)[0]).not.toHaveProperty('accountId');
    expect(markFrames(socket)[0]).not.toHaveProperty('positionId');
  });

  it('refuses an unlisted symbol and a listed symbol with no mark', async () => {
    const feed = new MemoryMarkFeed();
    const { socket, session: mux } = session({ freshness: FRESHNESS_SECONDS, feed });
    await subscribe(mux, [futuresMarkChannel('NOPE/USDT:USDT'), futuresMarkChannel(SYMBOL)]);
    expect(markFrames(socket)).toEqual([]);
    const ack = socket.frames.find((frame) => frame.op === 'ack') as { results: Array<Record<string, unknown>> };
    expect(ack.results[0]).toMatchObject({ ok: false, code: 'unknown_market' });
    expect(ack.results[1]).toMatchObject({ ok: false, code: MARK_UNAVAILABLE });
  });

  it('sends no mark frame when the feed is older than the published freshness limit', async () => {
    const feed = new MemoryMarkFeed();
    feed.set({ symbol: SYMBOL, price: '64000.50', observedAt: new Date(NOW - (FRESHNESS_SECONDS + 1) * 1000).toISOString() });
    const { socket, session: mux } = session({ freshness: FRESHNESS_SECONDS, feed });
    await subscribe(mux, [futuresMarkChannel(SYMBOL)]);
    expect(markFrames(socket)).toEqual([]);
  });

  it('refuses ws.freshness_limit_unset and sends no mark frame when the limit is blank', async () => {
    const feed = new MemoryMarkFeed();
    feed.set({ symbol: SYMBOL, price: '64000.50', observedAt: new Date(NOW).toISOString() });
    const { socket, session: mux } = session({ feed });
    await subscribe(mux, [futuresMarkChannel(SYMBOL)]);
    expect(markFrames(socket)).toEqual([]);
    const ack = socket.frames.find((frame) => frame.op === 'ack') as { results: Array<Record<string, unknown>> };
    expect(ack.results[0]).toMatchObject({ ok: false, code: FRESHNESS_LIMIT_UNSET });
    expect(String(ack.results[0]?.message)).toContain(FRESHNESS_LIMIT_KEY);
  });

  it('does not invent an observation time for a ticker that only has a price', () => {
    expect(parseTickerMark(SYMBOL, { markPrice: '64000.50', markSource: 'venue' })).toBeNull();
    expect(parseTickerMark(SYMBOL, { markPrice: 64000.5, observedAt: new Date(NOW).toISOString() })).toBeNull();
    expect(parseTickerMark(SYMBOL, { markPrice: '64000.50', observedAt: new Date(NOW).toISOString() })).toEqual({
      symbol: SYMBOL,
      price: '64000.50',
      observedAt: new Date(NOW).toISOString(),
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { DepthSink } from '../depth/hub.js';
import { CandleHub, type WireCandle } from './candle-hub.js';
import { MuxPoller } from './poller.js';
import type { CandleSource, MarketDirectory, RawTicker, TickerSource } from './sources.js';
import { TickerHub } from './ticker-hub.js';

class FakeSink implements DepthSink {
  bufferedBytes = 0;
  readonly frames: any[] = [];
  closed: { code: number; reason: string } | null = null;
  send(frame: string): void {
    this.frames.push(JSON.parse(frame));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

const directory: MarketDirectory = {
  refresh: async () => undefined,
  idForSymbol: (symbol) => ({ 'BTC/USDT': 'id-btc', 'ETH/USDT': 'id-eth' })[symbol] ?? null,
  symbolFor: (id) => ({ 'id-btc': 'BTC/USDT', 'id-eth': 'ETH/USDT' })[id] ?? null,
};

function raw(symbol: string, last: string): RawTicker {
  return { symbol, last, change24h: null, changePct24h: null, high: null, low: null, volume: null, quoteVolume: null };
}

function build(opts: { tickers?: RawTicker[] | Error; candles?: WireCandle[] | Error; now?: () => number } = {}) {
  const clock = opts.now ?? (() => 10 * 60_000 + 20_000);
  const tickers = new TickerHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: 4, throttleMs: 1000 });
  const candles = new CandleHub({ highWaterBytes: 1000, maxLagTicks: 3, maxConnections: 4 });
  const tickerSource: TickerSource = {
    fetch: vi.fn(async () => {
      if (opts.tickers instanceof Error) throw opts.tickers;
      return opts.tickers ?? [];
    }),
  };
  const candleSource: CandleSource & { latest: ReturnType<typeof vi.fn> } = {
    latest: vi.fn(async () => {
      if (opts.candles instanceof Error) throw opts.candles;
      return opts.candles ?? [];
    }),
  };
  const poller = new MuxPoller(
    { tickers, candles, tickerSource, candleSource, directory },
    { tickerPollMs: 1000, candlePollMs: 2000, flushMs: 250, clock },
    { info: vi.fn(), warn: vi.fn() },
  );
  return { tickers, candles, tickerSource, candleSource, poller };
}

describe('MuxPoller — tickers', () => {
  it('reads nothing while nobody watches the ticker channel', async () => {
    const { poller, tickerSource } = build({ tickers: [raw('BTC/USDT', '1')] });
    await poller.tickTickers();
    expect(tickerSource.fetch).not.toHaveBeenCalled();
  });

  it('joins each svc-trade symbol to its market id and drops a symbol the listing does not know', async () => {
    const { poller, tickers } = build({ tickers: [raw('BTC/USDT', '1'), raw('ETH/USDT', '2'), raw('GHOST/USDT', '9')] });
    const sink = new FakeSink();
    tickers.attach(null, sink, 0);
    await poller.tickTickers();
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0].tickers.map((r: { market: string }) => r.market).sort()).toEqual(['id-btc', 'id-eth']);
  });

  it('names an outage when the source fails, once', async () => {
    const { poller, tickers } = build({ tickers: new Error('boom') });
    const sink = new FakeSink();
    tickers.attach(null, sink, 0);
    await poller.tickTickers();
    await poller.tickTickers();
    expect(sink.frames).toEqual([{ type: 'status', code: 'ticker.unavailable' }]);
  });
});

describe('MuxPoller — candles', () => {
  it('reads only watched keys, with a since that covers the previous and current bucket', async () => {
    const { poller, candles, candleSource } = build({ candles: [{ t: 9 * 60_000, o: '1', h: '2', l: '1', c: '2', v: '3' }] });
    await poller.tickCandles();
    expect(candleSource.latest).not.toHaveBeenCalled();

    const sink = new FakeSink();
    candles.attach('id-btc', '1m', sink, 10 * 60_000 + 20_000);
    await poller.tickCandles();
    // now = 10m20s → current bucket starts 10m; previous 9m.
    expect(candleSource.latest).toHaveBeenCalledWith('BTC/USDT', '1m', 9 * 60_000, 2);
    expect(sink.frames.map((f) => [f.t, f.closed])).toEqual([[9 * 60_000, true]]);
  });

  it('uses the interval’s own span for the since window', async () => {
    const { poller, candles, candleSource } = build({ candles: [] });
    candles.attach('id-btc', '1h', new FakeSink(), 0);
    await poller.tickCandles();
    expect(candleSource.latest).toHaveBeenCalledWith('BTC/USDT', '1h', -3_600_000 + 0, 2);
  });

  it('shares one read between two simultaneous demands for the same key', async () => {
    const { poller, candles, candleSource } = build({ candles: [] });
    candles.attach('id-btc', '1m', new FakeSink(), 0);
    await Promise.all([poller.pollCandle('id-btc', '1m'), poller.pollCandle('id-btc', '1m')]);
    expect(candleSource.latest).toHaveBeenCalledTimes(1);
  });

  it('names the outage for that key only when its read fails', async () => {
    const { poller, candles } = build({ candles: new Error('boom') });
    const btc = new FakeSink();
    candles.attach('id-btc', '1m', btc, 0);
    await poller.tickCandles();
    expect(btc.frames).toEqual([{ type: 'status', code: 'candles.unavailable', marketId: 'id-btc', interval: '1m' }]);
  });

  it('a market with no listed symbol is unavailable, not guessed', async () => {
    const { poller, candles, candleSource } = build();
    const sink = new FakeSink();
    candles.attach('id-unknown', '1m', sink, 0);
    await poller.tickCandles();
    expect(candleSource.latest).not.toHaveBeenCalled();
    expect(sink.frames).toEqual([expect.objectContaining({ type: 'status', code: 'candles.unavailable' })]);
  });
});

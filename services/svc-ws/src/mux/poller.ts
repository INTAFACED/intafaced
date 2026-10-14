import type { HubLogger } from '../depth/hub.js';
import { MUX_INTERVAL_MS, type MuxInterval } from './protocol.js';
import type { CandleHub, WireCandle } from './candle-hub.js';
import type { CandleSource, MarketDirectory, TickerSource } from './sources.js';
import type { TickerHub, TickerRow } from './ticker-hub.js';

/**
 * THE CLOCK FOR THE TICKER AND CANDLE CHANNELS.
 *
 * Same shape and same reasons as `depth/poller.ts`: the hubs own no timer, this
 * does. Nothing is read while nobody is subscribed — a market, interval or the
 * whole ticker map that nobody watches is not fetched, which is what keeps this
 * from becoming a recorder or a load generator against svc-trade.
 *
 *   · tickers: one `GET /api/v1/tickers` per `tickerPollMs`, only while the
 *     ticker hub has a subscriber. A separate, faster `flushMs` timer lets the
 *     hub release throttled rows the moment their window ends instead of
 *     waiting for the next fetch (and runs the lag sweep on quiet ticks).
 *   · candles: per WATCHED (market, interval), one `GET /api/v1/ohlcv` of the
 *     newest two buckets every `candlePollMs`. The upstream window is bounded
 *     with `since` (the start of the previous bucket) so each read scans two
 *     buckets of fills, not the market's whole history.
 */

/** The newest two buckets: the open one, and the one before it so a rollover can finalise it. */
export const CANDLE_POLL_BUCKETS = 2;

export interface MuxPollerOptions {
  readonly tickerPollMs: number;
  readonly candlePollMs: number;
  readonly flushMs: number;
  readonly clock?: () => number;
}

export class MuxPoller {
  readonly #tickers: TickerHub;
  readonly #candles: CandleHub;
  readonly #tickerSource: TickerSource;
  readonly #candleSource: CandleSource;
  readonly #directory: MarketDirectory;
  readonly #options: MuxPollerOptions;
  readonly #log: HubLogger;
  readonly #clock: () => number;

  #timers: ReturnType<typeof setInterval>[] = [];
  #tickerBusy = false;
  #candlesBusy = false;
  readonly #candleSeeds = new Map<string, Promise<void>>();
  /** Last upstream answer per candle key (null = the read failed), for the demand path. */
  readonly #candleLast = new Map<string, { at: number; candles: readonly WireCandle[] | null }>();
  #tickerLast: { at: number; rows: TickerRow[] | null } | null = null;

  constructor(
    deps: { tickers: TickerHub; candles: CandleHub; tickerSource: TickerSource; candleSource: CandleSource; directory: MarketDirectory },
    options: MuxPollerOptions,
    log: HubLogger,
  ) {
    this.#tickers = deps.tickers;
    this.#candles = deps.candles;
    this.#tickerSource = deps.tickerSource;
    this.#candleSource = deps.candleSource;
    this.#directory = deps.directory;
    this.#options = options;
    this.#log = log;
    this.#clock = options.clock ?? Date.now;
  }

  start(): void {
    if (this.#timers.length > 0) return;
    const every = (fn: () => void, ms: number) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      this.#timers.push(timer);
    };
    every(() => void this.tickTickers(), this.#options.tickerPollMs);
    every(() => this.#tickers.flush(this.#clock()), this.#options.flushMs);
    every(() => void this.tickCandles(), this.#options.candlePollMs);
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
  }

  /** One ticker sweep. Exposed so tests drive the clock. */
  async tickTickers(): Promise<void> {
    if (this.#tickerBusy || this.#tickers.connections === 0) return;
    this.#tickerBusy = true;
    try {
      await this.#directory.refresh();
      const raw = await this.#tickerSource.fetch();
      const rows: TickerRow[] = [];
      for (const ticker of raw) {
        const market = this.#directory.idForSymbol(ticker.symbol);
        // A symbol the listing does not know has no id a client could hold. Skipped, never guessed.
        if (market === null) continue;
        rows.push({ market, ...ticker });
      }
      const now = this.#clock();
      this.#tickerLast = { at: now, rows };
      this.#tickers.ingest(rows, now);
    } catch (err) {
      this.#tickerLast = { at: this.#clock(), rows: null };
      this.#tickers.markUnavailable();
      this.#log.warn({ err: String(err) }, 'ws: ticker poll failed — disclosing ticker.unavailable');
    } finally {
      this.#tickerBusy = false;
    }
  }

  /**
   * A subscriber arrived to an empty ticker cache. Within one poll period of the
   * last upstream answer that answer is re-used; otherwise one shared read.
   */
  async demandTickers(): Promise<void> {
    const last = this.#tickerLast;
    const now = this.#clock();
    if (last !== null && now - last.at < this.#options.tickerPollMs) {
      if (last.rows !== null) this.#tickers.ingest(last.rows, now);
      else this.#tickers.markUnavailable();
      return;
    }
    await this.tickTickers();
  }

  /** A subscriber arrived to an empty candle cache. Same read-through rule as `demandTickers`, per key. */
  async demandCandle(marketId: string, interval: MuxInterval): Promise<void> {
    const key = `${marketId}|${interval}`;
    const inFlight = this.#candleSeeds.get(key);
    if (inFlight) return inFlight;
    const last = this.#candleLast.get(key);
    const now = this.#clock();
    if (last !== undefined && now - last.at < this.#options.candlePollMs) {
      if (last.candles !== null) this.#candles.ingest(marketId, interval, last.candles, now);
      else this.#candles.markUnavailable(marketId, interval);
      return;
    }
    await this.pollCandle(marketId, interval);
  }

  /** One candle sweep across every watched (market, interval). */
  async tickCandles(): Promise<void> {
    if (this.#candlesBusy) return;
    this.#candlesBusy = true;
    try {
      await Promise.all(this.#candles.activeKeys.map(({ marketId, interval }) => this.pollCandle(marketId, interval)));
      // Answers older than two periods can no longer be served to the demand path.
      const horizon = this.#clock() - 2 * this.#options.candlePollMs;
      for (const [key, entry] of this.#candleLast) if (entry.at < horizon) this.#candleLast.delete(key);
    } finally {
      this.#candlesBusy = false;
    }
  }

  /** Read one watched key now (also the first-subscriber seed). Deduped per key. */
  pollCandle(marketId: string, interval: MuxInterval): Promise<void> {
    const key = `${marketId}|${interval}`;
    const inFlight = this.#candleSeeds.get(key);
    if (inFlight) return inFlight;
    const run = (async () => {
      try {
        await this.#directory.refresh();
        const symbol = this.#directory.symbolFor(marketId);
        if (symbol === null) {
          this.#candleLast.set(key, { at: this.#clock(), candles: null });
          this.#candles.markUnavailable(marketId, interval);
          this.#log.warn({ marketId }, 'ws: candle poll skipped — market has no listed symbol');
          return;
        }
        const now = this.#clock();
        const span = MUX_INTERVAL_MS[interval];
        const since = Math.floor(now / span) * span - span;
        const candles = await this.#candleSource.latest(symbol, interval, since, CANDLE_POLL_BUCKETS);
        this.#candleLast.set(key, { at: now, candles });
        this.#candles.ingest(marketId, interval, candles, now);
      } catch (err) {
        this.#candleLast.set(key, { at: this.#clock(), candles: null });
        this.#candles.markUnavailable(marketId, interval);
        this.#log.warn({ marketId, interval, err: String(err) }, 'ws: candle poll failed — disclosing candles.unavailable');
      } finally {
        this.#candleSeeds.delete(key);
      }
    })();
    this.#candleSeeds.set(key, run);
    return run;
  }
}

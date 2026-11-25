import { isRecord } from '@intafaced/contracts/guards';
import type { DepthSnapshot, WireLevel } from '@intafaced/market-data';
import { DepthNoBookError, DepthSourceError, type DepthSource, type NativeL3Queue } from './depth/source.js';
import type { HubLogger } from './depth/hub.js';
import type { MarketRegistry } from './depth/registry.js';
import { MuxSourceError, parseTicker, type CandleSource, type MarketDirectory, type RawTicker, type TickerSource } from './mux/sources.js';
import type { WireCandle } from './mux/candle-hub.js';

/**
 * Venue-backed public market-data sources for svc-ws (J-cex-spot-14 #8).
 *
 * When svc-trade's user-venue door is on, public depth, tickers, spreads and candles come from the outside venue
 * through svc-trade's public venue routes (`/api/v1/venue/market-states`, `/api/v1/venue/public-book`,
 * `/api/v1/venue/tickers`, `/api/v1/venue/chart-candles`) with no credential. When the venue door is switched off
 * (`404 trade.user_venue_off`), each wrapper falls back to the own-engine source. Any other failure (venue down, 5xx,
 * malformed body) is surfaced as an upstream error and never silently falls back to our own book.
 */

const VENUE_DOOR_OFF = 'trade.user_venue_off';
const DECIMAL = /^-?\d+(\.\d+)?$/;

export interface VenueFeedOptions {
  readonly tradeUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: HubLogger;
}

type ProbeResult =
  { readonly kind: 'door_off' } | { readonly kind: 'not_offered' } | { readonly kind: 'ok'; readonly body: Record<string, unknown> };

const objOf = (value: unknown): Record<string, unknown> | null => (isRecord(value) ? value : null);

async function probeVenue(options: VenueFeedOptions, path: string): Promise<ProbeResult> {
  const url = `${options.tradeUrl.replace(/\/+$/, '')}${path}`;
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
  } catch (err) {
    throw new DepthSourceError(`svc-trade venue feed unreachable: ${err instanceof Error ? err.message : String(err)}`, null);
  }
  const rawBody: unknown = await response.json().catch(() => null);
  const body = objOf(rawBody);
  const code = body?.intafacedCode;
  const refusalCode = objOf(body?.refusal)?.code;
  if (response.status === 404 && code === VENUE_DOOR_OFF) return { kind: 'door_off' };
  if (response.status === 422 && refusalCode === 'not_offered') return { kind: 'not_offered' };
  if (!response.ok) throw new DepthSourceError(`svc-trade venue feed answered ${response.status} for ${path}`, response.status);
  if (body === null) {
    throw new DepthSourceError(`svc-trade venue feed returned malformed JSON for ${path}`, null);
  }
  return { kind: 'ok', body };
}

function parseVenueLevels(raw: unknown, side: string, marketId: string): WireLevel[] {
  if (!Array.isArray(raw)) throw new DepthSourceError(`${marketId}: venue ${side} is not an array`, null);
  return raw.map((level): WireLevel => {
    const obj = objOf(level);
    if (!obj) {
      throw new DepthSourceError(`${marketId}: venue ${side} level is not an object`, null);
    }
    const { price, amount } = obj;
    if (typeof price !== 'string' || typeof amount !== 'string' || !DECIMAL.test(price) || !DECIMAL.test(amount)) {
      throw new DepthSourceError(`${marketId}: venue ${side} level is not decimal strings`, null);
    }
    return [price, amount];
  });
}

/** Lists every listed venue market symbol when the venue door is on; empty when the door is off. */
export class VenueMarketRegistry implements MarketRegistry {
  constructor(private readonly options: VenueFeedOptions) {}

  async markets(): Promise<readonly string[]> {
    const res = await probeVenue(this.options, '/api/v1/venue/market-states');
    if (res.kind !== 'ok') return [];
    const list = objOf(res.body.value)?.markets;
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const row of list) {
      const symbol = objOf(row)?.symbol;
      if (typeof symbol === 'string' && symbol !== '') out.push(symbol);
    }
    return out;
  }
}

/** Reads public depth from the venue when the door is on and lists `marketId`, else from the own-engine source. */
export class VenueOrEngineDepthSource implements DepthSource {
  constructor(
    private readonly engine: DepthSource,
    private readonly options: VenueFeedOptions,
  ) {}

  async markets(): Promise<readonly string[]> {
    return this.engine.markets();
  }

  async snapshot(marketId: string, limit: number): Promise<DepthSnapshot> {
    const res = await probeVenue(
      this.options,
      `/api/v1/venue/public-book?symbol=${encodeURIComponent(marketId)}&depth=${Math.min(Math.max(1, limit), 50)}`,
    );
    if (res.kind === 'door_off' || res.kind === 'not_offered') {
      return this.engine.snapshot(marketId, limit);
    }
    const val = objOf(res.body.value);
    if (!val) throw new DepthNoBookError(marketId);
    if (typeof val.sequence !== 'number' || !Number.isInteger(val.sequence)) {
      throw new DepthSourceError(`${marketId}: venue depth carries no integer sequence`, null);
    }
    return {
      type: 'snapshot',
      marketId,
      sequence: val.sequence,
      bids: parseVenueLevels(val.bids, 'bids', marketId),
      asks: parseVenueLevels(val.asks, 'asks', marketId),
    };
  }

  l3Queue(marketId: string, limit: number): Promise<NativeL3Queue> {
    if (!this.engine.l3Queue) throw new DepthNoBookError(marketId);
    return this.engine.l3Queue(marketId, limit);
  }

  trading(marketId: string) {
    return this.engine.trading ? this.engine.trading(marketId) : null;
  }

  tradingOpenEvidence(marketId: string) {
    return this.engine.tradingOpenEvidence ? this.engine.tradingOpenEvidence(marketId) : { market: false, venue: false };
  }

  venueHalted(): boolean {
    return this.engine.venueHalted ? this.engine.venueHalted() : false;
  }
}

/** Resolves venue symbols (`BTC-USDC` and `BTC/USDC` -> `BTC-USDC`) when the door is on, else delegates to the engine directory. */
export class VenueOrEngineMarketDirectory implements MarketDirectory {
  readonly #bySymbol = new Map<string, string>();
  readonly #byId = new Map<string, string>();
  #venueOn = false;

  constructor(
    private readonly engine: MarketDirectory,
    private readonly options: VenueFeedOptions,
  ) {}

  idForSymbol(symbol: string): string | null {
    if (this.#venueOn) return this.#bySymbol.get(symbol) ?? this.#bySymbol.get(symbol.replace('/', '-')) ?? null;
    return this.engine.idForSymbol(symbol);
  }

  symbolFor(id: string): string | null {
    if (this.#venueOn) return this.#byId.get(id) ?? null;
    return this.engine.symbolFor(id);
  }

  async refresh(force = false): Promise<void> {
    try {
      const res = await probeVenue(this.options, '/api/v1/venue/market-states');
      if (res.kind === 'door_off') {
        this.#venueOn = false;
        this.#bySymbol.clear();
        this.#byId.clear();
        await this.engine.refresh(force);
        return;
      }
      if (res.kind === 'ok') {
        const list = objOf(res.body.value)?.markets;
        if (Array.isArray(list)) {
          this.#bySymbol.clear();
          this.#byId.clear();
          for (const row of list) {
            const m = objOf(row);
            if (!m || typeof m.symbol !== 'string' || m.symbol === '') continue;
            this.#bySymbol.set(m.symbol, m.symbol);
            this.#byId.set(m.symbol, m.symbol);
            if (typeof m.baseAsset === 'string' && typeof m.quoteAsset === 'string') {
              this.#bySymbol.set(`${m.baseAsset}/${m.quoteAsset}`, m.symbol);
            }
          }
          this.#venueOn = true;
          return;
        }
      }
    } catch (err) {
      this.options.log?.warn({ err: String(err) }, 'ws: venue market directory refresh failed');
    }
    if (!this.#venueOn) await this.engine.refresh(force);
  }
}

/** Reads public tickers and spreads from the venue when the door is on, else from the own-engine source. */
export class VenueOrEngineTickerSource implements TickerSource {
  constructor(
    private readonly engine: TickerSource,
    private readonly options: VenueFeedOptions,
  ) {}

  async fetch(): Promise<readonly RawTicker[]> {
    let res: ProbeResult;
    try {
      res = await probeVenue(this.options, '/api/v1/venue/tickers');
    } catch (err) {
      throw new MuxSourceError(err instanceof Error ? err.message : String(err), err instanceof DepthSourceError ? err.status : null);
    }
    if (res.kind === 'door_off') return this.engine.fetch();
    if (res.kind !== 'ok') throw new MuxSourceError('venue tickers unavailable', null);
    const map = objOf(res.body.value);
    if (map === null) {
      throw new MuxSourceError('venue ticker map is not an object', null);
    }
    const out: RawTicker[] = [];
    for (const [key, value] of Object.entries(map)) {
      const row = parseTicker(key, value);
      if (row !== null) out.push(row);
    }
    return out;
  }
}

/** Reads public candles from the venue when the door is on, else from the own-engine source. */
export class VenueOrEngineCandleSource implements CandleSource {
  constructor(
    private readonly engine: CandleSource,
    private readonly options: VenueFeedOptions,
  ) {}

  async latest(...args: Parameters<CandleSource['latest']>): Promise<readonly WireCandle[]> {
    const [symbol, interval, sinceMs, limit] = args;
    const path = `/api/v1/venue/chart-candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&since=${encodeURIComponent(new Date(Math.max(0, Math.floor(sinceMs))).toISOString())}&limit=${limit}`;
    let res: ProbeResult;
    try {
      res = await probeVenue(this.options, path);
    } catch (err) {
      throw new MuxSourceError(err instanceof Error ? err.message : String(err), err instanceof DepthSourceError ? err.status : null);
    }
    if (res.kind === 'door_off') return this.engine.latest(symbol, interval, sinceMs, limit);
    if (res.kind !== 'ok') throw new MuxSourceError(`venue candles not offered for ${symbol}`, 422);
    const rows = res.body.value;
    if (!Array.isArray(rows)) throw new MuxSourceError('venue candles answer is not a list', null);
    const out: WireCandle[] = [];
    for (const row of rows) {
      const c = objOf(row);
      if (!c) continue;
      const t = typeof c.openAt === 'string' ? Date.parse(c.openAt) : Number.NaN;
      if (!Number.isSafeInteger(t) || t < 0) continue;
      if (
        typeof c.openPrice !== 'string' ||
        typeof c.highPrice !== 'string' ||
        typeof c.lowPrice !== 'string' ||
        typeof c.closePrice !== 'string' ||
        typeof c.baseVolume !== 'string' ||
        !DECIMAL.test(c.openPrice) ||
        !DECIMAL.test(c.highPrice) ||
        !DECIMAL.test(c.lowPrice) ||
        !DECIMAL.test(c.closePrice) ||
        !DECIMAL.test(c.baseVolume)
      ) {
        continue;
      }
      out.push({ t, o: c.openPrice, h: c.highPrice, l: c.lowPrice, c: c.closePrice, v: c.baseVolume });
    }
    return out;
  }
}

import { publishedMarketsListLimit } from '../depth/registry.js';
import type { HubLogger } from '../depth/hub.js';
import type { TickerRow } from './ticker-hub.js';
import type { WireCandle } from './candle-hub.js';
import type { MuxInterval } from './protocol.js';

/**
 * WHERE THE NEW CHANNELS GET THEIR NUMBERS.
 *
 * Both come from svc-trade's public CCXT-style REST (`TRADE_URL`) — the same
 * unauthenticated JSON the browser already reads, built from real taker fills.
 * No credential is sent, so svc-ws still holds nothing.
 *
 *   · `GET /api/v1/tickers?limit=`   → every market's last / 24 h stats
 *   · `GET /api/v1/ohlcv/:symbol?timeframe=&since=&limit=` → candles
 *   · `GET /api/v1/markets?limit=`   → id ↔ symbol, so a client may say
 *     `BTC/USDT` or the market id
 *
 * Money rule: an amount is a decimal STRING. A JSON number where an amount
 * belongs refuses the row — it has already been through a float — and the rest
 * of the map is still served.
 */

export class MuxSourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'MuxSourceError';
  }
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** `null`/absent → null (not published). A decimal string → itself. Anything else → `undefined` = refuse. */
function decimalOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && DECIMAL.test(value)) return value;
  return undefined;
}

export interface FetchOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: HubLogger;
}

async function getJson(options: FetchOptions, path: string): Promise<unknown> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}${path}`;
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
  } catch (err) {
    throw new MuxSourceError(`upstream unreachable: ${err instanceof Error ? err.message : String(err)}`, null);
  }
  if (!response.ok) throw new MuxSourceError(`upstream answered ${response.status}`, response.status);
  return response.json() as Promise<unknown>;
}

// ── Market directory (id ↔ symbol) ─────────────────────────────────────────

export interface MarketDirectory {
  /** Load the listing if the cache is older than its window. Never throws: a failure keeps the last list. */
  refresh(force?: boolean): Promise<void>;
  /** Canonical id for a unified symbol, from the cache. */
  idForSymbol(symbol: string): string | null;
  symbolFor(id: string): string | null;
}

export interface HttpMarketDirectoryOptions extends FetchOptions {
  /** Owner-published `GET /api/v1/markets?limit=` page. Blank refuses `ws.markets_list_limit_unset`. */
  readonly marketsLimit: number | undefined;
  readonly ttlMs: number;
  readonly clock?: () => number;
}

export class HttpMarketDirectory implements MarketDirectory {
  readonly #options: HttpMarketDirectoryOptions;
  readonly #bySymbol = new Map<string, string>();
  readonly #byId = new Map<string, string>();
  #loadedAt: number | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: HttpMarketDirectoryOptions) {
    this.#options = options;
  }

  idForSymbol(symbol: string): string | null {
    return this.#bySymbol.get(symbol) ?? null;
  }

  symbolFor(id: string): string | null {
    return this.#byId.get(id) ?? null;
  }

  refresh(force = false): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    const now = (this.#options.clock ?? Date.now)();
    if (!force && this.#loadedAt !== null && now - this.#loadedAt < this.#options.ttlMs) return Promise.resolve();
    const run = (async () => {
      try {
        const limit = publishedMarketsListLimit(this.#options.marketsLimit);
        const body = await getJson(this.#options, `/api/v1/markets?limit=${limit}`);
        const rows = Array.isArray(body) ? body : (body as { markets?: unknown })?.markets;
        if (!Array.isArray(rows)) throw new MuxSourceError('market listing returned no list', null);
        const bySymbol = new Map<string, string>();
        const byId = new Map<string, string>();
        for (const row of rows) {
          const id = (row as { id?: unknown })?.id;
          const symbol = (row as { symbol?: unknown })?.symbol;
          if (typeof id !== 'string' || id === '' || typeof symbol !== 'string' || symbol === '') continue;
          bySymbol.set(symbol, id);
          byId.set(id, symbol);
        }
        this.#bySymbol.clear();
        this.#byId.clear();
        for (const [k, v] of bySymbol) this.#bySymbol.set(k, v);
        for (const [k, v] of byId) this.#byId.set(k, v);
        this.#loadedAt = now;
      } catch (err) {
        // Keep serving the last known directory; a symbol alias is a convenience, ids still work.
        this.#options.log?.warn({ err: String(err) }, 'ws: market directory refresh failed — keeping the last known list');
        // Back off one window so a down listing is not retried by every subscribe.
        this.#loadedAt = now;
      } finally {
        this.#inFlight = null;
      }
    })();
    this.#inFlight = run;
    return run;
  }
}

// ── Tickers ────────────────────────────────────────────────────────────────

/** A ticker as svc-trade publishes it, before its symbol is joined to a market id. */
export type RawTicker = Omit<TickerRow, 'market'>;

export interface TickerSource {
  fetch(): Promise<readonly RawTicker[]>;
}

export interface HttpTickerSourceOptions extends FetchOptions {
  /** Owner-published `WS_MARKETS_LIST_LIMIT`. Blank refuses `ws.markets_list_limit_unset`. */
  readonly marketsLimit: number | undefined;
}

export class HttpTickerSource implements TickerSource {
  readonly #options: HttpTickerSourceOptions;

  constructor(options: HttpTickerSourceOptions) {
    this.#options = options;
  }

  async fetch(): Promise<readonly RawTicker[]> {
    const limit = publishedMarketsListLimit(this.#options.marketsLimit);
    const body = await getJson(this.#options, `/api/v1/tickers?limit=${limit}`);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new MuxSourceError('ticker map is not an object', null);
    }
    const out: RawTicker[] = [];
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const row = parseTicker(key, value);
      if (row === null) {
        this.#options.log?.warn({ symbol: key }, 'ws: ticker row refused — an amount was not a decimal string');
        continue;
      }
      out.push(row);
    }
    return out;
  }
}

/** Exported for tests. `null` = refuse the row. */
export function parseTicker(key: string, value: unknown): RawTicker | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const symbol = typeof v.symbol === 'string' && v.symbol !== '' ? v.symbol : key;
  const last = decimalOrNull(v.last);
  const change = decimalOrNull(v.change);
  const percentage = decimalOrNull(v.percentage);
  const high = decimalOrNull(v.high);
  const low = decimalOrNull(v.low);
  const volume = decimalOrNull(v.baseVolume);
  const quoteVolume = decimalOrNull(v.quoteVolume);
  if ([last, change, percentage, high, low, volume, quoteVolume].includes(undefined)) return null;
  return {
    symbol,
    last: last as string | null,
    change24h: change as string | null,
    changePct24h: percentage as string | null,
    high: high as string | null,
    low: low as string | null,
    volume: volume as string | null,
    quoteVolume: quoteVolume as string | null,
  };
}

// ── Candles ────────────────────────────────────────────────────────────────

export interface CandleSource {
  /** The newest candles for a symbol, oldest first. `sinceMs` bounds the SQL window on the upstream. */
  latest(symbol: string, interval: MuxInterval, sinceMs: number, limit: number): Promise<readonly WireCandle[]>;
}

export class HttpCandleSource implements CandleSource {
  readonly #options: FetchOptions;

  constructor(options: FetchOptions) {
    this.#options = options;
  }

  async latest(symbol: string, interval: MuxInterval, sinceMs: number, limit: number): Promise<readonly WireCandle[]> {
    const path = `/api/v1/ohlcv/${encodeURIComponent(symbol)}?timeframe=${interval}&since=${Math.max(0, Math.floor(sinceMs))}&limit=${limit}`;
    const body = await getJson(this.#options, path);
    if (!Array.isArray(body)) throw new MuxSourceError('ohlcv answer is not a list', null);
    const out: WireCandle[] = [];
    for (const row of body) {
      const candle = parseCandleRow(row);
      if (candle === null) {
        this.#options.log?.warn({ symbol, interval }, 'ws: candle row refused — not [t, o, h, l, c, v] with decimal strings');
        continue;
      }
      out.push(candle);
    }
    return out;
  }
}

/** CCXT row `[openTimeMs, open, high, low, close, volume]`. Exported for tests. `null` = refuse. */
export function parseCandleRow(row: unknown): WireCandle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [t, o, h, l, c, v] = row as unknown[];
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) return null;
  for (const amount of [o, h, l, c, v]) if (typeof amount !== 'string' || !DECIMAL.test(amount)) return null;
  return { t, o: o as string, h: h as string, l: l as string, c: c as string, v: v as string };
}

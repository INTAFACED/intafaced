/**
 * Public futures mark frames.
 *
 * Channel `futures.mark.<symbol>`. The price is the published feed's decimal
 * string and the timestamp is the feed's own observation time. This file does
 * not stamp "now" onto a price: a ticker that omits the observation time is
 * not a mark this stream will send.
 *
 * No account, user, or position field is part of the frame.
 */

export const MARK_UNAVAILABLE = 'ws.mark_unavailable' as const;
export const FRESHNESS_LIMIT_UNSET = 'ws.freshness_limit_unset' as const;
export const FRESHNESS_LIMIT_KEY = 'WS_MARK_FRESHNESS_SECONDS' as const;
export const FUTURES_MARK_PREFIX = 'futures.mark.';

const UNSIGNED = /^\d+(\.\d{1,18})?$/;

export interface PublishedMark {
  readonly symbol: string;
  readonly price: string;
  readonly observedAt: string;
}

export interface MarkFrame {
  readonly channel: string;
  readonly type: 'mark';
  readonly symbol: string;
  readonly price: string;
  readonly observedAt: string;
}

export interface MarkFeed {
  read(symbol: string): Promise<PublishedMark | null>;
}

export function futuresMarkChannel(symbol: string): string {
  return `${FUTURES_MARK_PREFIX}${symbol}`;
}

/** A price the feed actually published, with the feed's own timestamp. */
export function markFrame(mark: PublishedMark): MarkFrame | null {
  if (typeof mark.price !== 'string' || !UNSIGNED.test(mark.price)) return null;
  if (typeof mark.observedAt !== 'string' || !Number.isFinite(Date.parse(mark.observedAt))) return null;
  if (typeof mark.symbol !== 'string' || mark.symbol.length === 0) return null;
  return {
    channel: futuresMarkChannel(mark.symbol),
    type: 'mark',
    symbol: mark.symbol,
    price: mark.price,
    observedAt: mark.observedAt,
  };
}

/**
 * `GET /api/v1/futures/ticker` body. `markPrice: null` and a price with no
 * observation timestamp are both "no mark" — the timestamp is not invented here.
 */
export function parseTickerMark(symbol: string, body: unknown): PublishedMark | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const price = rec.markPrice;
  if (typeof price !== 'string' || !UNSIGNED.test(price)) return null;
  const observed = rec.observedAt ?? rec.markObservedAt;
  if (typeof observed !== 'string' || !Number.isFinite(Date.parse(observed))) return null;
  return { symbol, price, observedAt: observed };
}

export function isPublishedFreshnessSeconds(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Positive age over the limit, or a mark dated more than 30s ahead, is stale. */
export function markIsStale(observedAt: string, nowMs: number, freshnessSeconds: number): boolean {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return true;
  const ageMs = nowMs - observed;
  if (ageMs < -30_000) return true;
  return ageMs > freshnessSeconds * 1000;
}

export class MemoryMarkFeed implements MarkFeed {
  readonly #marks = new Map<string, PublishedMark>();

  set(mark: PublishedMark): void {
    this.#marks.set(mark.symbol, mark);
  }

  clear(symbol: string): void {
    this.#marks.delete(symbol);
  }

  async read(symbol: string): Promise<PublishedMark | null> {
    return this.#marks.get(symbol) ?? null;
  }
}

export class HttpFuturesMarkFeed implements MarkFeed {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: { readonly baseUrl: string; readonly fetch?: typeof globalThis.fetch }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async read(symbol: string): Promise<PublishedMark | null> {
    const url = `${this.#baseUrl}/api/v1/futures/ticker?symbol=${encodeURIComponent(symbol)}`;
    try {
      const response = await this.#fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      return parseTickerMark(symbol, await response.json());
    } catch {
      return null;
    }
  }
}

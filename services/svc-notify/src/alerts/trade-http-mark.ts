/**
 * Trade public ticker → MarkSource for v22.alerts.
 *
 * Leverage: same HTTP surface svc-bank already marks loans against
 * (`GET /api/v1/ticker/:symbol`, mid-of-book when two-sided, else last).
 * No import of svc-trade, no shared table, no invented price.
 *
 * `kind: 'live'` means the wiring exists. Individual quotes may still return
 * `unavailable` (unknown market, empty book, network error) — never invent.
 */

import { refuseIfMarkAged } from './accepted-mark.js';
import { isValidPositivePrice, parseDecimalString } from './decimal.js';
import { NOTIFY_PRICE_SOURCE_UNAVAILABLE, type AlertPriceSource, type MarkQuote, type MarkSource } from './types.js';

/** The ticker has no usable value for the side an alert chose (declared in `types.ts`). Never a fallback to another side. */

export const NOTIFY_MARKETS_LIST_LIMIT_UNSET = 'notify.markets_list_limit_unset' as const;
/** Trade `GET /api/v1/markets` cap. Owner may pass 500; blank is not 50. */
export const NOTIFY_MARKETS_LIST_LIMIT_MAX = 500;

/** Markets listing page size unpublished. Blank is not 50. */
export class NotifyMarketsListLimitUnsetError extends Error {
  readonly code = NOTIFY_MARKETS_LIST_LIMIT_UNSET;
  constructor() {
    super(NOTIFY_MARKETS_LIST_LIMIT_UNSET);
    this.name = 'NotifyMarketsListLimitUnsetError';
  }
}

/** Owner-published `GET /api/v1/markets?limit=`. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertNotifyMarketsListLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new NotifyMarketsListLimitUnsetError();
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new NotifyMarketsListLimitUnsetError();
  }
  return Math.min(NOTIFY_MARKETS_LIST_LIMIT_MAX, n);
}

export type TradeHttpMarkOptions = {
  readonly baseUrl: string;
  /**
   * Owner-published page size for `GET /api/v1/markets?limit=` (1..500).
   * Unset refuses named — never invent 50, never fetch without `?limit=`.
   */
  readonly marketsLimit?: number;
  readonly fetchImpl?: typeof fetch;
  /** Per-request budget. Default 3s — same order as bank's ticker read. */
  readonly timeoutMs?: number;
  /** How long a marketId→symbol map entry is reused. */
  readonly marketCacheMs?: number;
};

type MarketRow = {
  readonly id?: string;
  readonly symbol?: string;
};

type TickerRow = {
  readonly bid?: string | null;
  readonly ask?: string | null;
  readonly last?: string | null;
  readonly timestamp?: number | null;
};

/**
 * Mid of two positive decimal strings without using JS number.
 * Returns null when either side fails positive-price validation.
 */
export function midDecimalString(bid: string, ask: string): string | null {
  if (!isValidPositivePrice(bid) || !isValidPositivePrice(ask)) return null;
  const pb = parseDecimalString(bid);
  const pa = parseDecimalString(ask);
  if (!pb.ok || !pa.ok || pb.negative || pa.negative) return null;
  const scale = Math.max(pb.frac.length, pa.frac.length);
  const toScaled = (p: { int: string; frac: string }) => BigInt(p.int + p.frac.padEnd(scale, '0'));
  const mid = (toScaled(pb) + toScaled(pa)) / 2n;
  if (mid <= 0n) return null;
  if (scale === 0) return mid.toString();
  const raw = mid.toString().padStart(scale + 1, '0');
  const intPart = raw.slice(0, -scale).replace(/^0+(?=\d)/, '') || '0';
  const fracPart = raw.slice(-scale).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** Prefer mid when two-sided; else last. Never invent zero or empty. */
export function priceFromTicker(body: TickerRow): { price: string; quality: 'mid' | 'last' } | null {
  if (body.bid && body.ask) {
    const mid = midDecimalString(body.bid, body.ask);
    if (mid) return { price: mid, quality: 'mid' };
  }
  if (body.last && isValidPositivePrice(body.last)) {
    return { price: body.last.trim(), quality: 'last' };
  }
  return null;
}

/**
 * The price an alert's chosen source reads from one ticker body. `mark` is `priceFromTicker` exactly. `bid`, `ask` and `last`
 * read only that field: when it is missing or not a positive decimal the answer is `null` and the caller refuses
 * `notify.price_source_unavailable`. It never falls back to another side, because an alert on the bid that fired on the last
 * would fire on a price the person did not choose.
 */
export function priceFromTickerSource(
  body: TickerRow,
  source: AlertPriceSource,
): { price: string; quality: 'mid' | 'last' | 'bid' | 'ask' } | null {
  if (source === 'mark') return priceFromTicker(body);
  const raw = body[source];
  if (typeof raw !== 'string' || !isValidPositivePrice(raw)) return null;
  return { price: raw.trim(), quality: source };
}

/**
 * Build a live MarkSource that reads trade's public REST.
 *
 * Callers only construct this when a base URL is configured. Unset URL stays on
 * the dark port in `index.ts` so a deployment without trade does not claim live.
 */
export function createTradeHttpMarkSource(options: TradeHttpMarkOptions): MarkSource {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const marketCacheMs = options.marketCacheMs ?? 60_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  let symbolById: Map<string, string> | null = null;
  let symbolsLoadedAt = 0;

  async function loadSymbols(signal: AbortSignal): Promise<Map<string, string>> {
    const now = Date.now();
    if (symbolById && now - symbolsLoadedAt < marketCacheMs) return symbolById;

    const page = assertNotifyMarketsListLimit(options.marketsLimit);
    const res = await doFetch(`${base}/api/v1/markets?limit=${encodeURIComponent(String(page))}`, { signal });
    if (!res.ok) {
      throw new Error(`markets HTTP ${res.status}`);
    }
    const body = (await res.json()) as MarketRow[];
    const map = new Map<string, string>();
    if (Array.isArray(body)) {
      for (const row of body) {
        if (typeof row?.id === 'string' && typeof row?.symbol === 'string' && row.id && row.symbol) {
          map.set(row.id, row.symbol);
        }
      }
    }
    symbolById = map;
    symbolsLoadedAt = now;
    return map;
  }

  return {
    kind: 'live',
    async quote(marketId: string, at?: Date, source: AlertPriceSource = 'mark'): Promise<MarkQuote> {
      const now = at ?? new Date();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let symbol: string | undefined;
        try {
          const map = await loadSymbols(controller.signal);
          symbol = map.get(marketId);
        } catch (err) {
          if (err instanceof NotifyMarketsListLimitUnsetError) {
            return {
              kind: 'unavailable',
              reason: 'refused',
              detail: NOTIFY_MARKETS_LIST_LIMIT_UNSET,
            };
          }
          return {
            kind: 'unavailable',
            reason: 'refused',
            detail: 'trade markets list unreachable — refuse rather than invent',
          };
        }
        if (!symbol) {
          return {
            kind: 'unavailable',
            reason: 'refused',
            detail: `no trade market for id ${marketId}`,
          };
        }

        const path = `${base}/api/v1/ticker/${encodeURIComponent(symbol)}`;
        let res: Response;
        try {
          res = await doFetch(path, { signal: controller.signal });
        } catch {
          return {
            kind: 'unavailable',
            reason: 'refused',
            detail: 'trade ticker unreachable — refuse rather than invent',
          };
        }
        if (!res.ok) {
          return {
            kind: 'unavailable',
            reason: 'refused',
            detail: `trade ticker HTTP ${res.status}`,
          };
        }

        let body: TickerRow | null;
        try {
          body = (await res.json()) as TickerRow | null;
        } catch {
          return {
            kind: 'unavailable',
            reason: 'refused',
            detail: 'trade ticker body unreadable',
          };
        }

        // JSON null is a 200 body. res.json() does not throw, and body.bid would.
        const priced = body === null ? null : priceFromTickerSource(body, source);
        if (body !== null && !priced && source !== 'mark') {
          return { kind: 'unavailable', reason: 'refused', detail: NOTIFY_PRICE_SOURCE_UNAVAILABLE };
        }
        if (body === null || !priced) {
          return {
            kind: 'unavailable',
            reason: 'stale',
            detail: 'trade ticker has no usable bid/ask/last',
          };
        }

        // Missing timestamp → "we just fetched this" (now). A present timestamp
        // that is older than the bank marking window is stale, not a price.
        const quotedAt = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) ? new Date(body.timestamp) : now;

        return refuseIfMarkAged({ kind: 'ok', price: priced.price, at: quotedAt }, now);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

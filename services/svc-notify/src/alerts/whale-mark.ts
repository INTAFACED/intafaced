/**
 * Whale flow mark — a sourced volume decimal, never a price print.
 *
 * Price / funding / liq share the ticker mid/last. Reusing that number as
 * "whale flow" would invent volume. This port quotes trade ticker
 * quoteVolume/baseVolume when the operator allow-lists the market, and stays
 * dark otherwise. Missing volume refuses — never `'0'`, never a leftover cache.
 *
 * `kind: 'live'` is claimed only by `createTradeHttpWhaleMarkSource`, and only
 * when a TRADE_URL and a non-empty allow-list both exist. The entrypoint must
 * not hardcode live.
 */

import { refuseIfMarkAged } from './accepted-mark.js';
import { isValidPositivePrice } from './decimal.js';
import { assertNotifyMarketsListLimit, NOTIFY_MARKETS_LIST_LIMIT_UNSET, NotifyMarketsListLimitUnsetError } from './trade-http-mark.js';
import type { MarkQuote, MarkSource } from './types.js';

export type TradeHttpWhaleMarkOptions = {
  readonly baseUrl: string;
  /** Market ids that may quote a flow. Empty → caller must keep the dark port. */
  readonly allowlist: readonly string[];
  /**
   * Owner-published page size for `GET /api/v1/markets?limit=` (1..500).
   * Unset refuses named — never invent 50, never fetch without `?limit=`.
   */
  readonly marketsLimit?: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly marketCacheMs?: number;
};

type MarketRow = {
  readonly id?: string;
  readonly symbol?: string;
};

type TickerRow = {
  readonly quoteVolume?: string | null;
  readonly baseVolume?: string | null;
  readonly timestamp?: number | null;
};

/**
 * Operator allow-list. Blank / unset → no market may quote a flow.
 * Membership is exact marketId match — never a wildcard, never "all".
 */
export function parseWhaleFlowAllowlist(raw: string | undefined | null): readonly string[] {
  if (raw == null) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Prefer quoteVolume, else baseVolume. Never invent zero or empty. */
export function flowFromTicker(body: TickerRow): string | null {
  if (body.quoteVolume && isValidPositivePrice(body.quoteVolume)) {
    return body.quoteVolume.trim();
  }
  if (body.baseVolume && isValidPositivePrice(body.baseVolume)) {
    return body.baseVolume.trim();
  }
  return null;
}

/** Production default: no flow series. Evaluate refuses `alerts.whale_mark_dark`. */
export function createDarkWhaleMarkSource(): MarkSource {
  return {
    kind: 'dark',
    async quote(): Promise<MarkQuote> {
      return {
        kind: 'unavailable',
        reason: 'dark',
        detail: 'whale mark is dark — refuse rather than invent flow',
      };
    },
  };
}

/**
 * Live whale mark from trade public REST volume, gated by allow-list.
 *
 * Callers only construct this when TRADE_URL is set AND the allow-list is
 * non-empty. A market not on the list still quotes unavailable — membership
 * is not a flow number.
 */
export function createTradeHttpWhaleMarkSource(options: TradeHttpWhaleMarkOptions): MarkSource {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const marketCacheMs = options.marketCacheMs ?? 60_000;
  const base = options.baseUrl.replace(/\/+$/, '');
  const allow = new Set(options.allowlist);

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
    async quote(marketId: string, at?: Date): Promise<MarkQuote> {
      const now = at ?? new Date();
      if (!allow.has(marketId)) {
        return {
          kind: 'unavailable',
          reason: 'dark',
          detail: 'market not on whale flow allow-list — refuse rather than invent flow',
        };
      }
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
            detail: 'trade markets list unreachable — refuse rather than invent flow',
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
            detail: 'trade ticker unreachable — refuse rather than invent flow',
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

        // JSON null is a 200 body. res.json() does not throw, and body.quoteVolume would.
        const flow = body === null ? null : flowFromTicker(body);
        if (body === null || !flow) {
          return {
            kind: 'unavailable',
            reason: 'stale',
            detail: 'trade ticker has no usable quoteVolume/baseVolume',
          };
        }

        const quotedAt = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) ? new Date(body.timestamp) : now;
        return refuseIfMarkAged({ kind: 'ok', price: flow, at: quotedAt }, now);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

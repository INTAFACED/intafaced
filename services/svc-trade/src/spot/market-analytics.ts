/**
 * Market analytics (SP-markets-data-03 b; J-cex-spot-14 #9): the aggressor differential and window stats for one pair,
 * computed on read from the public trade tape the same `/api/v1/trades/:symbol` publishes. Nothing is stored and no
 * second book is kept: a retry for the same window returns the same figures for the same prints.
 *
 *   GET /api/v1/analytics/:symbol?window=5m|1h|24h
 *
 * The window is named by the caller from a fixed list and echoed back; a blank window refuses
 * (`trade.analytics_window_unset`), an unknown one refuses (`trade.analytics_window_invalid`). The tape's print side is
 * the taker's, so a buy print is buy-initiated. When the window holds more prints than one read returns, the answer
 * says so (`complete: false`, with the earliest print it covers: the newest prints are read first), never extrapolates.
 */
import type { FastifyInstance } from 'fastify';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { badRequest, badSymbol } from '../ccxt-errors.js';
import { publicRead } from '../route-inventory.js';
import type { Market, PublicTapePrint } from './types.js';

export const ANALYTICS_WINDOWS = { '5m': 5 * 60_000, '1h': 60 * 60_000, '24h': 24 * 60 * 60_000 } as const;
export type AnalyticsWindow = keyof typeof ANALYTICS_WINDOWS;
export const TRADE_ANALYTICS_WINDOW_UNSET = 'trade.analytics_window_unset';
export const TRADE_ANALYTICS_WINDOW_INVALID = 'trade.analytics_window_invalid';
/** The most prints one analytics read takes from the tape. */
export const ANALYTICS_MAX_PRINTS = 500; // the public tape's own published cap (PUBLIC_TAPE_LIMIT_MAX)

export interface MarketAnalytics {
  readonly symbol: string;
  readonly window: AnalyticsWindow;
  readonly windowMs: number;
  readonly from: string;
  readonly to: string;
  readonly trades: number;
  readonly buyTrades: number;
  readonly sellTrades: number;
  /** Base quantity bought by takers (buy-initiated). */
  readonly buyVolume: string;
  /** Base quantity sold by takers (sell-initiated). */
  readonly sellVolume: string;
  /** buyVolume minus sellVolume: positive when buyers were the aggressors. */
  readonly aggressorDifferential: string;
  readonly quoteVolume: string;
  readonly high: string | null;
  readonly low: string | null;
  readonly last: string | null;
  /** False when the window held more prints than one read takes: the figures cover `coveredFrom` to `to` only. */
  readonly complete: boolean;
  readonly coveredFrom: string | null;
}

export function parseAnalyticsWindow(raw: unknown): { ok: true; window: AnalyticsWindow } | { ok: false; code: string; message: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: false, code: TRADE_ANALYTICS_WINDOW_UNSET, message: 'analytics window is unset: name one of 5m, 1h, 24h' };
  if (!Object.hasOwn(ANALYTICS_WINDOWS, text)) {
    return { ok: false, code: TRADE_ANALYTICS_WINDOW_INVALID, message: `analytics window ${text} is not one of 5m, 1h, 24h` };
  }
  return { ok: true, window: text as AnalyticsWindow };
}

/** The figures for `prints` (newest first or any order) inside [nowMs - window, nowMs]. */
export function computeAnalytics(
  symbol: string,
  window: AnalyticsWindow,
  prints: readonly PublicTapePrint[],
  nowMs: number,
  complete: boolean,
): MarketAnalytics {
  const windowMs = ANALYTICS_WINDOWS[window];
  const fromMs = nowMs - windowMs;
  const inside = prints.filter((p) => p.ts.getTime() >= fromMs && p.ts.getTime() <= nowMs);
  let buy: Amount = 0n;
  let sell: Amount = 0n;
  let quote: Amount = 0n;
  let buyTrades = 0;
  let high: Amount | null = null;
  let low: Amount | null = null;
  let last: PublicTapePrint | null = null;
  let earliest: number | null = null;
  for (const p of inside) {
    if (p.side === 'buy') {
      buy += p.qty;
      buyTrades += 1;
    } else sell += p.qty;
    quote += p.quoteAmount;
    if (high === null || p.price > high) high = p.price;
    if (low === null || p.price < low) low = p.price;
    if (last === null || p.ts.getTime() > last.ts.getTime() || (p.ts.getTime() === last.ts.getTime() && p.sequence > last.sequence))
      last = p;
    if (earliest === null || p.ts.getTime() < earliest) earliest = p.ts.getTime();
  }
  return {
    symbol,
    window,
    windowMs,
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    trades: inside.length,
    buyTrades,
    sellTrades: inside.length - buyTrades,
    buyVolume: formatAmount(buy),
    sellVolume: formatAmount(sell),
    aggressorDifferential: formatAmount(buy - sell),
    quoteVolume: formatAmount(quote),
    high: high === null ? null : formatAmount(high),
    low: low === null ? null : formatAmount(low),
    last: last === null ? null : formatAmount(last.price),
    complete,
    coveredFrom: complete ? new Date(fromMs).toISOString() : earliest === null ? null : new Date(earliest).toISOString(),
  };
}

export function registerMarketAnalyticsRoute(
  app: FastifyInstance,
  deps: {
    readonly marketBySymbol: (symbol: string) => Promise<Market | null>;
    readonly publicTape: (marketId: string, limit: number, sinceMs?: number) => Promise<PublicTapePrint[]>;
    readonly now: () => Date;
  },
): void {
  app.get<{ Params: { symbol: string }; Querystring: { window?: string } }>('/api/v1/analytics/:symbol', publicRead, async (req, reply) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const market = await deps.marketBySymbol(symbol);
    if (!market) {
      const refusal = badSymbol(symbol);
      return reply.code(refusal.status).send(refusal.body);
    }
    const parsed = parseAnalyticsWindow(req.query.window);
    if (!parsed.ok) {
      const refusal = badRequest(parsed.message, parsed.code);
      return reply.code(refusal.status).send(refusal.body);
    }
    const nowMs = deps.now().getTime();
    const prints = await deps.publicTape(market.id, ANALYTICS_MAX_PRINTS, nowMs - ANALYTICS_WINDOWS[parsed.window]);
    return reply.code(200).send(computeAnalytics(market.symbol, parsed.window, prints, nowMs, prints.length < ANALYTICS_MAX_PRINTS));
  });
}

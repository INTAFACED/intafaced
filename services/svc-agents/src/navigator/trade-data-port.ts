/**
 * Live trade public REST samples for navigator Stage-2 data tools.
 *
 * Production leave unset: live `trade.quote` / `trade.markets.list` on a dark
 * plane or without fixtures refuse honestly — never invented mids or listings.
 */

import { AgentError } from '../errors.js';
import type { MarketListFixture, QuoteFixture } from './data-tools.js';

export type NavigatorTradeDataPort = {
  /**
   * Grounded live market rows. Empty array is empty — never invented listings.
   * HTTP trade client requires owner-published `limit` (query `?limit=`).
   */
  listMarkets(limit?: number): Promise<readonly MarketListFixture[]>;
  quote(marketId: string): Promise<QuoteFixture | null>;
};

export type LiveNavigatorMarkets =
  | { readonly ok: true; readonly markets: readonly MarketListFixture[] }
  | { readonly ok: false; readonly reason: 'no_live_markets' }
  | { readonly ok: false; readonly reason: 'markets_limit_unset' };

export type LiveNavigatorQuote =
  { readonly ok: true; readonly quote: QuoteFixture } | { readonly ok: false; readonly reason: 'no_live_quote' };

export async function readLiveNavigatorMarkets(port: NavigatorTradeDataPort | undefined, limit?: number): Promise<LiveNavigatorMarkets> {
  if (port === undefined) {
    return { ok: false, reason: 'no_live_markets' };
  }
  try {
    const markets = await port.listMarkets(limit);
    if (!Array.isArray(markets) || markets.length === 0) {
      return { ok: false, reason: 'no_live_markets' };
    }
    return { ok: true, markets };
  } catch (err) {
    if (err instanceof AgentError && err.code === 'agents.navigator_markets_limit_unset') {
      return { ok: false, reason: 'markets_limit_unset' };
    }
    return { ok: false, reason: 'no_live_markets' };
  }
}

export async function readLiveNavigatorQuote(port: NavigatorTradeDataPort | undefined, marketId: string): Promise<LiveNavigatorQuote> {
  if (port === undefined || !marketId.trim()) {
    return { ok: false, reason: 'no_live_quote' };
  }
  try {
    const quote = await port.quote(marketId);
    if (
      quote === null ||
      !quote.marketId.trim() ||
      quote.marketId !== marketId ||
      quote.last === null ||
      quote.last.trim() === ''
    ) {
      return { ok: false, reason: 'no_live_quote' };
    }
    return { ok: true, quote };
  } catch {
    return { ok: false, reason: 'no_live_quote' };
  }
}

/**
 * Live placeIocMarketBuy: public orderbook, then an internal HMAC place.
 *
 * USER REST `POST /api/v1/orders` is the wrong door (looks like a customer
 * order). Matching HMAC `POST /markets/:marketId/orders` is published only
 * for svc-trade / svc-execution / svc-fix — svc-token is unmapped. Trade has
 * no `/internal/orders`. Non-empty book therefore refuses unpublished
 * (`token.buyback_job_unset`) instead of posting the user door or inventing
 * a fill from depth. Empty asks → filledQty 0 (`token.buyback_book_empty`).
 * Unset symbol / unreachable orderbook is `token.buyback_job_unset`.
 */
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { sizeIocBuyFromAsks } from './economics/buyback.js';
import { TokenError } from './token-service.js';
import type { BuybackPlaceFill } from './buyback-job.js';

/**
 * Whether the trade service publishes the signed IOC place this client needs.
 * It does not yet: every place below refuses. Flip only with that place wired.
 */
export const BUYBACK_PLACE_PUBLISHED = false;

export interface TradeIocMarketBuyOpts {
  readonly tradeUrl: string;
  readonly symbol: string;
  readonly internalSecret: string;
}

export function createTradeIocMarketBuy(
  opts: TradeIocMarketBuyOpts,
): (input: { quoteBudget: Amount; clientOrderId: string }) => Promise<BuybackPlaceFill> {
  const url = opts.tradeUrl.replace(/\/$/, '');
  const symbol = opts.symbol.trim();

  return async ({ quoteBudget, clientOrderId }) => {
    if (!symbol) {
      throw new TokenError('BUYBACK_SYMBOL is unset — refusing to invent a listing', 'token.buyback_job_unset');
    }

    const bookUrl = `${url}/api/v1/orderbook/${encodeURIComponent(symbol)}`;
    let bookRes: Response;
    try {
      bookRes = await fetch(bookUrl);
    } catch (err) {
      throw new TokenError(`svc-trade orderbook unreachable: ${(err as Error).message}`, 'token.buyback_job_unset');
    }
    if (!bookRes.ok) {
      throw new TokenError(`svc-trade orderbook failed (${bookRes.status})`, 'token.buyback_job_unset');
    }

    const body = (await bookRes.json()) as { asks?: unknown };
    const asksRaw = Array.isArray(body.asks) ? body.asks : [];
    const asks: Array<{ price: Amount; qty: Amount }> = [];
    for (const row of asksRaw) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') continue;
      try {
        const price = parseAmount(row[0]);
        const qty = parseAmount(row[1]);
        if (price > 0n && qty > 0n) asks.push({ price, qty });
      } catch {
        // Skip a malformed level rather than invent a price.
      }
    }

    const qty = sizeIocBuyFromAsks(asks, quoteBudget);
    if (qty <= 0n) return { filledQty: 0n };

    if (!opts.internalSecret.trim()) {
      throw new TokenError('INTERNAL_SERVICE_SECRET is unset — refusing buyback place', 'token.buyback_job_unset');
    }

    throw new TokenError(
      `Buyback IOC place is unpublished for svc-token (clientOrderId=${clientOrderId}) — refusing USER REST POST /api/v1/orders; matching HMAC PLACE is not published for this caller`,
      'token.buyback_job_unset',
    );
  };
}

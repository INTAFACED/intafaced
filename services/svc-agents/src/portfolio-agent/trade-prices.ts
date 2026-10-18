/**
 * Prices from svc-trade's public ticker, the same read svc-bank marks loans
 * against: mid of a two-sided quote, otherwise last. No import of svc-trade.
 * A missing, zero, or unusable quote is null — never "0".
 */

import { formatAmount, isNegative, isZero, parseAmount } from '@intafaced/ledger-client';
import type { PortfolioPriceSource } from './holdings.js';

export type TradeTickerPricesOptions = {
  readonly baseUrl: string;
  readonly quoteAssetId: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

type TickerResponse = {
  readonly bid?: string | null;
  readonly ask?: string | null;
  readonly last?: string | null;
};

function usable(raw: string | null | undefined): bigint | null {
  if (!raw) return null;
  try {
    const amount = parseAmount(raw.trim());
    if (isZero(amount) || isNegative(amount)) return null;
    return amount;
  } catch {
    return null;
  }
}

export function tradeTickerPrices(options: TradeTickerPricesOptions): PortfolioPriceSource {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const quote = options.quoteAssetId.trim();

  return {
    async price(assetId: string): Promise<string | null> {
      if (quote.length === 0) return null;
      if (assetId === quote) return '1';
      const symbol = encodeURIComponent(`${assetId}/${quote}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${options.baseUrl}/api/v1/ticker/${symbol}`, { signal: controller.signal });
        if (!res.ok) return null;
        const body = (await res.json()) as TickerResponse;
        const bid = usable(body.bid);
        const ask = usable(body.ask);
        if (bid !== null && ask !== null) {
          const mid = (bid + ask) / 2n;
          if (mid > 0n) return formatAmount(mid);
        }
        const last = usable(body.last);
        return last === null ? null : formatAmount(last);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

import type { FastifyInstance } from 'fastify';
import type { FundingRateEntry } from './funding-rate-source.js';
import type { FuturesMarkProvenance } from './mark-policy.js';
import { MARK_HISTORY_UNAVAILABLE, type FuturesTickerFacts } from './futures-reads.js';
import { publicRead } from '../route-inventory.js';

interface FuturesTickerMarket {
  readonly id: string;
  readonly symbol: string;
  readonly kind: string;
}

export interface FuturesTickerRestDeps {
  marketBySymbol(symbol: string): Promise<FuturesTickerMarket | null>;
  markForMarket(marketId: string, symbol: string): Promise<{ price: string; source: FuturesMarkProvenance } | null>;
  fundingForMarket(marketId: string): FundingRateEntry | null;
  /**
   * The end of the funding period open now, on the owner's grid (J-derivatives-08 #1). A computed rate is for a period
   * that has CLOSED, so its own end is in the past and is not the next funding time. Omitted or null: the published
   * entry's period end, as before.
   */
  nextFundingTimeFor?(marketId: string): Promise<string | null>;
  /** Stored aggregates. The route copies them. It does not invent a sum or a change. */
  factsForMarket(marketId: string, nowMs: number): Promise<FuturesTickerFacts>;
  now?: () => number;
}

/** Public futures strip. Missing market facts stay null; this route never synthesises ticks or cadence. */
export function registerFuturesTickerRest(app: FastifyInstance, deps: FuturesTickerRestDeps): void {
  app.get<{ Querystring: { symbol?: string } }>('/api/v1/futures/ticker', publicRead, async (req, reply) => {
    const symbol = req.query.symbol?.trim();
    if (!symbol) {
      return reply.code(400).send({ error: 'trade.futures_ticker_symbol_required', message: 'symbol is required' });
    }

    const market = await deps.marketBySymbol(symbol);
    if (!market) {
      return reply.code(404).send({ error: 'trade.futures_ticker_market_unknown', message: `unknown market ${symbol}` });
    }
    if (market.kind !== 'futures') {
      return reply.code(400).send({ error: 'trade.futures_ticker_spot_market', message: `${market.symbol} is not a futures market` });
    }

    const at = deps.now?.() ?? Date.now();
    const [mark, funding, facts, nextOnGrid] = await Promise.all([
      deps.markForMarket(market.id, market.symbol),
      Promise.resolve(deps.fundingForMarket(market.id)),
      deps.factsForMarket(market.id, at),
      deps.nextFundingTimeFor ? deps.nextFundingTimeFor(market.id) : Promise.resolve(null),
    ]);
    const change24h = facts.change24h;
    return reply.code(200).send({
      markPrice: mark?.price ?? null,
      markSource: mark?.source ?? null,
      fundingRate: funding?.rate ?? null,
      fundingPeriodId: funding?.periodId ?? null,
      nextFundingTime: funding ? (nextOnGrid ?? funding.periodEndIso ?? null) : null,
      openInterest: facts.openInterest,
      volume24h: facts.volume24h,
      change24h,
      changeReason: change24h == null ? (facts.changeReason ?? MARK_HISTORY_UNAVAILABLE) : null,
    });
  });
}

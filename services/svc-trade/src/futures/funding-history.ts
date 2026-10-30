/**
 * Historical funding rates for a perpetual (MKT-0082, MKT-0085, MKT-0105, MKT-0106).
 *
 * A spot symbol is refused by name. A symbol that is not a perpetual is HTTP 400
 * and returns no rate list. A perpetual with no published rate is refused and
 * the body has no fundingRate. Rows are sorted ascending by period time.
 * There is no page cap: this route's source publishes none.
 * mark_price is the risk mark stored with the row. This file does not copy a
 * last trade into a missing mark.
 */
import type { FastifyInstance } from 'fastify';
import { datedFuturesStyleOf } from './dated-futures.js';
import { publicRead } from '../route-inventory.js';

export interface FundingHistoryListing {
  readonly id: string;
  readonly symbol: string;
  readonly kind: 'spot' | 'futures' | 'options';
  readonly futuresContractStyle?: 'perpetual' | 'dated' | null;
}

export interface FundingHistoryRow {
  readonly marketId: string;
  readonly periodId: string;
  readonly periodTimestamp: number;
  readonly fundingRate: string;
  readonly markPrice: string | null;
  /** The two approvers of the publish (RC-derivatives-01), kept for audit. Absent on rows from before it. */
  readonly approverIds?: readonly string[];
}

export interface FundingHistoryStore {
  record(row: FundingHistoryRow): void;
  /** Null when this market has never had a published rate. */
  list(marketId: string): readonly FundingHistoryRow[] | null;
}

export function memoryFundingHistory(): FundingHistoryStore {
  const byMarket = new Map<string, FundingHistoryRow[]>();
  return {
    record(row) {
      const rows = byMarket.get(row.marketId) ?? [];
      const key = `${row.periodId}\n${row.fundingRate}`;
      if (rows.some((existing) => `${existing.periodId}\n${existing.fundingRate}` === key)) return;
      rows.push(row);
      byMarket.set(row.marketId, rows);
    },
    list(marketId) {
      const rows = byMarket.get(marketId);
      return rows ? [...rows] : null;
    },
  };
}

export interface PresentedFundingHistory {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function refusal(status: number, code: string, message: string, intafacedCode: string): PresentedFundingHistory {
  return { status, body: { code, message, intafacedCode } };
}

export function presentFundingHistory(input: {
  readonly symbol: string;
  readonly market: FundingHistoryListing | null;
  readonly rows: readonly FundingHistoryRow[] | null;
}): PresentedFundingHistory {
  const market = input.market;
  if (!market) {
    return refusal(400, 'BadRequest', `market ${input.symbol} not found`, 'trade.market_not_found');
  }
  if (market.kind === 'spot') {
    return refusal(400, 'BadRequest', `${market.symbol} is a spot market and has no funding rate`, 'trade.funding_rate_spot_market');
  }
  if (datedFuturesStyleOf(market) !== 'perpetual') {
    const intafacedCode = market.kind === 'futures' ? 'trade.funding_rate_unavailable' : 'trade.not_futures_market';
    return refusal(400, 'BadRequest', `${market.symbol} is not a perpetual — historical funding rates are refused`, intafacedCode);
  }
  if (input.rows == null || input.rows.length === 0) {
    return refusal(501, 'NotSupported', `no published funding rate for ${market.symbol}`, 'trade.funding_rate_unavailable');
  }
  const rates = [...input.rows]
    .sort((a, b) => (a.periodTimestamp < b.periodTimestamp ? -1 : a.periodTimestamp > b.periodTimestamp ? 1 : 0))
    .map((row) => ({
      periodId: row.periodId,
      periodTimestamp: row.periodTimestamp,
      fundingRate: row.fundingRate,
      mark_price: row.markPrice,
    }));
  return { status: 200, body: { symbol: market.symbol, rates } };
}

export interface FundingHistoryDeps {
  marketBySymbol: (symbol: string) => Promise<FundingHistoryListing | null>;
  historyForMarket: (marketId: string) => Promise<readonly FundingHistoryRow[] | null>;
}

export function registerFundingHistory(app: FastifyInstance, deps: FundingHistoryDeps): void {
  app.get<{ Params: { symbol: string } }>('/api/v1/funding-history/:symbol', publicRead, async (req, reply) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const market = await deps.marketBySymbol(symbol);
    let rows: readonly FundingHistoryRow[] | null = null;
    if (market && market.kind === 'futures' && datedFuturesStyleOf(market) === 'perpetual') {
      try {
        rows = await deps.historyForMarket(market.id);
      } catch {
        rows = null;
      }
    }
    const presented = presentFundingHistory({ symbol, market, rows });
    return reply.code(presented.status).send(presented.body);
  });
}

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
  /** Computed periods only (D-instruments-01): what the rate was built from. Absent on S2S-published rows. */
  readonly premium?: string | null;
  readonly interestComponent?: string | null;
  readonly cap?: string | null;
  readonly annualisedRate?: string | null;
  readonly indexPrice?: string | null;
  /** The period's legs once the funding tick settled it: what payers paid and receivers received. Null until then. */
  readonly settlement?: FundingSettlementTotals | null;
}

export interface FundingSettlementTotals {
  readonly legs: number;
  readonly paid: string;
  readonly received: string;
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
      index_price: row.indexPrice ?? null,
      premium: row.premium ?? null,
      interestComponent: row.interestComponent ?? null,
      cap: row.cap ?? null,
      annualisedRate: row.annualisedRate ?? null,
      settlement: row.settlement ?? null,
    }));
  return { status: 200, body: { symbol: market.symbol, rates } };
}

export interface FundingSeriesPoint {
  readonly at: string;
  readonly mark: string | null;
  readonly index: string | null;
  /** Why the index is null at this point (the sampler's reason); null when there is an index. */
  readonly indexReason: string | null;
}

export interface FundingHistoryDeps {
  marketBySymbol: (symbol: string) => Promise<FundingHistoryListing | null>;
  historyForMarket: (marketId: string) => Promise<readonly FundingHistoryRow[] | null>;
  /** The latest `limit` mark and index samples of a market, oldest first. Omitted: the series route is not mounted. */
  seriesForMarket?: (marketId: string, limit: number) => Promise<readonly FundingSeriesPoint[]>;
}

/** The index part of a sample's gap reason (`mark_unavailable+trade.index_params_unset` → the index code). */
export function indexReasonOf(index: string | null, gapReason: string | null): string | null {
  if (index !== null) return null;
  const parts = (gapReason ?? '').split('+').filter((r) => r !== '' && r !== 'mark_unavailable');
  return parts.length > 0 ? parts.join('+') : 'trade.index_not_recorded';
}

export const SERIES_LIMIT_UNSET = 'trade.series_limit_unset';

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

  const series = deps.seriesForMarket;
  if (!series) return;
  /**
   * GET /api/v1/funding-index-history/:symbol?limit=N — the mark and index series the funding rate is sampled from,
   * oldest first (J-derivatives-08 #6). An unpublished index is a null point with its reason, never a number. `limit`
   * (1–1000) is required: this route does not invent a page size.
   */
  app.get<{ Params: { symbol: string }; Querystring: { limit?: string } }>(
    '/api/v1/funding-index-history/:symbol',
    publicRead,
    async (req, reply) => {
      const symbol = decodeURIComponent(req.params.symbol);
      const market = await deps.marketBySymbol(symbol);
      if (!market) return reply.code(400).send(refusal(400, 'BadRequest', `market ${symbol} not found`, 'trade.market_not_found').body);
      if (market.kind !== 'futures' || datedFuturesStyleOf(market) !== 'perpetual') {
        return reply
          .code(400)
          .send(
            refusal(400, 'BadRequest', `${market.symbol} is not a perpetual and has no funding index`, 'trade.not_futures_market').body,
          );
      }
      const raw = req.query.limit;
      const limit = raw == null || !/^\d+$/.test(raw) ? NaN : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return reply
          .code(400)
          .send(refusal(400, 'BadRequest', 'limit is required (1–1000); this series does not invent a page size', SERIES_LIMIT_UNSET).body);
      }
      return reply.code(200).send({ symbol: market.symbol, series: await series(market.id, limit) });
    },
  );
}

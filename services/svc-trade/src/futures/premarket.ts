/**
 * Pre-market futures (D-instruments-03).
 *
 * A pre-market contract is a futures market whose listing status is `pending` (the prelaunch state the order
 * path already refuses: `trade.market_prelaunch`, see spot/market-prelaunch-place.ts). Two owner numbers apply
 * to it: a flat funding rate and a mark clamp band. They are owner publications, versioned per market, and
 * they have no default: no row, or a null field, is blank and refuses `trade.premarket_params_unset`.
 *
 * This file stores and reads the numbers. Nothing here posts to the ledger, accrues funding or clamps a mark.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { TradeError, type Market } from '../spot/types.js';

export const PREMARKET_PARAMS_UNSET = 'trade.premarket_params_unset' as const;

export interface PremarketParams {
  readonly version: string;
  /** Signed decimal string, per funding period, in the same units as a published period rate. Null = blank. */
  readonly flatFundingRate: string | null;
  /** Mark clamp band in basis points (positive integer). Null = blank. */
  readonly markClampBps: number | null;
}

/** The customer "Pre-market" label: a futures market that is still prelaunch (`pending`). */
export function isPremarket(market: Pick<Market, 'kind' | 'status'>): boolean {
  return market.kind === 'futures' && market.status === 'pending';
}

interface ParamsRow {
  version: string;
  flat_funding_rate: string | null;
  mark_clamp_bps: number | null;
}

/** Latest owner pre-market params for a market, or null when none was ever set. */
export async function readPremarketParams(sql: Sql, marketId: string): Promise<PremarketParams | null> {
  const [row] = await sql<ParamsRow[]>`
    SELECT version::text AS version, flat_funding_rate::text AS flat_funding_rate, mark_clamp_bps
      FROM trade.operator_premarket_params
     WHERE market_id = ${marketId}
     ORDER BY version DESC
     LIMIT 1`;
  if (!row) return null;
  return {
    version: row.version,
    flatFundingRate: row.flat_funding_rate === null ? null : formatAmount(parseAmount(row.flat_funding_rate)),
    markClampBps: row.mark_clamp_bps,
  };
}

/** Both owner numbers must be present. Returns them narrowed, or throws `trade.premarket_params_unset`. */
export function requirePremarketParams(
  params: PremarketParams | null,
  symbol: string,
): { readonly version: string; readonly flatFundingRate: string; readonly markClampBps: number } {
  if (params === null || params.flatFundingRate === null || params.markClampBps === null) {
    throw new TradeError(
      `${symbol} has no owner pre-market params (flat funding rate and mark clamp band); blank stays blank, so conversion is refused`,
      PREMARKET_PARAMS_UNSET,
    );
  }
  return { version: params.version, flatFundingRate: params.flatFundingRate, markClampBps: params.markClampBps };
}

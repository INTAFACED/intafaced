/**
 * Spot grid bot errors (CB-bots-02, CB-bots-10; J-copy-bots-otc-14).
 *
 * Codes are the spec's where it names one (CB-bots-02: `trade.bots_grid_bounds_not_set`,
 * `trade.bots_grid_count_out_of_range`; CB-bots-10: `trade.bots_verification_*`; CB-bots-05: `trade.bots_withdraw_cap_unset`,
 * `trade.bots_withdraw_cap_exceeded`). A refusal that names a field
 * names it in its message ("Lower price is required"), which the wire carries with the code. Codes are stable for wire mapping.
 */

export type GridErrorCode =
  | 'trade.bots_paused_by_platform'
  | 'trade.grid_request_key_invalid'
  | 'trade.grid_request_conflict'
  | 'trade.grid_market_not_found'
  | 'trade.grid_market_not_spot'
  | 'trade.bots_grid_bounds_not_set'
  | 'trade.bots_grid_bounds_band_not_set'
  | 'trade.bots_grid_bounds_out_of_band'
  | 'trade.grid_investment_required'
  | 'trade.grid_count_required'
  | 'trade.grid_bounds_inverted'
  | 'trade.grid_count_range_not_set'
  | 'trade.bots_grid_count_out_of_range'
  | 'trade.grid_spacing_below_tick'
  | 'trade.grid_level_below_minimum'
  | 'trade.grid_mark_unavailable'
  | 'trade.grid_reserve_exceeds_balance'
  | 'trade.grid_initialization_failed'
  | 'trade.grid_not_found'
  | 'trade.grid_not_running'
  | 'trade.grid_unavailable'
  | 'trade.bots_withdraw_amount_invalid'
  | 'trade.bots_withdraw_asset_mismatch'
  | 'trade.bots_withdraw_cap_unset'
  | 'trade.bots_withdraw_cap_exceeded'
  | 'trade.bots_withdraw_exceeds_profit'
  | 'trade.bots_withdraw_exceeds_balance'
  | 'trade.bots_withdraw_reserve_released'
  | 'trade.bots_withdraw_conflict'
  | 'trade.grid_request_invalid'
  | 'trade.grid_direction_not_built'
  | 'trade.grid_settlement_not_built'
  | 'trade.bots_grid_topup_amount_invalid'
  | 'trade.bots_grid_topup_quote_only'
  | 'trade.bots_grid_topup_exceeds_free'
  | 'trade.bots_grid_topup_conflict'
  | 'trade.bots_grid_trailing_shift_limit_required'
  | 'trade.bots_grid_trailing_shift_limit_invalid'
  | 'trade.bots_grid_min_count_invalid'
  | 'trade.bots_grid_min_count_above_count'
  | 'trade.bots_grid_trailing_not_built'
  | 'trade.bots_grid_rsi_source_not_set'
  | 'trade.bots_grid_exit_price_invalid'
  | 'trade.api_withdraw_not_allowed'
  // The venue grid (venue-grid.ts; J-copy-bots-otc-14 on the venue).
  | 'trade.bots_grid_wallet_required'
  | 'trade.bots_grid_agent_key_unset'
  | 'trade.bots_grid_builder_fee_unapproved'
  | 'trade.bots_grid_not_signing'
  | 'trade.bots_grid_venue_unreadable'
  | 'trade.bots_grid_withdraw_not_permitted';

/** Codes the tRPC door answers as NOT_FOUND / CONFLICT; every other grid code is BAD_REQUEST. */
export const GRID_NOT_FOUND_CODES: ReadonlySet<GridErrorCode> = new Set(['trade.grid_not_found', 'trade.grid_market_not_found']);
export const GRID_CONFLICT_CODES: ReadonlySet<GridErrorCode> = new Set([
  'trade.grid_request_conflict',
  'trade.grid_not_running',
  'trade.bots_withdraw_reserve_released',
  'trade.bots_withdraw_conflict',
  'trade.bots_grid_topup_conflict',
  'trade.bots_grid_not_signing',
]);

export class GridError extends Error {
  constructor(
    message: string,
    readonly code: GridErrorCode,
    readonly data?: Record<string, string>,
  ) {
    super(message);
    this.name = 'GridError';
  }
}

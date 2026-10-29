/**
 * OTC RFQ desk errors (trade.otc / D-S-02 Part A).
 *
 * Codes are stable for wire mapping — never invent rates to avoid a refuse.
 */

export type OtcErrorCode =
  | 'trade.otc_desk_law_blank'
  | 'trade.otc_stake_gate'
  | 'trade.otc_stake_unavailable'
  | 'trade.otc_no_reference_price'
  | 'trade.otc_invalid_qty'
  | 'trade.otc_invalid_price'
  | 'trade.otc_bad_spread'
  | 'trade.otc_quote_expired'
  | 'trade.otc_last_look_forbidden'
  | 'trade.otc_not_owner'
  | 'trade.otc_quote_missing'
  | 'trade.otc_already_settled'
  | 'trade.otc_settle_refused'
  | 'trade.convert_bounds_not_set'
  | 'trade.convert_out_of_bounds'
  | 'trade.convert_flow_side_refused'
  | 'trade.rfq_missing_size'
  | 'trade.rfq_size_not_set'
  | 'trade.rfq_below_minimum'
  | 'trade.rfq_missing_price'
  | 'trade.rfq_already_bound'
  | 'trade.rfq_window_passed'
  | 'trade.rfq_allocation_refused'
  | 'trade.rfq_give_up_refused'
  | 'trade.otc_makers_unset'
  | 'trade.otc_provider_required'
  | 'trade.otc_provider_cap'
  | 'trade.otc_provider_unknown'
  | 'trade.otc_assets_unset'
  | 'trade.otc_asset_unlisted'
  /** NotConnected (allowlisted blocker class): a provider routed to an outside venue the platform has no feed for. */
  | 'feed.market';

export class OtcError extends Error {
  constructor(
    message: string,
    readonly code: OtcErrorCode,
    readonly residual?: string,
  ) {
    super(message);
    this.name = 'OtcError';
  }
}

/** Customer text when OTC desk law is unpublished. Spec id stays in the server log. */
export const OTC_DESK_LAW_RESIDUAL = 'OTC quotes are not available yet: the spread, minimum stake, and counterparty are not set.';

export const RFQ_ALLOCATION_RESIDUAL = 'This request cannot be split across accounts yet: allocation rules are not set.';

export const RFQ_GIVE_UP_RESIDUAL = 'This request cannot be given up to another account yet: the clearing instructions are not set.';

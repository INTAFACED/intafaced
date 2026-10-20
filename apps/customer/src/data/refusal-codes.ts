/**
 * Which typed refusal codes mean what (UI-SPEC §4.3).
 *
 * The words customers read live in `refusals.ts`. This file only sorts service
 * codes into kinds, so it is the one place that names the raw codes (collected
 * from DATA-GAPS.md, EMPTY-AND-LOCKED-2026-10-13.md and the services' error maps:
 * svc-trade `ccxt-errors.ts`, svc-bank `router.ts`, svc-pay, svc-ledger, svc-edge).
 */

export type RefusalKind =
  | 'screening'
  | 'region'
  | 'verify'
  | 'convertSpreadUnset'
  | 'slippageCapUnset'
  | 'noBook'
  | 'insufficientDepth'
  | 'quoteFailed'
  | 'marketNotOpen'
  | 'insufficient'
  | 'destMissing'
  | 'recipientNoAccount'
  | 'signedOut'
  | 'stepUp'
  | 'mfaRequired'
  | 'pricesDown'
  | 'noPermission'
  | 'rateLimited'
  | 'tryAgain'
  | 'orderGone'
  | 'priceMoved'
  | 'quoteExpired'
  | 'amountInvalid'
  | 'priceInvalid'
  | 'belowMinimum'
  | 'selfTrade'
  | 'orderTypeUnsupported'
  | 'marketLimitOnly'
  | 'optionUnsupported'
  | 'requestExpired'
  | 'exitPriceOrder'
  | 'exitStopLimitMissing'
  | 'exitMissing'
  | 'exitsNotPlaced'
  | 'postOnlyWouldCross'
  | 'fokUnfillable'
  | 'tifInvalid'
  | 'ordersPaused'
  | 'accountOnHold'
  | 'notFound'
  | 'duplicate'
  | 'notSetUp'
  | 'walletPaused'
  | 'walletFee'
  | 'walletCap'
  | 'walletFields'
  | 'walletAddress'
  | 'addressLabelTaken'
  | 'addressBookFull'
  | 'activitySortBounded'
  | 'entriesDoNotSum'
  | 'entriesTooLong'
  | 'chartRange'
  | 'algoSchedulerOff'
  | 'unknown';

/** Exact codes first. */
const EXACT: Readonly<Record<string, RefusalKind>> = {
  'trade.convert_spread_unset': 'convertSpreadUnset',
  'trade.slippage_cap_unset': 'slippageCapUnset',
  'trade.no_book': 'noBook',
  'bank.dest_user_missing': 'destMissing',
  'bank.recipient_no_account': 'recipientNoAccount',

  'auth.required': 'signedOut',
  'trade.unauthenticated': 'signedOut',
  'bank.unauthenticated': 'signedOut',
  'pay.unauthenticated': 'signedOut',
  'identity.unauthenticated': 'signedOut',
  'token.expired': 'signedOut',
  'token.invalid': 'signedOut',
  'token.malformed': 'signedOut',
  'mfa.required': 'stepUp',
  'auth.mfa_required': 'mfaRequired',
  'bank.prices_unavailable': 'pricesDown',
  'scope.denied': 'noPermission',
  'ownership.denied': 'noPermission',
  'trade.permission_denied': 'noPermission',
  'trade.not_owner': 'noPermission',
  'bank.not_owner': 'noPermission',
  'tier.insufficient': 'verify',
  'trade.account_restricted': 'accountOnHold',
  'ledger.frozen': 'accountOnHold',
  'ledger.freeze': 'accountOnHold',
  'ledger.freeze_attributed': 'accountOnHold',
  'bank.space_locked': 'accountOnHold',

  'trade.rate_limited': 'rateLimited',
  'edge.rate_limited': 'rateLimited',
  'trade.matching_unavailable': 'tryAgain',
  'edge.gateway': 'tryAgain',
  'edge.upstream_unavailable': 'tryAgain',
  'edge.authority_unavailable': 'tryAgain',
  'edge.no_route': 'tryAgain',
  'edge.module_killed': 'tryAgain',
  'edge.kill_switch_undecidable': 'tryAgain',
  'ledger.unavailable': 'tryAgain',
  'bank.ledger_outcome_unknown': 'tryAgain',
  'bank.transfers_disabled': 'tryAgain',
  'pay.rail_outcome_unknown': 'tryAgain',

  'trade.order_not_found': 'orderGone',
  'trade.order_not_open': 'orderGone',
  'trade.convert_price_moved': 'priceMoved',
  'trade.price_not_accepted': 'priceMoved',
  'trade.convert_quote_expired': 'quoteExpired',
  'trade.convert_insufficient_depth': 'insufficientDepth',
  'trade.matching_market_missing': 'noBook',
  // A size the screen should never send (both or neither of qty and quoteQty): an internal mistake, not the customer's.
  'trade.convert_invalid_qty': 'quoteFailed',

  'ledger.insufficient_funds': 'insufficient',
  'market.insufficient_funds': 'insufficient',
  'trade.hold_uncovered': 'insufficient',
  'trade.insufficient_margin': 'insufficient',
  'trade.algo_insufficient_balance': 'insufficient',
  'trade.algo_balance_unreadable': 'tryAgain',
  'trade.fee_schedule_blank': 'notSetUp',
  'trade.fee_product_unpublished': 'notSetUp',
  // A maker rebate or a minimum fee the ledger has no recipe to post yet: not switched on, never shown as paid.
  'trade.rebate_recipe_unavailable': 'notSetUp',
  'trade.min_fee_recipe_unavailable': 'notSetUp',

  'trade.invalid_qty': 'amountInvalid',
  'trade.missing_qty': 'amountInvalid',
  'pay.invalid_amount': 'amountInvalid',
  'bank.ramp_invalid_amount': 'amountInvalid',
  'trade.min_qty_exceeds_qty': 'amountInvalid',
  'bank.below_minimum': 'belowMinimum',
  'trade.invalid_price': 'priceInvalid',
  'trade.missing_price': 'priceInvalid',
  'trade.outside_collar': 'priceInvalid',
  'trade.missing_collar': 'priceInvalid',
  'trade.self_trade': 'selfTrade',
  'trade.order_type_unsupported': 'orderTypeUnsupported',
  'trade.mode_limit_only': 'marketLimitOnly',
  'trade.stp_mode_unsupported': 'optionUnsupported',
  'trade.tag_unsupported': 'optionUnsupported',
  'trade.trigger_source_unset': 'optionUnsupported',
  'trade.request_expired': 'requestExpired',
  'trade.oco_price_order': 'exitPriceOrder',
  'trade.oco_stop_limit_required': 'exitStopLimitMissing',
  'trade.missing_oco_trigger': 'exitMissing',
  'trade.missing_stop_price': 'exitMissing',
  'trade.bracket_exit_failed': 'exitsNotPlaced',
  'trade.post_only_would_cross': 'postOnlyWouldCross',
  post_only_would_cross: 'postOnlyWouldCross',
  'trade.fok_unfillable': 'fokUnfillable',
  fok_unfillable: 'fokUnfillable',
  'trade.invalid_tif': 'tifInvalid',
  'trade.orders_paused': 'ordersPaused',
  'trade.below_min_notional': 'belowMinimum',
  'trade.below_min_qty': 'belowMinimum',

  'trade.market_not_found': 'notFound',
  'bank.space_not_found': 'notFound',
  'pay.payment_not_found': 'notFound',
  'pay.link_not_found': 'notFound',
  'pay.merchant_not_found': 'notFound',
  'trade.algo_jobs_disabled': 'algoSchedulerOff',
  'trade.algo_jobs_unknown': 'tryAgain',
  'trade.client_order_id_conflict': 'duplicate',
  'trade.idempotency_conflict': 'duplicate',
  'bank.same_space': 'duplicate',
  'bank.activity_account_unknown': 'notFound',
  'bank.activity_sort_bounded': 'activitySortBounded',
  'portfolio.entries_do_not_sum': 'entriesDoNotSum',
  'bank.activity_lookup_bounded': 'entriesTooLong',
  'bank.destination_label_taken': 'addressLabelTaken',
  'bank.address_book_full': 'addressBookFull',

  'pay.wallet_withdraw_unavailable': 'walletPaused',
  'pay.wallet_withdraw_disabled': 'walletPaused',
  'pay.wallet_cooling': 'walletPaused',
  'pay.wallet_fee_unset': 'walletFee',
  'pay.wallet_fee_differs': 'walletFee',
  'pay.wallet_cap_unset': 'walletCap',
  'pay.wallet_over_cap': 'walletCap',
  'pay.wallet_travel_rule': 'walletFields',
  'pay.wallet_share_timeout': 'walletFields',
  'pay.wallet_typed_address': 'walletAddress',
  'pay.wallet_allowlist': 'walletAddress',
  'pay.wallet_destination_rejected': 'walletAddress',
  'pay.wallet_forbidden': 'noPermission',
  'pay.wallet_not_found': 'notFound',
  'pay.wallet_unconfigured': 'tryAgain',
  'trade.candles_range_point_cap': 'chartRange',
};

/** Prefix rules, checked in order after the exact table. */
const PREFIXES: ReadonlyArray<readonly [prefix: string, kind: RefusalKind]> = [
  ['denied.kyc', 'verify'],
  ['denied.region', 'region'],
  ['denied.screening', 'screening'],
  ['denied.network', 'screening'],
  ['denied.module', 'screening'],
  ['denied.plane', 'screening'],
  ['denied.', 'screening'],
  ['kyc.', 'verify'],
  ['kyc_', 'verify'],
  ['token.params_', 'notSetUp'],
  ['token_params.', 'notSetUp'],
  ['trade.lifecycle', 'marketNotOpen'],
  ['trade.market_', 'marketNotOpen'],
  ['trade.venue_', 'marketNotOpen'],
  ['edge.venue_', 'marketNotOpen'],
  ['trade.spot_disabled', 'marketNotOpen'],
  ['trade.unknown_schedule', 'marketNotOpen'],
  ['trade.mark_', 'marketNotOpen'],
  ['trade.fx_', 'marketNotOpen'],
];

// `*_unset` / `*_unwired` are the services' "an operator has not configured this yet" refusals.
const SUFFIXES: ReadonlyArray<readonly [suffix: string, kind: RefusalKind]> = [
  ['.tier_required', 'verify'],
  ['_unset', 'notSetUp'],
  ['_unwired', 'notSetUp'],
];

/** Sort a service code into a kind; unknown and empty codes are `unknown`. */
export function classifyRefusal(code: string | null | undefined): RefusalKind {
  if (!code) return 'unknown';
  const normal = code.trim().toLowerCase();
  const exact = EXACT[normal];
  if (exact) return exact;
  for (const [suffix, kind] of SUFFIXES) if (normal.endsWith(suffix)) return kind;
  for (const [prefix, kind] of PREFIXES) if (normal.startsWith(prefix)) return kind;
  return 'unknown';
}

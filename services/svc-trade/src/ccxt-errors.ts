import { AuthError, type AuthErrorCode } from '@intafaced/auth';
import { type ExchangeErrorCode } from '@intafaced/exchange-contract';
import { InsufficientFundsError, LedgerError, MoneyError } from '@intafaced/ledger-client';
import { MatchingNoBookError, MatchingUnavailableError } from './spot/matching-client.js';
import { TradeError, type TradeErrorCode } from './spot/types.js';
import { TradingControlError } from './controls/trading-controls.js';

/**
 * CCXT ERROR TAXONOMY FOR THE PUBLIC REST SURFACE (trade.ccxt-api).
 *
 * A CCXT client does not read our error strings. It branches on the error
 * *class*, and the branch decides whether it retries, re-quotes, drops the
 * symbol, or stops the bot. Returning one shape for every failure — or our own
 * internal `trade.*` codes, which is what this surface did before — makes the
 * contract unusable by exactly the integrators it exists for:
 *
 *   - `InsufficientFunds` must never be retried. Retrying it is a hot loop
 *     against a wall, and on a venue that rate-limits, a ban.
 *   - `ExchangeNotAvailable` / `OnMaintenance` **must** be retried with backoff.
 *     Reported as a permanent error, a bot shuts down over a restart.
 *   - `BadSymbol` means drop the symbol from the rotation permanently.
 *   - `InvalidOrder` means the order was malformed — fix and resubmit, do not
 *     resubmit unchanged.
 *   - `NotSupported` means stop calling this method entirely.
 *
 * Getting this backwards is worse than a 500, because a 500 at least tells the
 * client it does not know what happened. A confidently wrong class makes the
 * client act.
 *
 * `intafacedCode` carries our finer-grained code alongside, so an operator
 * debugging a support ticket loses nothing by us speaking CCXT on the wire.
 *
 * The mapping table below is the documented contract. Every arm is deliberate
 * and the `Record<TradeErrorCode, …>` is exhaustive **by type** — a new
 * TradeErrorCode fails the build here until someone decides how a bot should
 * react to it. That is the point: the reaction is a product decision, not a
 * default.
 */

export interface CcxtErrorBody {
  code: ExchangeErrorCode;
  message: string;
  /** Our own finer-grained code, e.g. 'trade.below_min_notional'. */
  intafacedCode?: string;
  /** Seconds until the caller may retry. Only ever set on RateLimitExceeded. */
  retryAfter?: number;
}

export interface CcxtErrorResponse {
  status: number;
  body: CcxtErrorBody;
}

interface Arm {
  ccxt: ExchangeErrorCode;
  status: number;
}

/**
 * Internal trade errors → CCXT class + HTTP status.
 *
 * The status codes matter almost as much as the class: CCXT's base client
 * inspects the HTTP status before it ever parses a body, and a 5xx is retried
 * by most transport wrappers regardless of payload. So anything a caller must
 * *not* retry stays in the 4xx range even when it is genuinely our fault.
 */
const TRADE_ERROR_MAP: Record<TradeErrorCode, Arm> = {
  // ── Symbol is wrong or unusable: stop asking for it ───────────────────────
  /** No such listing. A bot should drop it from its rotation. */
  'trade.market_not_found': { ccxt: 'BadSymbol', status: 404 },
  /** An operator halted this listing. Same client action as unknown: stop. */
  'trade.market_not_tradable': { ccxt: 'BadSymbol', status: 403 },
  /** Spot service cannot serve this market kind (futures/options listing). */
  'trade.market_kind_unsupported': { ccxt: 'BadSymbol', status: 403 },
  /**
   * A futures listing this deployment does not take orders on
   * (`TRADE_FUTURES_ENABLED` off).
   *
   * `NotSupported` and not `BadSymbol`: the symbol is real, the ticker and the
   * orderbook answer for it, and `fetchMarkets` should keep returning it. What is
   * unavailable is the METHOD on this market — which is precisely what
   * `NotSupported` means in the header above ("stop calling this method
   * entirely"), and what a `BadSymbol` would get wrong by telling the bot to drop
   * a market it can still watch.
   *
   * 403 and not 501, for the reason stated at the top of this table: CCXT
   * transport wrappers retry 5xx before anything parses the body, and this is not
   * retryable — an operator has to change a variable and restart. Nor is it
   * `OnMaintenance`/503 like `spot_disabled`: nothing here is degraded or coming
   * back on its own. Futures being off is the shipped default, not an incident.
   */
  'trade.futures_disabled': { ccxt: 'NotSupported', status: 403 },

  // ── Temporarily closed: retry later, do not drop the symbol ───────────────
  /**
   * Between sessions (FX weekend, CME break). Deliberately NOT BadSymbol: the
   * identical order is fine on Monday, and a bot that drops EUR/USD every
   * Saturday never trades it again.
   */
  'trade.market_closed': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.market_halted': { ccxt: 'BadSymbol', status: 403 },
  /**
   * Operator halt of ALL markets. New submits refuse. Cancel stays — not
   * BadSymbol: dropping every symbol would strand rest. Not 5xx: halt-all never
   * expires; resume-all is the only reopen, and CCXT retries 5xx.
   */
  'trade.venue_halted': { ccxt: 'InvalidOrder', status: 403 },
  /**
   * Operator reduce-only of one market. Opens/increases refuse. Reduce, close,
   * and cancel stay — not BadSymbol: dropping the symbol would strand a position.
   */
  'trade.market_reduce_only': { ccxt: 'InvalidOrder', status: 403 },
  /**
   * Operator post-only of one market. Non-post-only submits refuse. Post-only
   * rest and cancel stay — not BadSymbol: dropping the symbol would strand rest.
   */
  'trade.market_post_only': { ccxt: 'InvalidOrder', status: 403 },
  /**
   * Operator prelaunch of one market. Public submits refuse until OPEN. Cancel
   * of nothing is a no-op. Not BadSymbol: dropping the symbol would miss OPEN.
   * Not 5xx: prelaunch never expires; OPEN is the only reopen, and CCXT retries 5xx.
   * Distinct from halt: `open` does not clear halt; `resume` does not clear prelaunch.
   */
  'trade.market_prelaunch': { ccxt: 'InvalidOrder', status: 403 },
  /**
   * Operator expire of one market. New submits refuse. Cancel stays.
   * Not BadSymbol: dropping the symbol would strand rest.
   * Not 5xx: expire never auto-reopens; resume/open do not clear it, and CCXT retries 5xx.
   * Distinct from halt: `resume` does not reopen expire. Distinct from prelaunch: `open` does not clear expire.
   */
  'trade.market_expired': { ccxt: 'InvalidOrder', status: 403 },
  /**
   * Operator delist of one market. New submits refuse. Cancel stays.
   * Not BadSymbol: dropping the symbol would strand rest.
   * Not 5xx: delist never auto-reopens; resume does not clear it, and CCXT retries 5xx.
   * Distinct from expire: expire refuse code stays `market_expired`.
   */
  'trade.market_delisted': { ccxt: 'InvalidOrder', status: 403 },
  'trade.market_suspended': { ccxt: 'BadSymbol', status: 403 },
  'trade.lifecycle_authority_unavailable': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.lifecycle_dossier_required': { ccxt: 'BadSymbol', status: 403 },
  'trade.lifecycle_dossier_invalid': { ccxt: 'BadSymbol', status: 403 },
  'trade.lifecycle_readiness_socket': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.lifecycle_transition_partial': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.lifecycle_transition_unknown': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.lifecycle_recovery_required': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.product_disabled': { ccxt: 'OnMaintenance', status: 503 },
  'trade.matching_market_missing': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.matching_unavailable': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /**
   * Matching 404 MarketNotFound. Listed here, engine holds no book.
   * Not BadSymbol (do not drop the listing) and not 5xx (engine answered).
   * WS sister is 404 NoBook.
   */
  'trade.no_book': { ccxt: 'ExchangeError', status: 404 },
  'trade.lifecycle_wrong_market': { ccxt: 'BadSymbol', status: 403 },
  'trade.market_status_unknown': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.lifecycle_authority_stale': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.lifecycle_proof_mismatch': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /**
   * Schedule key not in `TRADING_SCHEDULES` — misconfiguration, not a weekend.
   * BadRequest so bots do not retry Monday expecting the same key to work.
   */
  'trade.unknown_schedule': { ccxt: 'BadRequest', status: 400 },
  /** `asset_class` outside the instrument-model authority. */
  'trade.unknown_asset_class': { ccxt: 'BadRequest', status: 400 },
  /**
   * Convert/TWAP on FX. NotSupported 403 — stop calling convert on this symbol;
   * it is not crypto spot. Do not invent an FX mid from the spot book.
   */
  'trade.fx_not_spot': { ccxt: 'NotSupported', status: 403 },
  /**
   * FX holiday calendar unpublished. BadRequest — owner publishes days;
   * empty list is not "no holidays". Not a Monday retry.
   */
  'trade.fx_holiday_calendar_unpublished': { ccxt: 'BadRequest', status: 400 },
  /**
   * FX holiday (venue-local date). 503 like weekend — retry after the holiday.
   * Distinct so bots do not treat it as a generic session close.
   */
  'trade.fx_holiday': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /**
   * Production listing/place of forex/commodity refuse-closed at socket.forex-settlement
   * (D26-P1-T7 / T9 — needs D26-P0-05 + fiat settle rails; never invent settlement).
   * Not a symbol to drop forever if the owner later closes the socket — BadRequest.
   */
  'trade.unsettled_asset_class_listing': { ccxt: 'BadRequest', status: 400 },
  /**
   * Options listing refused: D26-P0-05 settlement asset law unset (SOCKET §13).
   * BadRequest — operator publishes ADR then stamps TRADE_OPTIONS_SETTLEMENT_ASSET_LAW;
   * not a symbol to drop. Never invent live set / settlement asset / refuse matrix.
   */
  'trade.options_settlement_law_unset': { ccxt: 'BadRequest', status: 400 },
  /**
   * Options listing refused: D7 settlement fixing not configured.
   * BadRequest — operator sets TRADE_OPTIONS_SETTLEMENT_FIXING; not a symbol to drop.
   */
  'trade.options_fixing_unconfigured': { ccxt: 'BadRequest', status: 400 },
  /**
   * Options half-list (missing strike/type/expiry) or terms on non-options kind.
   */
  'trade.options_terms_incomplete': { ccxt: 'BadRequest', status: 400 },
  /**
   * Real-money futures list/enable refused: insurance fund empty (DIRECTION:33).
   * BadRequest — operator must capitalise the fund; not a symbol to drop forever.
   */
  'trade.insurance_fund_empty': { ccxt: 'BadRequest', status: 400 },
  /**
   * Dated futures listing/place: no expiry. BadRequest — operator supplies
   * expiry; not a symbol to drop. Never trade it as a perp.
   */
  'trade.dated_futures_expiry_required': { ccxt: 'BadRequest', status: 400 },
  /**
   * Dated futures half-list (expiry on a perp, dated terms on non-futures).
   */
  'trade.dated_futures_terms_incomplete': { ccxt: 'BadRequest', status: 400 },
  /**
   * Dated futures listing/place: TRADE_FUTURES_SETTLEMENT_FIXING empty.
   * BadRequest — operator stamps fixing; not a symbol to drop.
   */
  'trade.dated_futures_fixing_unconfigured': { ccxt: 'BadRequest', status: 400 },
  /**
   * Expiry job: owner settlement price blank. BadRequest — never last trade.
   */
  'trade.dated_futures_settlement_price_unset': { ccxt: 'BadRequest', status: 400 },
  /**
   * Dated contract past listed expiry. InvalidOrder 403 — not operator expire.
   */
  'trade.dated_futures_expired': { ccxt: 'InvalidOrder', status: 403 },
  /** Operator kill-switch across the whole spot plane — venue-wide, retryable. */
  'trade.spot_disabled': { ccxt: 'OnMaintenance', status: 503 },
  'trade.seed_disabled': { ccxt: 'OnMaintenance', status: 503 },
  'trade.seed_must_make': { ccxt: 'InvalidOrder', status: 400 },
  'trade.convert_disabled': { ccxt: 'OnMaintenance', status: 503 },
  'trade.convert_quote_missing': { ccxt: 'OrderNotFound', status: 404 },
  'trade.convert_quote_expired': { ccxt: 'InvalidOrder', status: 409 },
  'trade.convert_expiry_missing': { ccxt: 'InvalidOrder', status: 400 },
  'trade.convert_amounts_missing': { ccxt: 'InvalidOrder', status: 400 },
  'trade.convert_source_missing': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.convert_not_owner': { ccxt: 'PermissionDenied', status: 403 },
  /** DIRECTION §8 desk law unpublished — refuse-closed, not invent. */
  'trade.otc_desk_law_blank': { ccxt: 'OnMaintenance', status: 503 },
  'trade.otc_settle_refused': { ccxt: 'OnMaintenance', status: 503 },
  'trade.otc_stake_unavailable': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.otc_stake_gate': { ccxt: 'PermissionDenied', status: 403 },
  'trade.otc_not_owner': { ccxt: 'PermissionDenied', status: 403 },
  'trade.otc_no_reference_price': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.otc_invalid_qty': { ccxt: 'InvalidOrder', status: 400 },
  'trade.otc_invalid_price': { ccxt: 'InvalidOrder', status: 400 },
  'trade.otc_bad_spread': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.otc_quote_expired': { ccxt: 'InvalidOrder', status: 409 },
  'trade.otc_last_look_forbidden': { ccxt: 'InvalidOrder', status: 409 },
  'trade.otc_quote_missing': { ccxt: 'OrderNotFound', status: 404 },
  'trade.otc_already_settled': { ccxt: 'InvalidOrder', status: 409 },
  'trade.rfq_missing_size': { ccxt: 'InvalidOrder', status: 400 },
  'trade.rfq_missing_price': { ccxt: 'InvalidOrder', status: 400 },
  'trade.rfq_already_bound': { ccxt: 'InvalidOrder', status: 409 },
  'trade.rfq_allocation_refused': { ccxt: 'OnMaintenance', status: 503 },
  'trade.rfq_give_up_refused': { ccxt: 'OnMaintenance', status: 503 },

  // ── The order itself is malformed: fix it, then resubmit ──────────────────
  'trade.order_type_unsupported': { ccxt: 'InvalidOrder', status: 400 },
  'trade.invalid_qty': { ccxt: 'InvalidOrder', status: 400 },
  'trade.invalid_price': { ccxt: 'InvalidOrder', status: 400 },
  /** JSON number on an OCO/bracket leg — decimal string required. */
  'trade.ieee_money': { ccxt: 'InvalidOrder', status: 400 },
  'trade.below_min_notional': { ccxt: 'InvalidOrder', status: 400 },
  'trade.convert_invalid_qty': { ccxt: 'InvalidOrder', status: 400 },
  'trade.convert_missing_id': { ccxt: 'BadRequest', status: 400 },
  /** Place without clientOrderId — permanent fix for the request shape. */
  'trade.client_order_id_required': { ccxt: 'InvalidOrder', status: 400 },
  /** Caller reused an idempotency identity for a different order command. */
  'trade.client_order_id_conflict': { ccxt: 'InvalidOrder', status: 409 },
  /**
   * Identity S2S ownership consult failed. Retryable — same posture as
   * `trade.perks_unavailable`: we will not guess ownership while identity is down.
   */
  'trade.sub_account_unavailable': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /** Missing or foreign sub-account. Permanent for this id + principal. */
  'trade.sub_account_denied': { ccxt: 'PermissionDenied', status: 403 },
  /** Soft-revoked sub-account — create a new book; do not retry the same id. */
  'trade.sub_account_revoked': { ccxt: 'PermissionDenied', status: 403 },

  // ── Order lifecycle ───────────────────────────────
  'trade.order_not_found': { ccxt: 'OrderNotFound', status: 404 },
  /**
   * Cancelling an order that already filled or cancelled. CCXT venues answer
   * InvalidOrder here rather than OrderNotFound, because the order does exist
   * and a client that re-fetches will find it in a terminal state.
   */
  'trade.order_not_open': { ccxt: 'InvalidOrder', status: 409 },
  /** Someone else's order. Not "not found" — do not leak existence either way. */
  'trade.not_owner': { ccxt: 'PermissionDenied', status: 403 },

  // ── Cannot be filled at all right now ─────────────────────────
  'trade.convert_no_liquidity': { ccxt: 'OrderNotFillable', status: 400 },
  'trade.convert_insufficient_depth': { ccxt: 'OrderNotFillable', status: 400 },
  'trade.convert_bad_depth': { ccxt: 'OrderNotFillable', status: 400 },
  /** Quote went stale between quote and accept — re-quote and try again. */
  'trade.convert_price_moved': { ccxt: 'InvalidOrder', status: 409 },

  // ── Market conditions the venue refuses to trade through ──────────────────
  'trade.convert_spread_too_high': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.convert_bad_spread': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /** Owner convert spread unpublished — refuse-closed, not invent 10. */
  'trade.convert_spread_unset': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /** Owner convert quote TTL unpublished — refuse-closed, not invent 15000. */
  'trade.convert_quote_ttl_unset': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /** Owner market-buy cap unpublished — refuse-closed, not invent 200. */
  'trade.slippage_cap_unset': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /** Owner MM seed half-spread/step unpublished — refuse-closed, not invent 10. */
  'trade.mm_seed_bps_unset': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /**
   * No price source. This is the honesty rule in error form: we refuse rather
   * than quote a number we cannot source. Retryable — a feed can come back.
   */
  'trade.no_reference_price': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /** Rank/perk lookup failed; we will not guess a fee tier. Retryable. */
  'trade.perks_unavailable': { ccxt: 'ExchangeNotAvailable', status: 503 },

  // ── Genuinely our fault, and not the caller's to fix ──────────────────────
  'trade.dust_fill': { ccxt: 'ExchangeError', status: 500 },
  'trade.fee_exceeds_fill': { ccxt: 'ExchangeError', status: 500 },
  /**
   * Owner TRADE_FEE_SCHEDULE unpublished. Place/fill refuse — never listing
   * 10/20. Operator publishes; not a retry loop and not a symbol to drop.
   */
  'trade.fee_schedule_blank': { ccxt: 'BadRequest', status: 400 },
  'trade.hold_uncovered': { ccxt: 'ExchangeError', status: 500 },
  /**
   * Funded engine-miss whose fills do not prove no fill. Hold stays.
   * Not retryable by the caller — operator break, not a bot backoff loop.
   */
  'trade.reconcile_unknown_engine_miss': { ccxt: 'ExchangeError', status: 500 },
  /**
   * A fill sequence is already owned by a DIFFERENT match, so settling would
   * alias two trades onto one ledger idempotency key.
   *
   * `ExchangeError`/500 rather than `ExchangeNotAvailable`/503, and the
   * difference is the instruction the status carries. A 503 tells every bot in
   * the fleet to back off and try again, and retrying is exactly wrong here:
   * the sequence stays taken until an operator repairs the book's journal, so a
   * retry storm would hammer a venue that cannot answer and bury the one log
   * line that explains why. The order did not happen, its hold is intact, and a
   * human has to look.
   */
  'trade.fill_sequence_conflict': { ccxt: 'ExchangeError', status: 500 },
  'trade.missing_expire_at': { ccxt: 'InvalidOrder', status: 400 },
  'trade.engine_clock_missing': { ccxt: 'InvalidOrder', status: 400 },
  'trade.missing_oco_trigger': { ccxt: 'InvalidOrder', status: 400 },
  'trade.oco_sibling_terminal': { ccxt: 'InvalidOrder', status: 400 },
  'trade.position_flat': { ccxt: 'InvalidOrder', status: 400 },
  'trade.invalid_tif': { ccxt: 'InvalidOrder', status: 400 },
  'trade.min_qty_exceeds_qty': { ccxt: 'InvalidOrder', status: 400 },
  'trade.iceberg_display_missing': { ccxt: 'InvalidOrder', status: 400 },
  'trade.iceberg_display_not_smaller': { ccxt: 'InvalidOrder', status: 400 },
  'trade.missing_strike': { ccxt: 'InvalidOrder', status: 400 },
  'trade.missing_expiry': { ccxt: 'InvalidOrder', status: 400 },
  'trade.missing_qty': { ccxt: 'InvalidOrder', status: 400 },
  'trade.missing_stop_price': { ccxt: 'InvalidOrder', status: 400 },
  'trade.missing_price': { ccxt: 'InvalidOrder', status: 400 },
  'trade.missing_trail': { ccxt: 'InvalidOrder', status: 400 },
  'trade.missing_mark': { ccxt: 'InvalidOrder', status: 400 },
  'trade.aon_iceberg': { ccxt: 'InvalidOrder', status: 400 },
  'trade.peg_unsupported': { ccxt: 'InvalidOrder', status: 400 },
  'trade.midpoint_unsupported': { ccxt: 'InvalidOrder', status: 400 },
  'trade.relative_unsupported': { ccxt: 'InvalidOrder', status: 400 },
  'trade.auction_unsupported': { ccxt: 'InvalidOrder', status: 400 },
  'trade.benchmark_unsupported': { ccxt: 'InvalidOrder', status: 400 },
  /** Matching refused self_trade. Incoming does not rest; rest stays. Not retryable. */
  'trade.self_trade': { ccxt: 'InvalidOrder', status: 400 },
  /**
   * Collar requested without caller min and max. Matching refuses missing_collar.
   * Trade does not invent last or mid. Not retryable.
   */
  'trade.missing_collar': { ccxt: 'InvalidOrder', status: 400 },
  /**
   * Submit price is outside the caller collar. Matching refuses outside_collar.
   * Trade does not invent last or mid. Not retryable.
   */
  'trade.outside_collar': { ccxt: 'InvalidOrder', status: 400 },
  /** Combo without named legs. Matching refuses missing_combo_legs. Not retryable. */
  'trade.missing_combo_legs': { ccxt: 'InvalidOrder', status: 400 },
  /** Combo leg without a ratio. Matching refuses missing_ratio. Not retryable. */
  'trade.missing_ratio': { ccxt: 'InvalidOrder', status: 400 },
  /** Combo take disagrees with the resting combo. Matching refuses combo_disagrees. Not retryable. */
  'trade.combo_disagrees': { ccxt: 'InvalidOrder', status: 400 },
  /** Combo is not independent option legs. Matching refuses combo_unsupported. Not retryable. */
  'trade.combo_unsupported': { ccxt: 'InvalidOrder', status: 400 },
  /** Combo legs would each take a hold. Trade does not post per-leg invented money. Not retryable. */
  'trade.combo_double_hold': { ccxt: 'InvalidOrder', status: 400 },
  /**
   * Place/fill/ledger missing session or API-key id. Not retryable — the
   * credential must carry sid or kid; trade does not invent a session.
   */
  'trade.auth_attribution_missing': { ccxt: 'AuthenticationError', status: 403 },

  // ── Algo TWAP (D-S-04) — schedule refusals / state ─────────────────────────
  'trade.algo_disabled': { ccxt: 'OnMaintenance', status: 503 },
  'trade.algo_invalid_qty': { ccxt: 'InvalidOrder', status: 400 },
  'trade.algo_invalid_schedule': { ccxt: 'InvalidOrder', status: 400 },
  'trade.algo_unsupported_kind': { ccxt: 'NotSupported', status: 400 },
  'trade.algo_not_found': { ccxt: 'OrderNotFound', status: 404 },
  'trade.algo_duplicate_id': { ccxt: 'InvalidOrder', status: 409 },
  'trade.algo_bad_state': { ccxt: 'InvalidOrder', status: 409 },
  'trade.algo_no_liquidity': { ccxt: 'OrderNotFillable', status: 400 },
  'trade.algo_no_volume': { ccxt: 'OrderNotFillable', status: 400 },
  'trade.algo_volume_immature': { ccxt: 'OrderNotFillable', status: 400 },
  'trade.algo_price_band': { ccxt: 'InvalidOrder', status: 400 },
  'trade.algo_mark_unusable': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.algo_mark_missing': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.algo_insufficient_balance': { ccxt: 'InsufficientFunds', status: 400 },
  'trade.algo_child_refused': { ccxt: 'InvalidOrder', status: 400 },
  /**
   * Child cancel failed and the parent was left non-cancelled. Caller must
   * retry cancel — not treat the algo as dead (a cancel that does not cancel
   * is worse than a refused cancel).
   */
  'trade.algo_child_cancel_failed': { ccxt: 'InvalidOrder', status: 409 },
  // The schedule outlived the session that authorised it — the venue cannot act
  // on the caller's behalf, which is an availability answer, not a bad request.
  'trade.algo_principal_unavailable': { ccxt: 'ExchangeNotAvailable', status: 503 },
  'trade.algo_market_closed': { ccxt: 'ExchangeNotAvailable', status: 503 },
  /** ADR 2026-08-08: resume would more than double the order's own duration. */
  'trade.algo_resume_extends_too_far': { ccxt: 'InvalidOrder', status: 400 },
  'trade.algo_cancel_incomplete': { ccxt: 'InvalidOrder', status: 409 },
};

/**
 * Auth failures → CCXT class.
 *
 * CCXT distinguishes `AuthenticationError` ("your credentials did not work")
 * from `PermissionDenied` ("they worked, and they are not enough"). A bot
 * re-signs on the first and gives up on the second; collapsing them makes a
 * missing scope look like a broken key and sends integrators hunting the wrong
 * bug for an afternoon.
 */
const AUTH_ERROR_MAP: Record<AuthErrorCode, Arm> = {
  'token.expired': { ccxt: 'AuthenticationError', status: 401 },
  'token.invalid': { ccxt: 'AuthenticationError', status: 401 },
  'token.malformed': { ccxt: 'AuthenticationError', status: 401 },
  /** Step-up required — the credential is valid, the session is not enough. */
  'mfa.required': { ccxt: 'AuthenticationError', status: 401 },
  'scope.denied': { ccxt: 'PermissionDenied', status: 403 },
  'tier.insufficient': { ccxt: 'PermissionDenied', status: 403 },
  'ownership.denied': { ccxt: 'PermissionDenied', status: 403 },
};

/** No edge-signed principal at all. */
export const UNAUTHENTICATED: CcxtErrorResponse = {
  status: 401,
  body: { code: 'AuthenticationError', message: 'Authentication required', intafacedCode: 'auth.required' },
};

/** Symbol that resolves to no listing — the single most common bot mistake. */
export function badSymbol(symbol: string): CcxtErrorResponse {
  return {
    status: 404,
    body: { code: 'BadSymbol', message: `market ${symbol} not found`, intafacedCode: 'trade.market_not_found' },
  };
}

/** Malformed query/path parameter that is not itself an order field. */
export function badRequest(message: string, intafacedCode: string): CcxtErrorResponse {
  return { status: 400, body: { code: 'BadRequest', message, intafacedCode } };
}

/** A route we mount on purpose and will not serve in this venue's shape. */
export function notSupported(message: string, intafacedCode: string): CcxtErrorResponse {
  return { status: 501, body: { code: 'NotSupported', message, intafacedCode } };
}

/**
 * Throttled. `retryAfter` is in seconds and is mandatory here — CCXT's
 * throttler reads it, and a RateLimitExceeded without one makes a client guess
 * the backoff, which is how a throttle turns into a ban.
 */
export function rateLimited(retryAfterSeconds: number, message = 'rate limit exceeded'): CcxtErrorResponse {
  return {
    status: 429,
    body: {
      code: 'RateLimitExceeded',
      message,
      intafacedCode: 'trade.rate_limited',
      retryAfter: Math.max(1, Math.ceil(retryAfterSeconds)),
    },
  };
}

/**
 * Jurisdiction / KYC refusal from `checkAccess`. The decision code is ours
 * (`kyc.tier_required`, geo blocks); the class a bot branches on is
 * PermissionDenied — credentials fine, this principal may not trade here.
 */
export function permissionDenied(message: string, intafacedCode: string): CcxtErrorResponse {
  return { status: 403, body: { code: 'PermissionDenied', message, intafacedCode } };
}

/**
 * A create-order body that failed schema validation. `InvalidOrder` rather than
 * `BadRequest`: it is specifically the order that is wrong, and that is the
 * branch a client's order-builder listens on.
 */
export function invalidOrder(message: string, intafacedCode = 'trade.validation_failed'): CcxtErrorResponse {
  return { status: 400, body: { code: 'InvalidOrder', message, intafacedCode } };
}

/**
 * Map any thrown error to the CCXT wire shape, or `null` when we do not
 * recognise it.
 *
 * Returning `null` rather than a catch-all `ExchangeError` is deliberate: an
 * unrecognised throw is a bug, and it must reach the Fastify error handler and
 * the logs as a 500 rather than be quietly relabelled into something a client
 * will confidently retry forever.
 */
export function toCcxtError(err: unknown): CcxtErrorResponse | null {
  if (err instanceof TradingControlError) {
    let status = 403;
    if (err.code === 'authority.unavailable') status = 503;
    else if (err.code === 'operation.conflict') status = 409;
    return {
      status,
      body: {
        code: err.code === 'authority.unavailable' ? 'ExchangeNotAvailable' : 'PermissionDenied',
        message: err.message,
        intafacedCode: err.code,
      },
    };
  }
  if (err instanceof MatchingNoBookError) {
    // Engine answered: it does not hold this market. Not a live empty book.
    return {
      status: 404,
      body: {
        code: 'ExchangeError',
        message: err.message,
        intafacedCode: 'trade.no_book',
      },
    };
  }

  if (err instanceof MatchingUnavailableError) {
    // The book is genuinely unreachable. Retryable, and 502 keeps it visibly
    // an upstream failure rather than the caller's fault.
    return {
      status: 502,
      body: {
        code: 'ExchangeNotAvailable',
        message: err.message,
        intafacedCode: 'trade.matching_unavailable',
      },
    };
  }

  if (err instanceof AuthError) {
    const arm = AUTH_ERROR_MAP[err.code];
    return { status: arm.status, body: { code: arm.ccxt, message: err.message, intafacedCode: err.code } };
  }

  if (err instanceof TradeError) {
    const arm = TRADE_ERROR_MAP[err.code];
    // A TradeErrorCode with no arm cannot happen through the type system, but
    // a value crossing a service boundary is not typed. Fall back to the
    // non-retryable generic rather than inventing a retry instruction.
    if (!arm) return { status: 400, body: { code: 'ExchangeError', message: err.message, intafacedCode: err.code } };
    return { status: arm.status, body: { code: arm.ccxt, message: err.message, intafacedCode: err.code } };
  }

  // Subclass before superclass: InsufficientFundsError extends LedgerError.
  if (err instanceof InsufficientFundsError) {
    return {
      status: 400,
      body: { code: 'InsufficientFunds', message: err.message, intafacedCode: err.code },
    };
  }

  if (err instanceof MoneyError) {
    // A malformed decimal on the wire — the caller's to fix.
    return { status: 400, body: { code: 'BadRequest', message: err.message, intafacedCode: 'money.invalid' } };
  }

  if (err instanceof LedgerError) {
    // The ledger refused for a reason that is not "not enough funds". Not the
    // caller's to fix and not retryable by simply resending.
    return { status: 400, body: { code: 'ExchangeError', message: err.message, intafacedCode: err.name } };
  }

  return null;
}

/** Read-only view of the mapping, for the contract test and for documentation. */
export const CCXT_ERROR_MAPPING: Readonly<Record<TradeErrorCode, Arm>> = TRADE_ERROR_MAP;
export const CCXT_AUTH_MAPPING: Readonly<Record<AuthErrorCode, Arm>> = AUTH_ERROR_MAP;

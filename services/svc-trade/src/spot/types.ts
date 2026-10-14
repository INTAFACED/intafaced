import type { AssetClass, ScheduleKey } from '@intafaced/contracts';
import type { Amount } from '@intafaced/ledger-client';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';

/**
 * The domain, in memory.
 *
 * Every money-shaped field is an `Amount` — the scaled bigint from
 * `@intafaced/ledger-client`. Rows come out of Postgres as decimal strings and
 * are parsed at exactly one place (`rows.ts`); nothing below this line ever
 * sees a `number` holding value, because 0.1 + 0.2 is not 0.3 and the ledger
 * reconciles to 18 decimal places.
 *
 * `bps` fields ARE numbers. A basis point is a count, not a quantity of value,
 * and `mulBps` requires an integer.
 */

export type MarketKind = 'spot' | 'futures' | 'options';
export type MarketStatus = 'pending' | 'active' | 'halted' | 'delisted';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'PO' | 'GTD' | 'GTT';
export type OrderStatus = 'pending' | 'open' | 'filled' | 'cancelled' | 'rejected' | 'expired' | 'recovery_required';
export type RecoveryReason = 'SUBMIT_UNKNOWN' | 'CANCEL_UNKNOWN' | 'AMEND_UNKNOWN' | 'RECONCILIATION_REQUIRED';
export type AmendPriority = 'retained' | 'lost';
export type Liquidity = 'maker' | 'taker';

/**
 * CX-9 reconcile diagnoses (Spec · Plan P1-5).
 *
 * Operator / recovery method — not a silent cancel-all of healthy opens.
 */
export type ReconcileCase =
  | 'orphan_pending'
  | 'open_hold_no_engine'
  /** Funded engine-miss whose `trade.fills` do not prove no fill — hold stays. */
  | 'open_hold_no_engine_unknown'
  | 'open_hold_engine_cleared'
  | 'open_engine_no_hold'
  | 'recovery_required_live'
  | 'recovery_required_absent'
  | 'recovery_required_no_hold'
  | 'terminal'
  | 'not_found';

export type ReconcileAction = 'deleted' | 'released' | 'fail_closed' | 'none';

export interface ReconcileResult {
  readonly orderId: string;
  readonly case: ReconcileCase;
  readonly action: ReconcileAction;
  /** Decimal string of ledger hold for this order before action. */
  readonly holdBefore: string;
  /** Whether the engine reported the order live at cancel probe (null if not probed). */
  readonly engineLive: boolean | null;
  readonly detail: string;
}

export interface Market {
  readonly id: string;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly kind: MarketKind;
  readonly tickSize: Amount;
  readonly lotSize: Amount;
  readonly minQty: Amount;
  readonly maxQty: Amount | null;
  readonly minNotional: Amount;
  readonly status: MarketStatus;
  readonly makerBps: number;
  readonly takerBps: number;
  readonly listedAt: Date | null;
  readonly assetClass: AssetClass;
  /**
   * When this market accepts orders.
   *
   * `status` answers "is this market live at all"; the schedule answers "is it
   * open right now". They are different questions, and conflating them is how
   * a Saturday EUR/USD order gets funded into a venue that cannot fill it — a
   * forex pair is permanently `active` and shut every weekend.
   */
  readonly schedule: ScheduleKey;
  /** Paper / simulated market — never posts real ledger holds (academy paper drills). */
  readonly paper: boolean;
  /**
   * Futures constitution style. `dated` requires expiry + owner fixing stamp.
   * Omitted / null on non-futures. kind=futures with null → perpetual (legacy rows).
   */
  readonly futuresContractStyle?: 'perpetual' | 'dated' | null;
  readonly futuresExpiryAt?: Date | null;
  /** Opaque owner fixing stamp on dated listings — never a settlement price. */
  readonly futuresSettlementFixing?: string | null;
}

export interface OrderRecord {
  readonly id: string;
  readonly userId: string;
  readonly subAccountId: string | null;
  readonly marketId: string;
  readonly clientOrderId: string | null;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly price: Amount | null;
  readonly qty: Amount;
  readonly filledQty: Amount;
  readonly status: OrderStatus;
  readonly tif: TimeInForce;
  readonly holdAsset: string;
  readonly holdAmount: Amount;
  /** Proven native-amend qty-down releases. Remainder is hold − fills − this. */
  readonly amendReleased: Amount;
  readonly feeDiscountBps: number;
  readonly protectionPrice: Amount | null;
  readonly engineSequence: number | null;
  /** Matching instruction version used as `expectedVersion` on the next PATCH. */
  readonly engineVersion: number;
  /** Seed/mm liquidity order (SD-2). Public volume excludes these (SD-3). */
  readonly seeded: boolean;
  readonly rejectCode: string | null;
  /** Frozen exchange-contract outcome evidence for unresolved commands. */
  readonly recoveryReason: RecoveryReason | null;
  readonly reconciliationKey: string | null;
  /** Frozen PX-S01 authorization used for the original submit. */
  readonly lifecycleProof: LifecycleAdmissionProof | null;
  /** Original order for a cancel/replace replacement, otherwise null. */
  readonly replacementOf: string | null;
  /** Exact replacement request digest, otherwise null. */
  readonly replacementRequestHash: string | null;
  /** Signed session id at place (principal.sid). Null on pre-R-auth rows. */
  readonly sessionId: string | null;
  /** Signed API-key id at place (principal.kid), or house-mm for seed. */
  readonly apiKeyId: string | null;
  readonly createdAt: Date;
}

export type ReplaceOutcomeCode =
  | 'REPLACED'
  | 'IDEMPOTENT_RETRY'
  | 'ORIGINAL_NOT_REPLACEABLE'
  | 'ORIGINAL_PARTIAL'
  | 'REPLACE_CONFLICT'
  | 'CANCEL_UNKNOWN'
  | 'RECONCILIATION_REQUIRED'
  | 'REPLACEMENT_SUBMIT_UNKNOWN'
  | 'REPLACEMENT_NOT_SUBMITTED'
  | 'LIFECYCLE_REFUSED';

/** Honest result of the two-step cancel → finalized release → submit saga. */
export interface ReplaceOrderOutcome {
  readonly accepted: boolean;
  readonly idempotent: boolean;
  readonly code: ReplaceOutcomeCode;
  readonly reasonCode: string | null;
  readonly reconciliationRequired: boolean;
  readonly original: OrderRecord;
  readonly replacement: OrderRecord | null;
}

export type AmendOutcomeCode =
  | 'AMENDED'
  | 'IDEMPOTENT_RETRY'
  | 'NOT_AMENDABLE'
  | 'CANCEL_REPLACE'
  | 'LIFECYCLE_REFUSED'
  | 'AMEND_UNKNOWN'
  | 'VERSION_MISMATCH'
  | 'ENGINE_REFUSED';

/**
 * Native amend against the matching PATCH door. Never a cancel/replace saga.
 * `priority` is what the engine reported; trade does not invent retain/lost.
 */
export interface AmendOrderOutcome {
  readonly accepted: boolean;
  readonly idempotent: boolean;
  readonly code: AmendOutcomeCode;
  readonly reasonCode: string | null;
  readonly reconciliationRequired: boolean;
  readonly path: 'NATIVE_AMEND';
  readonly priority: AmendPriority | null;
  readonly order: OrderRecord;
}

export interface FillRecord {
  readonly id: string;
  readonly orderId: string;
  readonly counterOrderId: string;
  readonly marketId: string;
  readonly userId: string;
  readonly side: OrderSide;
  readonly liquidity: Liquidity;
  readonly price: Amount;
  readonly qty: Amount;
  readonly quoteAmount: Amount;
  readonly feeAsset: string;
  readonly feeAmount: Amount;
  readonly feeBps: number;
  readonly sequence: number;
  readonly ts: Date;
  readonly sessionId: string | null;
  readonly apiKeyId: string | null;
}

/**
 * One public tape print — one match, no user or order identity.
 *
 * Derived from the taker leg of `trade.fills`. The public REST tape must never
 * leak who traded; bots only need price, size, side, and when.
 */
export interface PublicTapePrint {
  readonly id: string;
  readonly side: OrderSide;
  readonly price: Amount;
  readonly qty: Amount;
  readonly quoteAmount: Amount;
  readonly sequence: number;
  readonly ts: Date;
}

/**
 * One aggregated candle, derived from the same taker fills as the public tape.
 *
 * Every field is a measurement of real trades: open/close are the first and
 * last traded price in the bucket by engine sequence, high/low the extremes,
 * volume the summed base quantity. There is no modelled or carried-forward
 * value anywhere in this shape — a bucket in which nothing traded produces no
 * Candle at all rather than a flat one, because a flat candle is a print that
 * never happened.
 *
 * `openTimeMs` is the bucket's opening boundary in unix ms (CCXT convention).
 */
export interface Candle {
  readonly openTimeMs: number;
  readonly open: Amount;
  readonly high: Amount;
  readonly low: Amount;
  readonly close: Amount;
  readonly volume: Amount;
}

/**
 * Every way this service refuses.
 *
 * A closed union rather than free text because an SLO dashboard groups by it
 * and a client branches on it: `trade.market_halted` is an operator action
 * working as intended, `trade.hold_uncovered` is an alarm, and collapsing the
 * two into "order failed" makes both unactionable.
 */
export type TradeErrorCode =
  | 'trade.market_not_found'
  | 'trade.market_not_tradable'
  // Distinct from `market_not_tradable` on purpose: that one means an operator
  // halted the listing and the caller should stop asking, this one means the
  // venue is between sessions and the same order will be fine on Monday.
  | 'trade.market_closed'
  | 'trade.market_halted'
  /** Matching operator halt of ALL markets. New submits refuse; cancel stays. Distinct from one-market halt. */
  | 'trade.venue_halted'
  /** Matching operator reduce-only of one market. Opens/increases refuse; reduce/close/cancel stay. */
  | 'trade.market_reduce_only'
  /** Matching operator post-only of one market. Non-post-only submits refuse; PO rest and cancel stay. */
  | 'trade.market_post_only'
  /** Matching operator prelaunch of one market. Public submits refuse until OPEN. Distinct from halt. */
  | 'trade.market_prelaunch'
  /** Matching operator expire of one market. New submits refuse; cancel stays. Distinct from halt and prelaunch. */
  | 'trade.market_expired'
  /** Matching operator delist of one market. New submits refuse; cancel stays. Distinct from expire and halt. */
  | 'trade.market_delisted'
  | 'trade.market_suspended'
  | 'trade.lifecycle_authority_unavailable'
  | 'trade.lifecycle_dossier_required'
  | 'trade.lifecycle_dossier_invalid'
  | 'trade.lifecycle_readiness_socket'
  | 'trade.lifecycle_transition_partial'
  | 'trade.lifecycle_transition_unknown'
  | 'trade.lifecycle_recovery_required'
  | 'trade.product_disabled'
  | 'trade.matching_market_missing'
  | 'trade.matching_unavailable'
  /** Matching 404 MarketNotFound — engine holds no book. Not a live empty ladder. */
  | 'trade.no_book'
  | 'trade.lifecycle_wrong_market'
  | 'trade.market_status_unknown'
  | 'trade.lifecycle_authority_stale'
  | 'trade.lifecycle_proof_mismatch'
  /**
   * Schedule key present on the row but absent from `TRADING_SCHEDULES`
   * (D-S-05 / D26-P1-T9). Misconfiguration — not a session boundary.
   */
  | 'trade.unknown_schedule'
  /**
   * `asset_class` outside `ASSET_CLASSES` (D-S-05). Refusal names the permitted set.
   */
  | 'trade.unknown_asset_class'
  /**
   * Convert/TWAP/POV on an FX listing. Those surfaces walk the crypto spot book.
   * FX is a separate product — do not invent an FX mid from matching depth.
   */
  | 'trade.fx_not_spot'
  /**
   * FX sessions schedule has no owner-published holiday days. Empty `holidays`
   * fail OPEN — refuse rather than invent "no holidays this year".
   */
  | 'trade.fx_holiday_calendar_unpublished'
  /**
   * FX venue-local holiday. Distinct from weekend `trade.market_closed`.
   */
  | 'trade.fx_holiday'
  | 'trade.market_kind_unsupported'
  | 'trade.order_type_unsupported'
  | 'trade.invalid_qty'
  | 'trade.invalid_price'
  /** JSON number on an OCO/bracket leg — decimal string required. IEEE 0.1 is not a price. */
  | 'trade.ieee_money'
  | 'trade.below_min_notional'
  /** Place without clientOrderId — retry would open a second hold. */
  | 'trade.client_order_id_required'
  /** Same retry identity presented with a different persisted order command. */
  | 'trade.client_order_id_conflict'
  | 'trade.no_reference_price'
  | 'trade.spot_disabled'
  /**
   * A futures market exists and this deployment does not take orders on it
   * (`TRADE_FUTURES_ENABLED` off). Distinct from `market_kind_unsupported`,
   * which claims the service will NEVER serve the kind: this one is an operator
   * setting, so a client must keep the symbol and stop placing, not drop it.
   */
  | 'trade.futures_disabled'
  | 'trade.seed_disabled'
  | 'trade.seed_must_make'
  | 'trade.order_not_found'
  | 'trade.order_not_open'
  | 'trade.not_owner'
  | 'trade.perks_unavailable'
  | 'trade.dust_fill'
  /**
   * A match is legal on the grid but fees leave a side with a zero receivable
   * (`mulBps` ceil on a 1-wei leg). Refused BEFORE fill rows so the fills table
   * cannot permanently outrun the ledger.
   */
  | 'trade.fee_exceeds_fill'
  /**
   * Owner `TRADE_FEE_SCHEDULE` unpublished. Place and fill refuse — never
   * listing-row maker_bps/taker_bps (10/20) and never invented bps.
   */
  | 'trade.fee_schedule_blank'
  /**
   * Forex/commodity production listing or place without settlement law
   * (D26-P1-T7 / §13 `socket.forex-settlement` — needs D26-P0-05 + fiat rails).
   * Model/paper listings remain legal; this is the production-list / hold-path lie.
   */
  | 'trade.unsettled_asset_class_listing'
  /**
   * Options listing refused because D26-P0-05 settlement asset law is unset.
   * `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` empty → refuse (SOCKET §13
   * `socket.options-settlement-asset-law`). Never invent live set / asset / matrix.
   */
  | 'trade.options_settlement_law_unset'
  /**
   * Options listing refused because settlement fixing is not configured (D7).
   * `TRADE_OPTIONS_SETTLEMENT_FIXING` empty → refuse. Distinct from terms.
   */
  | 'trade.options_fixing_unconfigured'
  /**
   * Options listing refused for incomplete contract terms (half-list) or terms
   * on a non-options kind. Schema CHECK `markets_options_terms_ck` is the same rule.
   */
  | 'trade.options_terms_incomplete'
  /**
   * Real-money futures list/enable refused because the insurance fund for the
   * quote asset is empty (DIRECTION:33). Distinct from `trade.insurance_underfunded`
   * (shortfall cover on an open position). Does not encode a target size.
   */
  | 'trade.insurance_fund_empty'
  /**
   * Dated futures listing/place refused: style=dated with no valid expiry.
   * A contract without expiry must not behave as a perp (PTX-M10-R03).
   */
  | 'trade.dated_futures_expiry_required'
  /**
   * Dated futures half-list (expiry on a perp, dated terms on non-futures).
   * Schema CHECK `markets_dated_futures_terms_ck` is the same rule.
   */
  | 'trade.dated_futures_terms_incomplete'
  /**
   * Dated futures listing/place refused: TRADE_FUTURES_SETTLEMENT_FIXING empty.
   * Distinct from settlement *price* at expiry.
   */
  | 'trade.dated_futures_fixing_unconfigured'
  /**
   * Expiry job refused: owner settlement/fixing price blank or invalid.
   * Never substitutes last trade or mark (PTX-M10-R03).
   */
  | 'trade.dated_futures_settlement_price_unset'
  /**
   * Place/open refused: listed dated expiry has passed. Not operator expire
   * (`trade.market_expired`) and not a perpetual.
   */
  | 'trade.dated_futures_expired'
  /**
   * Paper fill refused before `trade.fills` and before any ledger post.
   * The zero hold stays unfunded. Not a live match and not a second book.
   */
  | 'trade.paper_fill_refused'
  | 'trade.hold_uncovered'
  /**
   * The order's hold post ended without a verdict (timeout, deadline, network, 5xx, malformed ack): the ledger may or may
   * not have booked it. The pending order row is KEPT; a retry with the same clientOrderId re-drives the same hold key.
   */
  | 'trade.ledger_outcome_unknown'
  /**
   * Operator `reconcileOrder` funded engine-miss: `trade.fills` does not prove
   * no fill. Hold stays. Never an automatic refund (lost fill looks like this).
   */
  | 'trade.reconcile_unknown_engine_miss'
  | 'trade.convert_disabled'
  | 'trade.convert_no_liquidity'
  /** House inventory short at settle. Customer hold was released; request a new quote. Never the customer's shortfall. */
  | 'trade.convert_liquidity_unavailable'
  | 'trade.convert_insufficient_depth'
  | 'trade.convert_price_moved'
  | 'trade.convert_missing_id'
  | 'trade.convert_quote_missing'
  | 'trade.convert_quote_expired'
  | 'trade.convert_expiry_missing'
  | 'trade.convert_amounts_missing'
  | 'trade.convert_source_missing'
  | 'trade.convert_not_owner'
  | 'trade.convert_invalid_qty'
  | 'trade.convert_bad_depth'
  | 'trade.convert_bad_spread'
  | 'trade.convert_spread_unset'
  | 'trade.convert_quote_ttl_unset'
  | 'trade.convert_spread_too_high'
  /**
   * Market-buy hold refused: TRADE_MARKET_SLIPPAGE_CAP_BPS blank / non-integer /
   * out of 1–5000. Never invent 200.
   */
  | 'trade.slippage_cap_unset'
  /**
   * MM seed refused: TRADE_MM_SEED_HALF_SPREAD_BPS or TRADE_MM_SEED_STEP_BPS
   * blank / non-integer. Never invent 10.
   */
  | 'trade.mm_seed_bps_unset'
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
  | 'trade.rfq_missing_size'
  | 'trade.rfq_missing_price'
  | 'trade.rfq_already_bound'
  | 'trade.rfq_allocation_refused'
  | 'trade.rfq_give_up_refused'
  /** Algo (D-S-04 TWAP) kill-switch / schedule / state. */
  | 'trade.algo_disabled'
  | 'trade.algo_invalid_qty'
  | 'trade.algo_invalid_schedule'
  | 'trade.algo_unsupported_kind'
  | 'trade.algo_not_found'
  | 'trade.algo_duplicate_id'
  | 'trade.algo_bad_state'
  | 'trade.algo_no_liquidity'
  | 'trade.algo_price_band'
  | 'trade.algo_mark_unusable'
  | 'trade.algo_mark_missing'
  | 'trade.algo_insufficient_balance'
  | 'trade.algo_child_refused'
  | 'trade.algo_child_cancel_failed'
  | 'trade.algo_principal_unavailable'
  | 'trade.algo_market_closed'
  | 'trade.algo_volume_immature'
  | 'trade.algo_no_volume'
  /**
   * Resume would stretch the schedule past 2× the order's own durationMs
   * (ADR 2026-08-08). Trader may cancel-and-recreate; parent stays paused.
   */
  | 'trade.algo_resume_extends_too_far'
  | 'trade.algo_cancel_incomplete'
  /** Identity S2S ownership consult failed — refuse rather than store an unvalidated id */
  | 'trade.sub_account_unavailable'
  /** Missing or foreign sub-account (existence not leaked) */
  | 'trade.sub_account_denied'
  /** Caller owns the id but it is soft-revoked */
  | 'trade.sub_account_revoked'
  /**
   * Two DIFFERENT matches claimed one `(market, sequence, role)`.
   *
   * Not a redelivery — that case is absorbed silently and correctly. This is
   * the engine's business key being REUSED, which means `fillIdFor(market,
   * seq)` no longer identifies one match and the ledger's `trade.fill:<id>`
   * key would fold two trades onto one transaction. Loud on purpose; see
   * `settleFill`.
   */
  | 'trade.fill_sequence_conflict'
  | 'trade.engine_sequence_regressed'
  /** GTD/GTT placed without expireAt — the engine does not invent one. */
  | 'trade.missing_expire_at'
  /** Matching refused: its engine clock was not injected. */
  | 'trade.engine_clock_missing'
  /** OCO placed without a caller stopPrice on a leg — trade does not invent a trigger. */
  | 'trade.missing_oco_trigger'
  /** Matching refused: an OCO sibling is already terminal. Trade does not invent a trigger. */
  | 'trade.oco_sibling_terminal'
  /** Matching refused: account is flat on this book. Trade does not invent a mark. */
  | 'trade.position_flat'
  /** Post-only without a limit price — trade does not invent one. */
  | 'trade.invalid_tif'
  /** Order minQty above remaining qty — trade does not invent a clip. */
  | 'trade.min_qty_exceeds_qty'
  /** Iceberg without a visible peak — trade does not invent a display. */
  | 'trade.iceberg_display_missing'
  /** Iceberg display not smaller than total — trade does not invent a display. */
  | 'trade.iceberg_display_not_smaller'
  /** Option without a caller strike — trade does not invent a mark. */
  | 'trade.missing_strike'
  /** Option without a caller expiry — trade does not invent a mark. */
  | 'trade.missing_expiry'
  /** Option amend without a caller qty — trade does not invent a mark. */
  | 'trade.missing_qty'
  /** Stop-limit without a caller trigger — trade does not invent a stop. */
  | 'trade.missing_stop_price'
  /** Stop-limit without a limit price — trade does not invent a price. */
  | 'trade.missing_price'
  /** Trailing stop without a trail — trade does not invent a distance. */
  | 'trade.missing_trail'
  /** Trailing stop without a mark — trade does not invent a mark. */
  | 'trade.missing_mark'
  /** All-or-none plus iceberg — matching refuses aon_iceberg. Trade does not swallow it. */
  | 'trade.aon_iceberg'
  /** Pegged place — matching refuses peg_unsupported. Trade does not swallow it into a silent limit. */
  | 'trade.peg_unsupported'
  /** Midpoint place — matching refuses midpoint_unsupported. Trade does not invent a mid. */
  | 'trade.midpoint_unsupported'
  /** Relative place — matching refuses relative_unsupported. Trade does not invent a reference. */
  | 'trade.relative_unsupported'
  /** Auction place — matching refuses auction_unsupported. Trade does not swallow it into a silent limit. */
  | 'trade.auction_unsupported'
  /** Benchmark place — matching refuses benchmark_unsupported. Trade does not invent a benchmark price. */
  | 'trade.benchmark_unsupported'
  /** Matching refused: incoming would match the same account. Trade does not invent a self-fill. */
  | 'trade.self_trade'
  /** Collar requested without caller min and max. Trade does not invent last or mid. */
  | 'trade.missing_collar'
  /** Submit price is outside the caller collar. Trade does not invent last or mid. */
  | 'trade.outside_collar'
  /** Combo without named legs. Trade does not invent a combo book. */
  | 'trade.missing_combo_legs'
  /** Combo leg without a ratio. Trade does not invent a combo book. */
  | 'trade.missing_ratio'
  /** Combo take disagrees with the resting combo. Trade does not invent a match. */
  | 'trade.combo_disagrees'
  /** Combo is not independent option legs. Trade does not rest two holds and call it a combo. */
  | 'trade.combo_unsupported'
  /** Combo legs would each take a hold. Trade posts one hold, not per-leg invented money. */
  | 'trade.combo_double_hold'
  /**
   * Place/fill/ledger without session or API-key id from the signed principal
   * (R-auth / PTX-M01-R05). Trade does not invent a session.
   */
  | 'trade.auth_attribution_missing';

export class TradeError extends Error {
  constructor(
    message: string,
    readonly code: TradeErrorCode,
  ) {
    super(message);
    this.name = 'TradeError';
  }
}

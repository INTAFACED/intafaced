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
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'PO' | 'MOC' | 'GTD' | 'GTT';
export type OrderStatus = 'pending' | 'open' | 'filled' | 'cancelled' | 'rejected' | 'expired' | 'recovery_required' | 'hold_unknown';
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
  /** `pending` + zero hold, still inside the hold in-flight bound. Row stays. */
  | 'pending_in_flight'
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
  /** Human label. Absent on rows loaded before the column was selected. */
  readonly displayName?: string;
  /**
   * Local TEST swap. Hidden from the public board unless TRADE_FUTURES_TEST_SEED
   * is on. Never set by production config.
   */
  readonly test?: boolean;
  /** Explicit seed values. Null on every production listing. */
  readonly testFixture?: {
    readonly leverageCap: string;
    readonly markFeed: string;
    readonly liquidationPolicy: string | Record<string, unknown>;
  } | null;
  /**
   * Futures constitution style. `dated` requires expiry + owner fixing stamp.
   * Omitted / null on non-futures. kind=futures with null → perpetual (legacy rows).
   */
  readonly futuresContractStyle?: 'perpetual' | 'dated' | null;
  readonly futuresExpiryAt?: Date | null;
  /** Opaque owner fixing stamp on dated listings — never a settlement price. */
  readonly futuresSettlementFixing?: string | null;
  /**
   * Contract family (0078). `linear` is the only family that lists; `inverse` refuses
   * `trade.inverse_family_unsupported`. Null on non-futures and on futures rows that never recorded one.
   */
  readonly futuresFamily?: 'linear' | 'inverse' | null;
  /** Asset a futures market settles in. Null on non-futures. Never defaulted to anything but the quote asset. */
  readonly futuresSettleAsset?: string | null;
  /** Futures contract multiplier as recorded on the row. Null when the market never recorded one. */
  readonly contractSize?: Amount | null;
}

/** One amend or replace of an order, as listed by GET /api/v1/orders/:id/amendments. */
export interface OrderAmendment {
  readonly kind: 'amend' | 'replace';
  readonly at: string;
  /** Amend only: the quantity and price the order was amended to, decimal strings. */
  readonly quantity: string | null;
  readonly price: string | null;
  /** Amend only: the amend version. */
  readonly version: string | null;
  /** Replace only: the other order in the replace, and which way it points. */
  readonly relatedOrderId: string | null;
  readonly direction: 'replaced_by' | 'replaces' | null;
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
  /** The fee tier the order was placed at (the last finished tier snapshot then); its fills are charged at it. */
  readonly feeTier: string;
  /**
   * The platform token this order pays its fees in, and the stake discount off that fee it was placed at (fee-ifc.ts).
   * Absent or null: each fill's fee is taken in the asset it receives.
   */
  readonly feeCurrency?: string | null;
  readonly feeIfcDiscountBps?: number | null;
  /** The caller's own label from the create body. Null when none was sent. Never part of the idempotency key. */
  readonly tag: string | null;
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
  | 'LIFECYCLE_REFUSED'
  /** Owner pre-trade limit would refuse the replacement; the original was left untouched (#4725). */
  | 'LIMIT_REFUSED';

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
  /** A maker leg's rebate (rate, amount, the asset the maker paid). Never a negative fee. Absent or null = none. */
  readonly rebate?: { readonly bps: number; readonly amount: Amount; readonly asset: string } | null;
  /** Why a leg whose order chose the token paid in the asset it received (fee-ifc.ts). Absent or null = it did not. */
  readonly feeFallback?: string | null;
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
  | 'trade.mode_limit_only'
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
  /**
   * `order.hold` did not answer, and a read of `order.hold:<orderId>` did not
   * answer either. The row is `hold_unknown`. Retry the same clientOrderId.
   * Do not treat this as a cancel.
   */
  | 'trade.hold_unknown'
  /**
   * The lost `order.hold` reply was read back and the hold was not booked.
   * The intent row is gone. The same clientOrderId may be placed again.
   */
  | 'trade.hold_not_booked'
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
  /** The caller's own deadline passed before the create was read. Refused before any hold. */
  | 'trade.request_expired'
  /** A self-trade mode the engine does not run. */
  | 'trade.stp_mode_unsupported'
  /** Order tags are not stored yet. */
  | 'trade.tag_unsupported'
  | 'trade.invalid_tag'
  | 'trade.fee_currency_unsupported'
  /** Paying the fee in the platform token was asked and the owner's token fee terms (`ifcFee`) are unpublished. */
  | 'trade.fee_currency_ifc_unset'
  /** The token fee terms name no conversion for the asset this order would pay its fee in. */
  | 'trade.fee_ifc_index_unset'
  /** The stake discount could not be read from svc-token, so no token-fee order is taken. */
  | 'trade.fee_ifc_discount_unavailable'
  | 'trade.trigger_source_unset'
  | 'trade.invalid_qty'
  | 'trade.invalid_price'
  /** JSON number on an OCO/bracket leg — decimal string required. IEEE 0.1 is not a price. */
  | 'trade.ieee_money'
  | 'trade.below_min_notional'
  /** Place without clientOrderId — retry would open a second hold. */
  | 'trade.client_order_id_required'
  /** Same retry identity presented with a different persisted order command. */
  | 'trade.client_order_id_conflict'
  | 'trade.bracket_exit_failed'
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
  // The token buyback's IOC buy (buyback-order.ts): a house order on the other side, a bad command, a retry while the
  // first is still settling, the same run id for another command, and a book this service could not read for house asks.
  | 'trade.buyback_house_maker'
  | 'trade.buyback_invalid'
  | 'trade.buyback_in_flight'
  | 'trade.buyback_conflict'
  | 'trade.buyback_book_unreadable'
  | 'trade.seed_must_make'
  | 'trade.order_not_found'
  // An order-history page cursor that is not one of the caller's orders.
  | 'trade.invalid_cursor'
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
  /** A product's own maker/taker rate is unpublished. The spot rate is not charged in its place. */
  | 'trade.fee_product_unpublished'
  | 'trade.rebate_recipe_unavailable'
  | 'trade.min_fee_recipe_unavailable'
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
   * An engine cancel event says part of the order filled, and that fill is not
   * in `trade.fills` yet. Releasing now would hand back the hold the fill is
   * about to spend. Hold stays; the bus redelivers the cancel, within its delivery budget.
   */
  | 'trade.cancel_ahead_of_fill'
  /**
   * Operator `reconcileOrder` funded engine-miss: `trade.fills` does not prove
   * no fill. Hold stays. Never an automatic refund (lost fill looks like this).
   */
  | 'trade.reconcile_unknown_engine_miss'
  | 'trade.convert_disabled'
  | 'trade.standing_instruction_disabled'
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
  | 'trade.slippage_tolerance_invalid'
  /**
   * Market sell or flatten with no owner protection floor. Preview and place
   * both refuse. Never `orderable: true` with a null protection price.
   */
  | 'trade.protection_unset'
  /** No operator price band is published for the pair: a priced order is refused, never banded by a default. */
  | 'trade.price_band_unset'
  /** No operator open-order cap is published for the pair: an order that can rest is refused, never capped by a default. */
  | 'trade.open_orders_cap_unset'
  /**
   * Owner pre-trade limits (#4725): a published TRADE_MAX_ORDER / TRADE_MAX_POSITION /
   * TRADE_MAX_LOSS would be exceeded. The limit is the owner's, never invented.
   */
  | 'trade.limit_max_order'
  | 'trade.limit_max_position'
  | 'trade.limit_max_loss'
  /** Owner cap on resting orders per user (TRADE_MAX_OPEN_ORDERS), and its set-but-not-an-integer refusal. */
  | 'trade.limit_max_open_orders'
  | 'trade.max_open_orders_invalid'
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
  /** CB-otc-07: the owner has not set the desk minimum for this quote asset; the request refuses. */
  | 'trade.rfq_size_not_set'
  /** CB-otc-07: the request's notional at the reference mid is below the owner's desk minimum. */
  | 'trade.rfq_below_minimum'
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
  | 'trade.algo_mark_invalid'
  /** Mark policy key blank at creation. Names `AlgoMarkPolicy.maxAgeSeconds`. */
  | 'trade.algo_mark_policy_unset'
  | 'trade.algo_insufficient_balance'
  /** CB-bots-10: the owner has not set the verification level bots need. Every bot create refuses. */
  | 'trade.bots_verification_level_not_set'
  /** CB-bots-10: the caller's verification tier is below the owner's level for bots. `data.required` names it. */
  | 'trade.bots_verification_insufficient'
  /** Ledger balance read failed at creation. Never treated as enough funds. */
  | 'trade.algo_balance_unreadable'
  | 'trade.algo_child_refused'
  | 'trade.algo_child_cancel_failed'
  | 'trade.algo_principal_unavailable'
  | 'trade.algo_market_closed'
  | 'trade.algo_volume_immature'
  | 'trade.algo_no_volume'
  /** CB-execution-08: an algo kind the API names (trigger, OCO, conditional, trailing) that no engine runs yet. */
  | 'trade.algo_kind_not_built'
  /** CB-execution-08: a schedule's parameters are fixed at create, as in the web; amend is refused. */
  | 'trade.algo_params_immutable'
  /**
   * Resume would stretch the schedule past 2× the order's own durationMs
   * (ADR 2026-08-08). Trader may cancel-and-recreate; parent stays paused.
   */
  | 'trade.algo_resume_extends_too_far'
  | 'trade.algo_cancel_incomplete'
  | 'trade.algo_chase_distance_required'
  /** Identity S2S ownership consult failed — refuse rather than store an unvalidated id */
  | 'trade.sub_account_unavailable'
  /** Missing or foreign sub-account (existence not leaked) */
  | 'trade.sub_account_denied'
  /** Caller owns the id but it is soft-revoked */
  | 'trade.sub_account_revoked'
  /** The user's email is not proved yet; a new custodial order waits for it (RC-identity-01) */
  | 'trade.email_proof_required'
  /** Identity could not answer the email-proof read in a form we trust — refuse, never guess */
  | 'trade.identity_unavailable'
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
  | 'trade.invalid_expiry'
  /** Matching refused: its engine clock was not injected. */
  | 'trade.engine_clock_missing'
  /** OCO placed without a caller stopPrice on a leg — trade does not invent a trigger. */
  | 'trade.missing_oco_trigger'
  | 'trade.oco_stop_limit_required'
  | 'trade.oco_price_order'
  /** Cancel-all-after: timeout not one the owner published, or the credential would lapse before the deadline. */
  | 'trade.cancel_all_after_rejected'
  /** Cancel-all-after: the owner has published no timeouts. Trade does not invent one. */
  | 'trade.cancel_all_after_unset'
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
  /** REST iceberg door: peak is not a positive lot-multiple strictly below the order, or the order is not a limit in a PLACE lifecycle. */
  | 'trade.iceberg_display_invalid'
  | 'trade.iceberg_symbol_cap'
  | 'trade.stop_trigger_invalid'
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
  | 'trade.auth_attribution_missing'
  /** Operator fat-finger notional is set and this order is past it. */
  | 'trade.operator_fat_finger'
  /** Operator price band (collar, a fraction of the mid) is set and this order is priced outside it. */
  | 'trade.price_band'
  /** Operator open-order cap (throttle) is set and this account is already at it on this market. */
  | 'trade.operator_throttle'
  /** Operator circuit breaker is set and no reference mark is configured. */
  | 'trade.circuit_breaker_reference_unset'
  /**
   * Candle start/end/granularity would return more than the published point cap.
   * The request is refused whole — no trimmed series.
   */
  | 'trade.candles_range_point_cap'
  /**
   * Listing refused: the inverse contract family. No inverse P&L formula is published,
   * so none is invented here. Clears only when the owner publishes the formula.
   */
  | 'trade.inverse_family_unsupported'
  /**
   * Linear listing refused: the settle asset is not the quote asset. A cross-asset settle needs a
   * conversion rule nobody has published, so the settle asset is never defaulted to another asset.
   */
  | 'trade.futures_settle_asset_mismatch'
  /** USDC-settled linear listing refused until the owner configures that settle asset (TRADE_FUTURES_SETTLE_ASSETS). */
  | 'trade.futures_settle_asset_unconfigured'
  /** Family or settle asset supplied on a non-futures listing. Schema CHECK `markets_futures_family_terms_ck` is the same rule. */
  | 'trade.futures_family_terms_incomplete'
  /**
   * Pre-market conversion (or params read) refused: the owner has not set the flat funding rate
   * and the mark clamp band for this market. Blank stays blank; the market row is left as it was.
   */
  | 'trade.premarket_params_unset';

export class TradeError extends Error {
  /** Exact decimal strings and asset codes. Absent when the refusal has no amounts. */
  readonly data?: Readonly<Record<string, string>>;

  constructor(
    message: string,
    readonly code: TradeErrorCode,
    data?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'TradeError';
    this.data = data;
  }
}

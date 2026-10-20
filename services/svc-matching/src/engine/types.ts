import type { z } from 'zod';
import type { orderSideSchema, orderTypeSchema, timeInForceSchema } from '@intafaced/exchange-contract';
import type { Amount } from '@intafaced/ledger-client/money';

/**
 * Engine vocabulary (§5.1).
 *
 * Sides, order types and time-in-force are NOT redeclared here — they are
 * derived from `@intafaced/exchange-contract`, which is the published shape
 * every bot already speaks. A divergence between what the API accepts and what
 * the engine matches is the kind of bug that only shows up in production, so
 * the type system is made to forbid it.
 */

export type OrderSide = z.infer<typeof orderSideSchema>;
export type TimeInForce = z.infer<typeof timeInForceSchema>;

/**
 * §5.1 lists limit / market / stop / post-only. `take_profit` exists in the
 * public contract but is a svc-trade concern: it is a stop with inverted
 * trigger semantics that the product layer maps down to `stop`/`stop_limit`
 * before it ever reaches the engine. `triggerRole` on that mapped stop tells a take-profit from a stop-loss.
 */
export type EngineOrderType = Exclude<z.infer<typeof orderTypeSchema>, 'take_profit'>;

/**
 * §5.1: "No balances, no users — it speaks in account IDs". These are opaque
 * strings to this service. It never resolves one to a user, a balance, or a
 * ledger account.
 */
export type AccountId = string;
export type OrderId = string;
export type MarketId = string;

/**
 * An order as the engine sees it: pre-validated by svc-trade (risk, funding,
 * tick/lot size) and already denominated in scaled bigints.
 */
export interface EngineOrder {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly type: EngineOrderType;
  readonly side: OrderSide;
  readonly qty: Amount;
  /** Limit price. Required for `limit` and `stop_limit`, null otherwise. */
  readonly price: Amount | null;
  /** Trigger price. Required for `stop` and `stop_limit`, null otherwise. */
  readonly stopPrice: Amount | null;
  readonly tif: TimeInForce;
  /**
   * Caller-supplied session for cancel-on-disconnect. The engine never invents
   * this — missing sessionId is untagged, not a default session.
   */
  readonly sessionId?: string | null;
  /**
   * Caller-supplied client order id. Unique in the account/environment domain
   * (PX-S03 §5.1). Missing is allowed. The engine never invents this.
   */
  readonly clientOrderId?: string | null;
  /**
   * Caller-supplied environment for the client-id domain. Missing is empty in
   * the mill key, not a silent 'live' stamp.
   */
  readonly environment?: string | null;
  /**
   * Caller-supplied expire instant for GTD/GTT. ISO-8601. The engine never
   * invents this — missing expireAt refuses rather than defaulting EOD.
   */
  readonly expireAt?: string | null;
  /**
   * Linked sibling for a TP+SL pair (OCO). First fill of either cancels the
   * other. Absent when the order is not in a pair. The engine does not invent
   * a trigger — existing stop/stop_limit prices still fire the legs.
   */
  readonly ocoSiblingId?: OrderId | null;
  /** Existing linked bracket instruction and caller terms; journal replay preserves them. */
  readonly bracket?: boolean;
  /** One-cancels-other exit pair (take-profit + stop-loss). Journalled so replay reaches the same refuse or rest. */
  readonly oco?: boolean;
  readonly takeProfit?: Amount | null;
  readonly stopLoss?: Amount | null;
  /** Limit price of the stop-loss leg. Absent = the stop leg is a market stop (a sell has no worst price to fund). */
  readonly stopLossLimit?: Amount | null;
  readonly takeProfitOrderId?: OrderId | null;
  readonly stopLossOrderId?: OrderId | null;
  /**
   * Rest only if filling would shrink this account's position on this book.
   * Position is net fills. The engine does not invent a mark.
   */
  readonly reduceOnly?: boolean;
  /**
   * take-profit or stop-loss after the product maps the public type down.
   * Absent is stop-loss. The engine does not invent a last price for the side check.
   */
  readonly triggerRole?: 'take_profit' | 'stop_loss' | null;
  /**
   * Price that fires this stop. Absent is last. Mark and index do not fire on a last print,
   * and a missing or down feed is not retargeted onto last.
   */
  readonly triggerBy?: 'last' | 'mark' | 'index' | null;
  /** Option instrument. Absent is not an option. Trigger types on option and option_combo refuse. */
  readonly instrument?: 'option' | 'option_combo' | null;
  /**
   * Signed futures position for this account and market. Zero is flat.
   * When set, reduce-only uses it instead of the book net. Absent keeps the fill net.
   */
  readonly positionQty?: Amount | null;
  /**
   * Visible peak for an iceberg. Required when `iceberg` is set.
   * The engine does not invent a display.
   */
  readonly displayQty?: Amount | null;
  readonly iceberg?: boolean;
  /** Trail distance. Required to rest a trailing stop. The engine does not invent a distance. */
  readonly trail?: Amount | null;
  /** Injected mark the trail walks with. The engine does not invent a mark. */
  readonly mark?: Amount | null;
  /** Strike. Required to rest an option. The engine does not invent a strike. */
  readonly strike?: Amount | null;
  /** Expiry. Required to rest an option. ISO datetime. The engine does not invent an expiry. */
  readonly expiry?: string | null;
  /** Exercise a long option at strike. Matching refuses missing strike/expiry. The engine does not invent a mark. */
  readonly exercise?: boolean;
  /**
   * Minimum fill qty. Missing or zero is not set — the engine does not invent a default.
   * A clip below this floor does not occur.
   */
  readonly minQty?: Amount | null;
  /**
   * All-or-none. Missing or false is a normal order.
   * Fill the entire remaining qty or do not take a stub. The engine does not invent a fill.
   */
  readonly aon?: boolean;
  /**
   * Pegged to a caller reference + offset. Missing those refuses.
   * Missing or false is a normal order. The engine does not invent a mid.
   */
  readonly peg?: boolean;
  /**
   * Midpoint. Unsupported — refuses rather than becoming a limit.
   * Missing or false is a normal order. The engine does not invent a mid.
   */
  readonly midpoint?: boolean;
  /**
   * Relative to a caller reference + offset. Missing those refuses.
   * Missing or false is a normal order. The engine does not invent a mid.
   */
  readonly relative?: boolean;
  /** Caller reference for peg/relative. The engine does not invent a mid. */
  readonly reference?: Amount | null;
  /** Caller offset for peg/relative. Added to reference. Missing refuses. */
  readonly offset?: Amount | null;
  /**
   * Auction instruction. Unsupported — refuses rather than becoming a limit.
   * Missing or false is a normal order. The engine does not invent an auction price.
   */
  readonly auction?: boolean;
  /**
   * Benchmark instruction. Unsupported — refuses rather than becoming a limit.
   * Missing or false is a normal order. The engine does not invent a benchmark price.
   */
  readonly benchmark?: boolean;
  /**
   * Price collar. Missing or false is a normal order.
   * When true, caller min and max are required. The engine does not invent last or mid.
   */
  readonly collar?: boolean;
  /** Caller collar min. Missing when collar is requested refuses. */
  readonly min?: Amount | null;
  /** Caller collar max. Missing when collar is requested refuses. */
  readonly max?: Amount | null;
  /**
   * Caller min notional. Missing or zero is not requested.
   * When set, a missing notional (no caller price) refuses. The engine does not invent last.
   */
  readonly minNotional?: Amount | null;
  /**
   * Combo / multi-leg. Missing or false is a normal order.
   * Named legs with ratios are required. The engine does not invent a combo book
   * or silently rest two independent options.
   */
  readonly combo?: boolean;
  /** Named combo legs. Missing when combo is requested refuses. */
  readonly legs?: readonly ComboLeg[] | null;
  /**
   * Spread order (CB-otc-16). Absent is not a spread. The instrument is the owner listing the engine stamped at
   * admission, so a journalled order replays against the listing it was accepted under.
   */
  readonly spread?: SpreadTerms | null;
}

/** One named combo leg. Ratio/strike/expiry missing refuses. Qty/ratio are ledger Amounts. */
export interface ComboLeg {
  readonly name?: string | null;
  readonly ratio?: Amount | null;
  readonly strike?: Amount | null;
  readonly expiry?: string | null;
}

/** Calendar: one symbol at two expiries. Inter-coin: two coins at a fixed ratio. */
export type SpreadKind = 'calendar' | 'inter_coin';

/**
 * One leg of a listed spread, from the spread buyer's point of view: buying the spread buys every `buy` leg and
 * sells every `sell` leg, each `ratio` units per spread unit.
 */
export interface SpreadLegDefinition {
  readonly symbol: string;
  readonly side: OrderSide;
  /** Positive. Units of this leg per one unit of spread. */
  readonly ratio: Amount;
}

/**
 * An owner-listed spread instrument. Spread price = sum over legs of (+1 for buy, -1 for sell) x ratio x leg price,
 * so it may be zero or negative. `tick` is the spread price increment and `lot` the spread quantity increment.
 * Leg 0 is the anchor leg (priced at the caller reference); leg 1 is the residual leg.
 */
export interface SpreadInstrument {
  readonly spreadId: string;
  readonly kind: SpreadKind;
  readonly legs: readonly SpreadLegDefinition[];
  readonly tick: Amount;
  readonly lot: Amount;
}

/** What a spread order carries into the book. */
export interface SpreadTerms {
  readonly instrument: SpreadInstrument;
  /** Caller reference price for the anchor leg. Missing refuses. The engine does not invent a mark. */
  readonly anchorReference: Amount | null;
}

/** One leg of a spread fill. Every leg of one fill is printed together or not at all. */
export interface SpreadLegFill {
  readonly symbol: string;
  /** The taker's side on this leg. The maker takes the other side. */
  readonly takerSide: OrderSide;
  readonly qty: Amount;
  readonly price: Amount;
}

export const REJECT_CODES = [
  'invalid_qty',
  'invalid_price',
  'missing_price',
  'unexpected_price',
  'missing_stop_price',
  'unexpected_stop_price',
  'invalid_tif',
  'duplicate_order_id',
  'post_only_would_cross',
  'moc_would_take',
  'fok_unfillable',
  'engine_disabled',
  'order_not_found',
  'version_mismatch',
  'oco_sibling_terminal',
  'invalid_oco_sibling',
  'engine_clock_missing',
  'missing_expire_at',
  'already_expired',
  'would_increase_position',
  'position_flat',
  'trigger_wrong_side',
  'missing_last_price',
  'option_trigger_unsupported',
  'market_maintenance',
  'iceberg_display_missing',
  'iceberg_display_not_smaller',
  'missing_trail',
  'missing_mark',
  'missing_strike',
  'missing_expiry',
  'strike_disagrees',
  'expiry_disagrees',
  'min_qty_exceeds_qty',
  'aon_iceberg',
  'peg_unsupported',
  'midpoint_unsupported',
  'relative_unsupported',
  'missing_reference',
  'missing_offset',
  'auction_unsupported',
  'benchmark_unsupported',
  'missing_collar',
  'outside_collar',
  'missing_notional',
  'below_min_notional',
  'missing_combo_legs',
  'missing_ratio',
  'combo_unsupported',
  'combo_disagrees',
  'in_flight',
  'in_flight_unknown',
  'self_trade',
  'session_unsupported',
  'session_gone',
  'missing_session',
  'market_halted',
  'halt_restart_open',
  'venue_halted',
  'split_brain',
  'market_reduce_only',
  'market_post_only',
  'market_prelaunch',
  'market_expired',
  'market_delisted',
  'missing_operator',
  'amend_field_unsupported',
  'uncrossing_unset',
  'collar_unpublished',
  'fat_finger_unpublished',
  'throttle_unpublished',
  'severe_market_unset',
  'bulk_command_missing',
  'bulk_atomic_partial',
  'tif_missing',
  'client_order_id_reuse',
  'queue_probability_l2',
  'queue_probability_unset',
  'l3_unavailable',
  'l4_unpublished',
  'maker_identity_unpublished',
  'unsourced_depth',
  'rebate_program_unset',
  'rebate_wash',
  'missing_evidence',
  'delist_policy_missing',
  'permissionless_listing',
  /** Replay hold check could not be read. The book does not open. */
  'hold_check_unreachable',
  /** A replayed order's hold was not confirmed and cancel could not pull it. */
  'hold_unconfirmed',
  /** Spread listing (CB-otc-16): a blank or invalid owner field refuses; nothing is invented. */
  'spread_id_missing',
  'spread_id_collides',
  'spread_kind_unsupported',
  'spread_legs_invalid',
  'spread_leg_symbol_missing',
  'spread_leg_side_missing',
  'spread_ratio_missing',
  'spread_tick_missing',
  'spread_lot_missing',
  'spread_size_inexact',
  'spread_listing_conflict',
  /** Spread orders. */
  'spread_unlisted',
  'spread_book_outright_refused',
  'spread_identity_disagrees',
  'spread_order_unsupported',
  'spread_price_off_tick',
  'spread_qty_off_lot',
  'spread_reference_missing',
  'spread_leg_unfillable',
  'spread_leg_unavailable',
  'spread_fill_event_unwired',
  'spread_amend_unsupported',
] as const;

export type RejectCode = (typeof REJECT_CODES)[number];

export interface RejectReason {
  readonly code: RejectCode;
  readonly message: string;
}

/** A match. `price` is always the resting (maker) order's price — the taker pays the book. */
export interface Fill {
  readonly sequence: number;
  readonly makerOrderId: OrderId;
  readonly makerAccountId: AccountId;
  readonly takerOrderId: OrderId;
  readonly takerAccountId: AccountId;
  /** Side of the aggressor. The maker is by definition on the other side. */
  readonly takerSide: OrderSide;
  /** On a spread book this is the spread price, which may be zero or negative. */
  readonly price: Amount;
  readonly qty: Amount;
  /** Spread fills only: every leg's qty and price, in listing order. Absent on an outright fill. */
  readonly legs?: readonly SpreadLegFill[];
}

/** Where an order came to rest: the limit book, or the pending-trigger stop book. */
export interface RestingRef {
  readonly kind: 'book' | 'stop';
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly side: OrderSide;
  /** Limit price for `book`, trigger price for `stop`. */
  readonly price: Amount;
  readonly remaining: Amount;
  readonly sequence: number;
  /** Instruction version — increments on every accepted amend; independent of queue sequence. */
  readonly version: number;
}

export const CANCEL_REASONS = [
  'requested',
  'self_trade_prevention',
  'ioc_remainder',
  'market_remainder',
  'trigger_rejected',
  'oco_sibling_filled',
  'expired',
  'would_increase_position',
  'reduce_only_displaced',
  'session_dead',
  /**
   * Pulled at replay because the ledger hold was missing, smaller than the
   * remaining size, or unreadable. The normal cancel path so trade releases
   * whatever hold is still there.
   */
  'hold_unconfirmed',
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * Quantity that left the engine without filling. Unified across "the taker's
 * unfillable remainder" and other pulls that release a ledger hold.
 */
export interface CancelledRef {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly remainingQty: Amount;
  readonly sequence: number;
  readonly reason: CancelReason;
}

/** Named matching-abuse evidence. Open only — not a sanction or a money movement. */
export interface EngineSurveillanceCase {
  readonly accountId: AccountId;
  readonly marketId: MarketId;
  readonly reason: 'self_trade' | 'spoofing' | 'layering';
  readonly status: 'open';
}

/** What a stop order did once its trigger fired. */
export interface TriggerOutcome {
  readonly orderId: OrderId;
  /** Sequence assigned at activation — the resting remainder's time priority starts here, not when the stop was accepted. */
  readonly sequence: number;
  readonly fills: readonly Fill[];
  readonly resting: RestingRef | null;
  readonly cancellations: readonly CancelledRef[];
  readonly rejected?: RejectReason;
  /** Present when this trigger's match expired a self-rest. Evidence only. */
  readonly surveillanceCases?: readonly EngineSurveillanceCase[];
}

/**
 * The result of `submit`. A pure function of (book state, order): the same book
 * and the same order always produce the same result, byte for byte.
 *
 * Beyond the four fields §5.1 names, two more are carried because dropping them
 * would force the caller to diff book states to learn what happened:
 *   - `cancellations` — quantity that must have its ledger hold released.
 *   - `triggered`     — stop orders this submission's prints activated.
 *   - `surveillanceCases` — STP (and later named abuse) evidence; absent when none.
 */
export interface SubmitResult {
  readonly accepted: boolean;
  /** Assigned only on acceptance; a rejected order never touched the book and never consumes a sequence. */
  readonly sequence: number | null;
  readonly fills: readonly Fill[];
  readonly resting: RestingRef | null;
  readonly rejected?: RejectReason;
  readonly cancellations: readonly CancelledRef[];
  readonly triggered: readonly TriggerOutcome[];
  /** Present when this submit expired a self-rest. Evidence only — not a fine. */
  readonly surveillanceCases?: readonly EngineSurveillanceCase[];
}

export interface CancelResult {
  readonly cancelled: boolean;
  readonly orderId: OrderId;
  readonly sequence: number | null;
  readonly cancellation: CancelledRef | null;
  /** Present when cancel is refused (in-flight) rather than missing. */
  readonly rejected?: RejectReason;
}

/**
 * Pull live rest/stop for one account on one book.
 * Present side is that side only. Session is not an engine field — a session id refuses rather than inventing one.
 */
export interface MassCancelFailure {
  readonly orderId: OrderId;
  readonly reason: string;
}

export interface MassCancelResult {
  readonly accepted: boolean;
  readonly accountId: AccountId;
  readonly cancellations: readonly CancelledRef[];
  /** Per-id cancel failures. Empty when none. A failure does not abort the rest. */
  readonly failed?: readonly MassCancelFailure[];
  readonly rejected?: RejectReason;
}

/**
 * Session-dead (cancel-on-disconnect). Caller sessionId. Missing session refuses.
 * Cancels tagged rests on every book. New tagged submits refuse. Not mass-cancel.
 */
export interface SessionDeadResult {
  readonly accepted: boolean;
  readonly sessionId: string | null;
  readonly cancellations: readonly CancelledRef[];
  /** Per-id cancel failures. Empty when none. A failure does not abort the rest. */
  readonly failed?: readonly MassCancelFailure[];
  readonly rejected?: RejectReason;
}

/** Operator maintenance of one market. Not halt. Cancels refuse. Dual-control. No duration. */
export interface MarketMaintenanceResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly maintenance: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId?: string | null;
  readonly rejected?: RejectReason;
}

/** One quiet-book expiry pass. A miss leaves the order. */
export interface ExpirySweepResult {
  readonly accepted: boolean;
  readonly cancelled: readonly CancelledRef[];
  readonly misses: readonly { readonly marketId: MarketId; readonly code: 'book_unreadable'; readonly reason: string }[];
  readonly rejected?: RejectReason;
}

/** Operator halt/resume of one market. Dual-control: operatorId + confirmOperatorId. No duration. */
export interface MarketHaltResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly halted: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId?: string | null;
  readonly rejected?: RejectReason;
}

/** Operator halt-all / resume-all. Dual-control: operatorId + confirmOperatorId. No duration. Not one-market halt. */
export interface VenueKillResult {
  readonly accepted: boolean;
  readonly halted: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId?: string | null;
  readonly rejected?: RejectReason;
}

/** Declared split-brain. Dual-control. New submits/amends refuse. Cancels stay. */
export interface SplitBrainResult {
  readonly accepted: boolean;
  readonly splitBrain: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId: string | null;
  readonly rejected?: RejectReason;
}

/** Operator reduce-only/resume of one market. Dual-control: operatorId + confirmOperatorId. No duration. Not halt. */
export interface MarketReduceOnlyResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly reduceOnly: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId?: string | null;
  readonly rejected?: RejectReason;
}

/** Operator post-only/resume of one market. Dual-control: operatorId + confirmOperatorId. No duration. Not halt. */
export interface MarketPostOnlyResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly postOnly: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId?: string | null;
  readonly rejected?: RejectReason;
}

/** Operator prelaunch/open of one market. Dual-control: operatorId + confirmOperatorId. No duration. Not halt. */
export interface MarketPrelaunchResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly prelaunch: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId?: string | null;
  readonly rejected?: RejectReason;
}

/** Operator expire of one market. Dual-control: operatorId + confirmOperatorId. No notice period. Not halt. */
export interface MarketExpireResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly expired: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId?: string | null;
  readonly rejected?: RejectReason;
}

/** Operator delist of one market. Dual-control: operatorId + confirmOperatorId. No notice period. Not halt. */
export interface MarketDelistResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly delisted: boolean;
  readonly operatorId: string | null;
  readonly confirmOperatorId?: string | null;
  readonly rejected?: RejectReason;
}

/**
 * Uncross / enter-auction / leave-auction. Uncrossing rules unset refuse.
 * No invented auction price. fills is always empty on refuse.
 */
export interface AuctionUncrossResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly fills: readonly Fill[];
  readonly rejected?: RejectReason;
}

/**
 * applyCollar / collarBand / fat-finger / throttle / enterSevereMarket.
 * Owner magnitudes blank refuse unpublished, never a 0-width band.
 * Severe-market missing/false is not severe. Do not invent a collar.
 */
export interface CollarResult {
  readonly accepted: boolean;
  readonly marketId: MarketId;
  readonly rejected?: RejectReason;
}

/** Alias for the owner-policy mill. band is always null — unpublished is not zero. */
export type CollarPolicyResult = CollarResult & {
  readonly unpublished: true;
  readonly band: null;
};

/**
 * Native amend (PX-S03 §8.2). One engine command, never cancel-plus-new.
 *
 * Omitted patch fields inherit. `qty` is the new remaining quantity the engine
 * is holding — already-filled quantity is not stored here and cannot be moved.
 */
export interface EngineAmend {
  readonly orderId: OrderId;
  readonly expectedVersion: number;
  readonly qty?: Amount;
  readonly price?: Amount;
  readonly stopPrice?: Amount;
  readonly tif?: TimeInForce;
  readonly expireAt?: string;
  /** Existing option identity confirmations, not a contract mutation. */
  readonly strike?: Amount | null;
  readonly expiry?: string | null;
}

/** Outcome of a server-side mark. `applied` is true only when a trailing stop's peak or trigger moved. */
export interface MarkResult {
  readonly accepted: boolean;
  readonly applied: boolean;
  readonly rejected: { readonly code: string; readonly message: string } | null;
}

export type AmendPriority = 'retained' | 'lost';

export interface AmendResult {
  readonly accepted: boolean;
  readonly orderId: OrderId;
  /** Queue sequence after the command — unchanged when priority is retained. */
  readonly sequence: number | null;
  readonly version: number | null;
  readonly priority: AmendPriority | null;
  readonly fills: readonly Fill[];
  readonly resting: RestingRef | null;
  readonly rejected?: RejectReason;
  readonly cancellations: readonly CancelledRef[];
  readonly triggered: readonly TriggerOutcome[];
  /** Present when this amend expired a self-rest. Evidence only — not a fine. */
  readonly surveillanceCases?: readonly EngineSurveillanceCase[];
}

// ── Serialised state (§5.1 replay + §5.4 determinism) ────────────────

/**
 * The wire and snapshot form of the book. Every value is a decimal string:
 * a snapshot that round-trips through JSON must not lose a single unit at the
 * 18th decimal place, and `JSON.stringify(0.1 + 0.2)` is why.
 */
export interface RestingOrderState {
  readonly orderId: string;
  readonly accountId: string;
  readonly remaining: string;
  readonly sequence: number;
  /** Absent on pre-amend snapshots; restore treats missing as 1. */
  readonly version?: number;
  /** Present only when this resting order is in an OCO pair. */
  readonly ocoSiblingId?: string;
  /** Present only on GTD/GTT. Caller instant; never invented. */
  readonly expireAt?: string;
  /** Present only when the caller tagged a session. Never invented. */
  readonly sessionId?: string;
  /** Present only when the rest is reduce-only. */
  readonly reduceOnly?: boolean;
  /** Present only when the rest is post-only. A later amend must not take. */
  readonly postOnly?: boolean;
  /** Peak display. Absent when the rest is not an iceberg. */
  readonly displayQty?: string;
  /** Currently visible slice. Hidden is remaining minus this. */
  readonly displayRemaining?: string;
  /** Minimum fill qty. Absent when not set. */
  readonly minQty?: string;
  /** Present only when the rest is all-or-none. */
  readonly aon?: boolean;
}

export interface PriceLevelState {
  readonly price: string;
  readonly orders: readonly RestingOrderState[];
}

export interface StopOrderState {
  readonly orderId: string;
  readonly accountId: string;
  readonly type: EngineOrderType;
  readonly side: OrderSide;
  readonly qty: string;
  readonly price: string | null;
  readonly stopPrice: string;
  readonly tif: TimeInForce;
  readonly sequence: number;
  readonly version?: number;
  readonly ocoSiblingId?: string;
  readonly expireAt?: string;
  /** Present only when the caller tagged a session. Never invented. */
  readonly sessionId?: string;
  readonly reduceOnly?: boolean;
  /** Absent on a legacy stop. take_profit and stop_loss name the direction rule. */
  readonly triggerRole?: 'take_profit' | 'stop_loss';
  /** Present only when the trigger is mark or index. Absent is last. */
  readonly triggerBy?: 'mark' | 'index';
  /** Minimum fill qty. Absent when not set. */
  readonly minQty?: string;
  /** Present only when the stop is all-or-none. */
  readonly aon?: boolean;
  /** Trail distance. Absent when the stop does not walk. Decimal string. */
  readonly trail?: string;
  /** Extreme the trail follows. Absent when the stop does not walk. Decimal string. */
  readonly peak?: string;
}

export interface BookState {
  readonly marketId: string;
  readonly sequence: number;
  readonly lastTradePrice: string | null;
  /** Descending by price. */
  readonly bids: readonly PriceLevelState[];
  /** Ascending by price. */
  readonly asks: readonly PriceLevelState[];
  /** Ascending by acceptance sequence — that ordering is what makes trigger cascades deterministic. */
  readonly stops: readonly StopOrderState[];
  /**
   * OCO members that have already left the book (filled or cancelled). Absent when empty so a book that never linked a pair serialises identically.
   */
  readonly ocoTerminal?: readonly string[];
  /**
   * Accepted order ids that are no longer live (filled, cancelled, or never-rested).
   * Absent when empty. A 200 retry must not rest or fill again under the same id.
   */
  readonly acceptedOrderIds?: readonly string[];
  /**
   * Net fill qty per account on this book (signed decimal). Absent when flat.
   * Never a mark.
   */
  readonly positions?: readonly { readonly accountId: string; readonly qty: string }[];
  /**
   * Signed futures position used for reduce-only. Absent when the book net is the position.
   * Zero is flat and is kept, unlike the fill net.
   */
  readonly futuresPositions?: readonly { readonly accountId: string; readonly qty: string }[];
  /**
   * Open STP (and later named abuse) cases. Absent when none.
   * Evidence only — never a fine, never auto-closed.
   */
  readonly surveillanceCases?: readonly EngineSurveillanceCase[];
}

export interface EngineLiveOrder {
  readonly marketId: MarketId;
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly kind: 'book' | 'stop';
  readonly side: OrderSide;
  readonly price: string;
  readonly remaining: string;
  readonly sequence: number;
  readonly version: number;
}

/**
 * One resting order as the replay hold check sees it.
 * `fundingPrice` is the limit the hold was sized against. A market stop has
 * none — the engine cannot confirm a notional it does not have.
 */
export interface RestingHoldSubject {
  readonly marketId: MarketId;
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly side: OrderSide;
  readonly remaining: string;
  readonly fundingPrice: string | null;
  readonly sequence: number;
}

export type BulkItemStatus = 'APPLIED' | 'REFUSED' | 'OUTCOME_UNKNOWN';

export interface BulkItemResult {
  readonly index: number;
  readonly status: BulkItemStatus;
  readonly orderId?: OrderId;
  readonly rejected?: RejectReason;
}

export interface BulkCommandResult {
  readonly commandId: string | null;
  readonly atomic: boolean;
  readonly results: readonly BulkItemResult[];
}

/**
 * svc-trade — THE PRODUCT LAYER (§5.2).
 *
 * The engine is pure because this file makes it safe to be. §5.1 lets
 * svc-matching hold no balances and validate no affordability, on one
 * condition: **every order it ever sees is already funded.** This service is
 * that condition.
 *
 * THE ORDER FLOW, in the order §5.2 specifies and in the order the code runs:
 *
 *   1. auth + scope check (`trade:write`)
 *   2. risk checks — market status, tick/lot grid, size limits, min notional
 *   3. `ledger.post(recipes.orderHold(...))` — quote for buys, base for sells
 *   4. submit to the matching engine
 *   5. on Fill    → `ledger.post(recipes.tradeFill(...))`
 *   6. on Cancel  → `ledger.post(recipes.orderHoldRelease(...))`
 *
 * Step 3 before step 4 is the whole design. Reverse them and a fill can print
 * against money that is not there — and a printed fill cannot be un-printed,
 * because the counterparty has already been told they traded.
 *
 * DOCTRINE §0.6 — this service holds no balances. `orders.filled_qty` is order
 * state in the base asset. `orders.hold_amount` is an immutable record of a
 * ledger post, written once. Native qty-down records proven releases in
 * `amend_released`. Remainder owed back is derived from fills plus that column.
 */

import type { Sql } from 'postgres';
import { TradingControlError, type TradingAdmissionPort, type TradingOperationKind } from '../controls/trading-controls.js';
import type { BotVerificationPolicy } from '../algo/bots-verification.js';
import type { Timeframe } from '@intafaced/exchange-contract';
import type { EventBus } from '@intafaced/events';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, InsufficientFundsError, parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { queryTakerVolumeFromFills } from './candles.js';
import { listAlgoParents, type AlgoListQuery } from '../algo/algo-list.js';
import { type AlgoResult } from '../algo/algo-result.js';
import { type AlgoSchedulerView } from '../algo/scheduler-heartbeat.js';
import { describeAlgoPolicy, type AlgoPolicySummary } from '../algo/algo-policy.js';
import { listOptionsCatalogue, type OptionsCatalogueQuery } from './options-catalogue.js';
import {
  optionsExercises as optionsExercisesDoor,
  optionsMarginPreview as optionsMarginPreviewDoor,
  optionsPositions as optionsPositionsDoor,
} from './options-doors.js';
import { exportRfqHistory, listRfqHistory, type RfqListQuery } from '../otc/rfq-history.js';
import { cancelScaleGroup, createScaleGroup, getScaleGroup, type ScaleCreateInput } from './scale-group.js';
import { appendOrderEvent, listAlgoReports, parentIdFromClientOrder, type OrderEventKind } from '../orders/order-events.js';
import { UNPUBLISHED_FEE_SCHEDULE, type OwnerFeeSchedule } from './fee-schedule.js';
import { feeScheduleAt as feeScheduleAtStore } from './fee-schedule-store.js';
import { feeTierAt as feeTierAtStore } from './fee-tier-store.js';
import { operatorSlippageCapBps, type Touch } from '../admin/risk.js';
import { type HoldRead, type HoldUnknownAlert, type HoldUnknownSweepResult } from './hold-outcome.js';
import { toMarket, toOrder, type OrderRow } from './rows.js';
import { loadListedMarketRows, loadMarketBySymbol } from '../futures/futures-reads.js';
import type { RankPerksSource } from './rank-perks.js';
import { UNWIRED_IFC_DISCOUNT, type IfcDiscountSource } from './fee-ifc.js';
import { NoopAffiliateAccrue, type AffiliateAccruePort } from './affiliate-accrue.js';
import { NoopAffiliatePayout, type AffiliatePayoutPort } from './affiliate-payout.js';
import { NoopDropCopyIngest, type DropCopyFillWire, type DropCopyHitchSource, type DropCopyIngestPort } from './drop-copy-ingest.js';
import { NoSubAccounts, type SubAccountOwnershipSource } from './sub-account-ownership.js';
import { type EmailProofSource } from './email-proof.js';
import {
  type EngineCancellation,
  type EngineFill,
  type EngineSubmitRequest,
  type EngineSubmitResult,
  type MatchingClient,
} from './matching-client.js';
import { type ConvertTradeWire } from '../convert/quote.js';
import { checkMaxOpenOrders, checkMaxOrder, resolveAdmissionLimits, resolveOpenOrdersCap } from '../futures/pretrade-limits.js';
import { SqlConvertQuoteStore, type ConvertQuoteStore } from '../convert/quote-store.js';
import { exportConvertHistory, listConvertHistory, readConvertStatus, type ConvertListQuery } from '../convert/convert-history.js';
import { type AuthAttribution } from './auth-attribution.js';
import {
  SqlTwapParentStore,
  TwapEngine,
  type AlgoProgressView,
  type AlgoQuotedMark,
  type TwapParent,
  type TwapParentStore,
} from '../algo/index.js';
import { DEFAULT_ALGO_MARK_POLICY, type AlgoMarkPolicy } from '../algo/mark-gate.js';
import type { TwapParentRecord } from '../algo/parent-store.js';
import { hydrateAlgoIfMissing, persistAlgoMutation } from '../algo/hydrate-on-mutate.js';
import type { MarketLifecyclePort } from '../market-lifecycle.js';
import type { QuotedMarkSource } from '../futures/liquidation-tick.js';
import { createLifecycleAdmissionProof, type LifecycleAdmissionProof } from '../lifecycle-proof.js';
import {
  TradeError,
  type FillRecord,
  type Market,
  type MarketKind,
  type OrderAmendment,
  type OrderRecord,
  type OrderSide,
  type OrderStatus,
  type AmendOrderOutcome,
  type AmendOutcomeCode,
  type AmendPriority,
  type ReplaceOrderOutcome,
  type ReplaceOutcomeCode,
  type OrderType,
  type RecoveryReason,
  type PublicTapePrint,
  type ReconcileResult,
  type TimeInForce,
  type TradeErrorCode,
} from './types.js';
import * as listings from './trade-service/listings.js';
import * as convert from './trade-service/convert.js';
import * as orderPlace from './trade-service/order-place.js';
import * as orderChange from './trade-service/order-change.js';
import * as fillFlow from './trade-service/fills.js';
import * as holds from './trade-service/holds.js';
import * as events from './trade-service/events.js';
import * as reads from './trade-service/reads.js';
import * as reconcile from './trade-service/reconcile.js';
import * as twap from './trade-service/algo.js';

export {
  assertSamePlaceCommand,
  fillsProveNoFill,
  publishedAdminOpenOrdersLimit,
  publishedFillsMineLimit,
  publishedOpenOrdersLimit,
  publishedOrderHistoryLimit,
  publishedPublicTapeLimit,
  PUBLIC_TAPE_LIMIT_MAX,
  PublicTapeLimitUnsetError,
  TRADE_PUBLIC_TAPE_LIMIT_UNSET,
  ORDER_HISTORY_LIMIT_MAX,
  OrderHistoryLimitUnsetError,
  TRADE_ORDER_HISTORY_LIMIT_UNSET,
  OPEN_ORDERS_LIMIT_MAX,
  OpenOrdersLimitUnsetError,
  TRADE_OPEN_ORDERS_LIMIT_UNSET,
  FILLS_MINE_LIMIT_MAX,
  FillsMineLimitUnsetError,
  TRADE_FILLS_MINE_LIMIT_UNSET,
  ADMIN_OPEN_ORDERS_LIMIT_MAX,
  AdminOpenOrdersLimitUnsetError,
  TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET,
  replacementClientOrderId,
} from './trade-service/internal.js';

export interface TradeServiceOptions {
  /** Mandatory for fresh exposure; absent refuses while cancels/recovery remain. */
  accountAdmission?: TradingAdmissionPort;
  /** PX-S01 authority port; absent means new placement is refused. */
  marketLifecycle?: MarketLifecyclePort;
  /** Mirror of the `trade.spot` flag. OFF refuses new orders; cancels still work. */
  spotEnabled?: boolean;
  /**
   * Mirror of `TRADE_FUTURES_ENABLED` (`trade.futures` / D-S-01).
   *
   * DEFAULT FALSE — the one option in this interface whose default is the
   * restrictive reading and which nothing in the repo sets to `true` except an
   * operator's environment and the tests that prove both directions. OFF refuses
   * new orders on a futures market with `trade.futures_disabled`; cancels still
   * work, because a switch that traps funds is not a safety control.
   *
   * Orderability is all it grants. It does not open a margin position, does not
   * enable funding, and does not pick a leverage — see `assertTradable`.
   */
  futuresEnabled?: boolean;
  /**
   * TRADE_FUTURES_TEST_SEED. Default false. When false, `test` listings are
   * omitted from the public board and from symbol lookup. Does not enable futures.
   */
  futuresTestSeed?: boolean;
  /**
   * Opaque D26-P0-05 settlement-asset-law stamp
   * (`TRADE_OPTIONS_SETTLEMENT_ASSET_LAW`).
   *
   * EMPTY BY DEFAULT. Presence only — never parsed for live set, settlement
   * asset, or refuse matrix (SOCKET §13 `socket.options-settlement-asset-law`).
   * Empty → listMarket refuses kind=options with `trade.options_settlement_law_unset`.
   */
  optionsSettlementAssetLaw?: string;
  /**
   * Opaque D7 settlement-fixing config (`TRADE_OPTIONS_SETTLEMENT_FIXING`).
   *
   * EMPTY BY DEFAULT. Presence is the only signal — never parsed for source,
   * window, or payor account (those are owner law). Empty → listMarket refuses
   * kind=options with `trade.options_fixing_unconfigured` (after P0-05 is set).
   */
  optionsSettlementFixing?: string;
  /**
   * Opaque dated-futures settlement-fixing config (`TRADE_FUTURES_SETTLEMENT_FIXING`).
   *
   * EMPTY BY DEFAULT. Presence is the only signal — never parsed for source,
   * window, or settlement price. Empty → listMarket refuses style=dated with
   * `trade.dated_futures_fixing_unconfigured`. Perpetual listings ignore it.
   */
  futuresSettlementFixing?: string;
  /**
   * Owner-configured futures settle assets (`TRADE_FUTURES_SETTLE_ASSETS`, comma-separated).
   *
   * EMPTY BY DEFAULT. A linear USDT contract settles in its quote asset and needs nothing here. A USDC-settled
   * linear listing refuses `trade.futures_settle_asset_unconfigured` until `USDC` is named. Presence only:
   * it never changes which asset a listing settles in and never converts between assets.
   */
  futuresSettleAssets?: readonly string[];
  /**
   * Seed/mm bot place path (SD-4 kill-switch). OFF refuses `seeded: true` places.
   * Default false — seed must be deliberately enabled.
   */
  seedPlaceEnabled?: boolean;
  /**
   * How far above the best ask a market buy may be funded. See `protectionPriceFor`.
   * Unset / non-integer → market-buy hold refuses. Never invent 200.
   */
  marketSlippageCapBps?: number | null;
  /**
   * Slice mark policy. Omitted uses `DEFAULT_ALGO_MARK_POLICY` (the existing
   * supply). A passed policy with a blank `maxAgeSeconds` is kept and the
   * creation gate refuses it — this field does not invent a replacement.
   */
  algoMarkPolicy?: AlgoMarkPolicy;
  /**
   * CB-bots-10 verification gate for every bot create. The boot passes `loadBotVerificationPolicy(process.env)` (required by
   * default; a blank level refuses every bot). Omitted: fails closed as `{ mode: 'required', level: null }`, so every bot
   * create refuses `trade.bots_verification_level_not_set`. Only an explicit `{ mode: 'off' }` turns the gate off.
   */
  botVerification?: BotVerificationPolicy;
  /**
   * Where a trailing stop's starting mark comes from. Unset: placing a trailing stop takes no mark from the caller
   * and refuses `trade.missing_mark`. Never a customer value.
   */
  trailingMarkSource?: QuotedMarkSource;
  /**
   * PTX-M21 owner fee/rebate schedule (`TRADE_FEE_SCHEDULE`).
   * Default unpublished — place/fill refuse; never listing-row 10/20.
   */
  feeSchedule?: OwnerFeeSchedule;
  /** Mirror of the `trade.convert` flag. OFF refuses convert quote + execute. */
  convertEnabled?: boolean;
  /**
   * Opens the svc-bank standing-instruction convert door. Default OFF: identity
   * must be able to decide the `standing_instruction` authority first.
   */
  standingInstructionsEnabled?: boolean;
  /**
   * Extra house edge on convert quotes, in bps of book notional.
   * Disclosed on the firm quote; accept settles that number — never a second fee.
   * Unset / non-integer → convert quote/execute refuse. Never invent 10.
   */
  convertSpreadBps?: number | null;
  /**
   * How long a firm quote is valid (ms). Accept after expiry refuses.
   * Unset / non-integer / non-positive → convert quote/execute refuse. Never invent 15000.
   */
  convertQuoteTtlMs?: number | null;
  /** Durable convert quotes. Tests inject MemoryConvertQuoteStore. */
  convertStore?: ConvertQuoteStore;
  /** Kill-switch for TWAP algo (D-S-04). OFF refuses create; cancel/pause still work. */
  algoEnabled?: boolean;
  /**
   * TRADE_ALGO_JOBS_ENABLED. Default false. This service does not turn it on.
   * The scheduler view reads the value it was given.
   */
  algoJobsEnabled?: boolean;
  /**
   * The algo.twap loop's own intervalMs. Null while the flag is off is fine.
   * Jobs on with a blank interval answers jobs_interval_unset. Never invent 1000 here.
   */
  algoJobsIntervalMs?: number | null;
  /**
   * The clock the venue-hours check reads.
   *
   * `risk.ts` deliberately takes `at` as a parameter so a session boundary can
   * be tested; that only buys anything if the boundary is reachable from the
   * outside too. Without this seam the *ordering* claim — refused before any
   * hold is taken — could only be verified by reading the code, and on 5 days
   * out of 7 a test asserting it would pass for the wrong reason.
   *
   * Production leaves it unset and gets the real clock.
   */
  now?: () => Date;
  /**
   * Identity S2S ownership source for `subAccountId` on placeOrder.
   * Defaults to a source that answers "unknown" for every id (fail-closed:
   * any supplied subAccountId is denied until a real client is injected).
   */
  subAccounts?: SubAccountOwnershipSource;
  /**
   * Identity email-proof read for new custodial orders (RC-identity-01).
   * No default: unset refuses every new live order `trade.identity_unavailable`.
   */
  emailProof?: EmailProofSource;
  /**
   * Tests only: let an order through on a pair with no published price band or open-order cap. Production never sets
   * it, so an unpublished band or cap refuses (`trade.price_band_unset`, `trade.open_orders_cap_unset`).
   */
  allowUnpublishedPairRules?: boolean;
  /** Override TWAP durable store (tests inject MemoryTwapParentStore). */
  algoStore?: TwapParentStore;
  /**
   * D26-P1-O2: after a fill posts house fees, claim affiliate rows (best-effort).
   * Default noop — tests stay hermetic; production injects the identity HTTP client.
   */
  affiliateAccrue?: AffiliateAccruePort;

  /**
   * Identity affiliate payout after accrue. Default noop. Failures must not
   * unwind the fill. Body is `{ feeEventId }` only.
   */
  affiliatePayout?: AffiliatePayoutPort;

  /**
   * FIX drop-copy ingest after a real house fill. Default noop (ingest dark).
   * Failures must not unwind the ledger settle.
   */
  dropCopyIngest?: DropCopyIngestPort;
  /**
   * After a spot fill is stored. Copy records a partial or filled trail row
   * when the order is a placed mirror. A throwing sink is logged and does
   * not unwind the fill.
   */
  onCopyMirrorFill?: (notice: { orderId: string; fillId: string; side: 'buy' | 'sell'; price: Amount; qty: Amount }) => Promise<void>;
  /**
   * Fired when an `order.hold` reply stays unknown, and when the sweep
   * resolves a `hold_unknown` row. A throwing sink does not change the money
   * decision.
   */
  onHoldUnknownAlert?: (alert: HoldUnknownAlert) => void;
  /**
   * Market, IOC, and FOK orders left in `hold_unknown` are released instead of
   * submitted once they are older than this on the database clock.
   * Mirrors `TRADE_HOLD_UNKNOWN_TAKER_MAX_AGE_MS`.
   */
  holdUnknownTakerMaxAgeMs?: number;
  /**
   * svc-token's stake discount for an order that pays its fees in the platform token (fee-ifc.ts). Default unwired:
   * every such order refuses `trade.fee_ifc_discount_unavailable`.
   */
  ifcDiscount?: IfcDiscountSource;
}

export interface ConvertQuoteRequest {
  symbol?: string;
  marketId?: string;
  side: OrderSide;
  /**
   * Base amount to convert. Exactly one of `qty` or `quoteQty` — both or
   * neither refuses `trade.convert_invalid_qty`.
   */
  qty?: Amount;
  /**
   * Spend, in the quote asset ("spend 100 USDT"), buy side only. The quote
   * buys the largest whole number of lots whose total cost, spread included,
   * is <= quoteQty; `inAmount` is the exact spend and never exceeds it.
   */
  quoteQty?: Amount;
}

export interface ConvertExecuteRequest {
  /** Firm quote to accept. Missing quote refuses — never a live re-price. */
  quoteId: string;
  /**
   * Optional retry key. Idempotency root is quoteId; this is not a substitute
   * for a stored quote.
   */
  clientConvertId?: string;
  symbol?: string;
  marketId?: string;
  side?: OrderSide;
  qty?: Amount;
  /**
   * Optional asserted average. Must equal the quoted avg — last look is forbidden.
   */
  maxAvgPrice?: Amount | null;
}

export interface PlaceOrderInput {
  /** Either is accepted; `symbol` is what integrators use, `marketId` what internals use. */
  symbol?: string;
  marketId?: string;
  side: OrderSide;
  type: string;
  qty: Amount;
  price?: Amount | null;
  tif?: TimeInForce;
  /**
   * The retry key. Required on money-path place — without one a timeout retry
   * opens a second hold under a fresh order id.
   */
  clientOrderId?: string;
  subAccountId?: string;
  /** A label for the caller's own books, 1 to 16 characters. Stored on the row, never part of the key. */
  tag?: string;
  /**
   * Optional ceiling on the market-buy protection/funding price (convert M-03).
   * When set, the engine limit is `min(slippageCap, maxProtectionPrice)` so a
   * client maxAvgPrice binds execution, not only the pre-trade RFQ check.
   */
  maxProtectionPrice?: Amount | null;
  /**
   * Optional floor on a market-sell execution price (convert M-03 sell half).
   * When set, the order is submitted as a marketable IOC *limit* at this price
   * so the engine cannot fill below the bound the user already accepted on the
   * re-quote. Without it, a market sell stays pure market (hold is base qty).
   */
  minProtectionPrice?: Amount | null;
  /**
   * Seed/mm honesty (SD-2). Only accepted when `seedPlaceEnabled` is on.
   * Flagged orders are excluded from public volume / tape (SD-3).
   */
  seeded?: boolean;
  /**
   * The asset to pay this order's fees in. Absent, or the asset it receives: fees come out of each fill as always. The
   * platform token, on a person's own spot order, when the owner's schedule publishes its terms (fee-ifc.ts).
   */
  feeCurrency?: string;
  /** Internal binding for the cancel/replace saga; never accepted from REST. */
  replacementOf?: string;
  replacementRequestHash?: string;
}

/** Native amend: new remaining quantity at the same price. Decimal Amount, not a JSON number. */
export interface AmendOrderInput {
  readonly qty: Amount;
  readonly price?: Amount | null;
  readonly side?: OrderSide;
  readonly type?: string;
  readonly tif?: TimeInForce;
  readonly marketId?: string;
  readonly symbol?: string;
  /**
   * Remaining the caller reviewed. Compared with the engine's live remaining.
   * A mismatch is `trade.amend_stale`: a fill between the dialog and the click
   * must not turn a decrease into a raise.
   */
  readonly expectedRemaining?: Amount;
  /** Engine instruction version the caller reviewed. Mismatch is `trade.amend_stale`. */
  readonly expectedVersion?: number;
}

export interface ListMarketInput {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: Amount;
  lotSize: Amount;
  minQty: Amount;
  maxQty?: Amount | null;
  minNotional: Amount;
  makerBps: number;
  takerBps: number;
  status?: Market['status'];
  /**
   * Default to a continuous crypto listing, because that is what every existing
   * caller means. A commodity or forex listing must name its schedule — the
   * database CHECK refuses a non-crypto class on `crypto-24x7`, so a listing
   * that forgets is rejected at insert rather than accepting weekend orders.
   */
  assetClass?: Market['assetClass'];
  schedule?: Market['schedule'];
  /** Falls back to the symbol; the column carries a NOT-NULL, length > 0 check. */
  displayName?: string;
  /** Paper market — drills only; placeOrder never posts ledger holds. */
  paper?: boolean;
  /**
   * `spot` (default), `futures`, or `options`. The column and its enum have
   * existed since `0000_trade_init.sql`, whose own comment says "the kind enum
   * already carries their values, so listing a futures market later is" additive
   * — and this method hardcoded `'spot'` anyway, so the only way a futures row
   * reached `trade.markets` was raw SQL in a test.
   *
   * LISTING IS NOT ENABLING, and the ADR is explicit that the two are different
   * acts: "modelling an instrument is always honest; listing one you cannot settle
   * never is" (`2026-08-04-instrument-enum-authority.md`). A futures row created
   * here is quotable and readable and takes no order at all unless
   * `TRADE_FUTURES_ENABLED` is on. Real-money active futures also require a
   * non-empty insurance fund for the quote asset (DIRECTION:33) — empty →
   * `trade.insurance_fund_empty`; paper/pending remain allowed.
   *
   * Live `options` listing is refused until D26-P0-05 settlement asset law is
   * stamped AND D7 fixing is configured AND complete European terms are supplied.
   * Paper options may list without inventing a settlement asset. Paper placeOrder
   * is the v1 engine; live orders still refuse. Never invent live set / asset.
   */
  kind?: MarketKind;
  /** Required when kind=options: call or put. */
  optionType?: 'call' | 'put' | null;
  /** v1 european only; defaults to european when kind=options. */
  optionStyle?: 'european' | null;
  /** Required when kind=options: strike > 0 in quote units. */
  optionStrike?: Amount | null;
  /** Required when kind=options: European expiry instant. */
  optionExpiryAt?: Date | null;
  /**
   * Futures constitution. Omitted / `perpetual` on kind=futures is the isolated
   * perp product (no expiry). `dated` requires expiryAt + TRADE_FUTURES_SETTLEMENT_FIXING.
   * Never inferred from the symbol.
   */
  futuresContractStyle?: 'perpetual' | 'dated' | null;
  /** Required when futuresContractStyle=dated. */
  futuresExpiryAt?: Date | null;
  /**
   * Contract family on kind=futures. Omitted means `linear`. `inverse` refuses
   * `trade.inverse_family_unsupported`: no inverse P&L formula is published. Dated vs perpetual is
   * `futuresContractStyle`, not this field.
   */
  futuresFamily?: 'linear' | 'inverse' | null;
  /**
   * Settle asset on kind=futures. Omitted means the quote asset and nothing else. A value other than the quote
   * asset refuses; USDC refuses until TRADE_FUTURES_SETTLE_ASSETS names it.
   */
  futuresSettleAsset?: string | null;
}

/** Blank / non-integer / out of 1..500 markets() list limit refuse. Never invent 50. */
export const TRADE_MARKETS_LIMIT_UNSET = 'trade.markets_limit_unset' as const;
export const MARKETS_LIMIT_MAX = 500;

export class MarketsLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_MARKETS_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'MarketsLimitUnsetError';
  }
}

/** Owner-published markets list window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedMarketsLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > MARKETS_LIMIT_MAX) {
    throw new MarketsLimitUnsetError('markets list limit is unset — refuse to invent 50', TRADE_MARKETS_LIMIT_UNSET);
  }
  return value;
}

/**
 * `TradeService` as the area files in `trade-service/` see it: its public surface plus the private members those
 * files run on. The class passes itself through `internal`, so only the class and its area files reach these
 * members; any other caller still gets a compile error for them.
 */
export type TradeServiceInternal = { [K in keyof TradeService]: TradeService[K] } & {
  accountAdmission: TradeService['accountAdmission'];
  spotEnabled: TradeService['spotEnabled'];
  futuresEnabled: TradeService['futuresEnabled'];
  optionsSettlementAssetLaw: TradeService['optionsSettlementAssetLaw'];
  optionsSettlementFixing: TradeService['optionsSettlementFixing'];
  futuresSettlementFixing: TradeService['futuresSettlementFixing'];
  futuresSettleAssets: TradeService['futuresSettleAssets'];
  seedPlaceEnabled: TradeService['seedPlaceEnabled'];
  slippageCapBps: TradeService['slippageCapBps'];
  botVerification: TradeService['botVerification'];
  algoMarkPolicy: TradeService['algoMarkPolicy'];
  convertEnabled: TradeService['convertEnabled'];
  convertSpreadBps: TradeService['convertSpreadBps'];
  convertQuoteTtlMs: TradeService['convertQuoteTtlMs'];
  convertStore: TradeService['convertStore'];
  algoEnabled: TradeService['algoEnabled'];
  algoJobsEnabled: TradeService['algoJobsEnabled'];
  algoJobsIntervalMs: TradeService['algoJobsIntervalMs'];
  now: TradeService['now'];
  subAccounts: TradeService['subAccounts'];
  emailProof: TradeService['emailProof'];
  allowUnpublishedPairRules: TradeService['allowUnpublishedPairRules'];
  algo: TradeService['algo'];
  algoStore: TradeService['algoStore'];
  affiliateAccrue: TradeService['affiliateAccrue'];
  affiliatePayout: TradeService['affiliatePayout'];
  dropCopyIngest: TradeService['dropCopyIngest'];
  onCopyMirrorFill: TradeService['onCopyMirrorFill'];
  onHoldUnknownAlert: TradeService['onHoldUnknownAlert'];
  holdUnknownTakerMaxAgeMs: TradeService['holdUnknownTakerMaxAgeMs'];
  ifcDiscount: TradeService['ifcDiscount'];
  sql: TradeService['sql'];
  ledger: TradeService['ledger'];
  matching: TradeService['matching'];
  perks: TradeService['perks'];
  bus: TradeService['bus'];
  assertLifecycleAction: TradeService['assertLifecycleAction'];
  algoPrincipals: TradeService['algoPrincipals'];
  requireStandingInstructions: TradeService['requireStandingInstructions'];
  convertExecuteFor: TradeService['convertExecuteFor'];
  buildConvertQuote: TradeService['buildConvertQuote'];
  placeOrderInner: TradeService['placeOrderInner'];
  recordedFillSequence: TradeService['recordedFillSequence'];
  refuseRestartedEngineSequence: TradeService['refuseRestartedEngineSequence'];
  executeAdmittedOrder: TradeService['executeAdmittedOrder'];
  placePaperOrderIsolated: TradeService['placePaperOrderIsolated'];
  amendOutcome: TradeService['amendOutcome'];
  applyNativeAmendHold: TradeService['applyNativeAmendHold'];
  replaceOutcome: TradeService['replaceOutcome'];
  applySubmitResult: TradeService['applySubmitResult'];
  settleOutcome: TradeService['settleOutcome'];
  finalizeOcoWhenNoLegLive: TradeService['finalizeOcoWhenNoLegLive'];
  insertFillLeg: TradeService['insertFillLeg'];
  settleFill: TradeService['settleFill'];
  notifyAffiliateAccrue: TradeService['notifyAffiliateAccrue'];
  notifyCopyMirrorFill: TradeService['notifyCopyMirrorFill'];
  notifyDropCopyFill: TradeService['notifyDropCopyFill'];
  notifyAffiliatePayout: TradeService['notifyAffiliatePayout'];
  assertOwnerFeeSchedulePublished: TradeService['assertOwnerFeeSchedulePublished'];
  feeScheduleAt: TradeService['feeScheduleAt'];
  ratesForFill: TradeService['ratesForFill'];
  ratesForSchedule: TradeService['ratesForSchedule'];
  assertFillFeesPostable: TradeService['assertFillFeesPostable'];
  fillEvidence: TradeService['fillEvidence'];
  remainingHold: TradeService['remainingHold'];
  finalize: TradeService['finalize'];
  holdUnknownWaitSeconds: TradeService['holdUnknownWaitSeconds'];
  deleteAbsentHoldUnknownPastBound: TradeService['deleteAbsentHoldUnknownPastBound'];
  cancelAbsentHoldUnknownPastBound: TradeService['cancelAbsentHoldUnknownPastBound'];
  orderIsTaker: TradeService['orderIsTaker'];
  takerOlderThanCap: TradeService['takerOlderThanCap'];
  holdUnknownSubmitRefusal: TradeService['holdUnknownSubmitRefusal'];
  rejectBookedHoldUnknown: TradeService['rejectBookedHoldUnknown'];
  submitBookedHoldUnknown: TradeService['submitBookedHoldUnknown'];
  repostAbsentHold: TradeService['repostAbsentHold'];
  noteHoldUnknown: TradeService['noteHoldUnknown'];
  readHoldByKey: TradeService['readHoldByKey'];
  openAndSubmit: TradeService['openAndSubmit'];
  resumeHoldUnknown: TradeService['resumeHoldUnknown'];
  markRecoveryRequired: TradeService['markRecoveryRequired'];
  finalizeIfComplete: TradeService['finalizeIfComplete'];
  publishXp: TradeService['publishXp'];
  publishOrderUpdated: TradeService['publishOrderUpdated'];
  refuseCancelAheadOfFill: TradeService['refuseCancelAheadOfFill'];
  replayStoredAlgo: TradeService['replayStoredAlgo'];
  installAlgoPlaceGrant: TradeService['installAlgoPlaceGrant'];
  requireMarket: TradeService['requireMarket'];
  assertOwnerOrderLimit: TradeService['assertOwnerOrderLimit'];
  assertOpenOrdersCap: TradeService['assertOpenOrdersCap'];
  isPendingBracketExit: TradeService['isPendingBracketExit'];
  slippageCap: TradeService['slippageCap'];
  bestAsk: TradeService['bestAsk'];
  touch: TradeService['touch'];
  bestBid: TradeService['bestBid'];
  toEngineRequest: TradeService['toEngineRequest'];
  noteOrderEvent: TradeService['noteOrderEvent'];
  notePartialIfOpen: TradeService['notePartialIfOpen'];
  refreshFilledQty: TradeService['refreshFilledQty'];
};

export class TradeService {
  /** This service as its area files in `trade-service/` see it: see `TradeServiceInternal`. */
  private get internal(): TradeServiceInternal {
    return this as unknown as TradeServiceInternal;
  }

  private readonly accountAdmission: TradingAdmissionPort | undefined;
  private readonly marketLifecycle?: MarketLifecyclePort;
  /** Read by the trailing-stop placement wrapper (`trailing-stop-place.ts`). */
  protected readonly trailingMarkSource?: QuotedMarkSource;
  private readonly spotEnabled: boolean;
  private readonly futuresEnabled: boolean;
  private readonly futuresTestSeed: boolean;
  /** Opaque P0-05 ADR stamp; empty refuses options listing (SOCKET §13). */
  private readonly optionsSettlementAssetLaw: string;
  /** Opaque D7 fixing stamp; empty refuses options listing (after P0-05). */
  private readonly optionsSettlementFixing: string;
  /** Opaque dated-futures fixing stamp; empty refuses style=dated listing. */
  private readonly futuresSettlementFixing: string;
  /** Owner-configured settle assets; empty refuses a USDC-settled linear listing. */
  private readonly futuresSettleAssets: readonly string[];
  private readonly seedPlaceEnabled: boolean;
  private readonly slippageCapBps: number | null;
  private readonly botVerification: BotVerificationPolicy;
  private readonly algoMarkPolicy: AlgoMarkPolicy;
  /** Owner maker/taker schedule. Unpublished refuses place and fill. */
  private readonly feeSchedule: OwnerFeeSchedule;
  private readonly convertEnabled: boolean;
  private readonly standingInstructionsEnabled: boolean;
  private readonly convertSpreadBps: number | null;
  private readonly convertQuoteTtlMs: number | null;
  private readonly convertStore: ConvertQuoteStore;
  private readonly algoEnabled: boolean;
  private readonly algoJobsEnabled: boolean;
  private readonly algoJobsIntervalMs: number | null;
  private readonly now: () => Date;
  private readonly subAccounts: SubAccountOwnershipSource;
  private readonly emailProof: EmailProofSource | undefined;
  private readonly allowUnpublishedPairRules: boolean;
  /** D-S-04 TWAP scheduler — parent holds no value; children go through placeOrder. */
  private readonly algo: TwapEngine;
  /** Durable TWAP schedules — survives process restart (in-memory alone was residual). */
  private readonly algoStore: TwapParentStore;
  /** Best-effort identity accrue after house fees post (never fails the fill). */
  private readonly affiliateAccrue: AffiliateAccruePort;
  /** Best-effort identity payout after accrue (never fails the fill). */
  private readonly affiliatePayout: AffiliatePayoutPort;
  /** Best-effort FIX drop-copy hitch after settle (never fails the fill). */
  private readonly dropCopyIngest: DropCopyIngestPort;
  private onCopyMirrorFill?: (notice: {
    orderId: string;
    fillId: string;
    side: 'buy' | 'sell';
    price: Amount;
    qty: Amount;
  }) => Promise<void>;
  private readonly onHoldUnknownAlert?: (alert: HoldUnknownAlert) => void;
  private readonly holdUnknownTakerMaxAgeMs: number;
  private readonly ifcDiscount: IfcDiscountSource;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly matching: MatchingClient,
    private readonly perks: RankPerksSource,
    private readonly bus: EventBus,
    options: TradeServiceOptions = {},
  ) {
    this.accountAdmission = options.accountAdmission;
    this.marketLifecycle = options.marketLifecycle;
    this.spotEnabled = options.spotEnabled ?? true;
    // `?? false`, and the asymmetry with the line above is the whole point: a
    // deploy that forgets to mention futures does not get futures.
    this.futuresEnabled = options.futuresEnabled ?? false;
    this.futuresTestSeed = options.futuresTestSeed === true;
    // Empty defaults — P0-05 / D7 unset means refuse options listing, never invent law.
    this.optionsSettlementAssetLaw = options.optionsSettlementAssetLaw ?? '';
    this.optionsSettlementFixing = options.optionsSettlementFixing ?? '';
    this.futuresSettlementFixing = options.futuresSettlementFixing ?? '';
    this.futuresSettleAssets = options.futuresSettleAssets ?? [];
    this.seedPlaceEnabled = options.seedPlaceEnabled ?? false;
    this.slippageCapBps = options.marketSlippageCapBps ?? null;
    this.algoMarkPolicy = options.algoMarkPolicy ?? DEFAULT_ALGO_MARK_POLICY;
    // Omitted = fail closed: required with no level set refuses every bot create.
    this.botVerification = options.botVerification ?? { mode: 'required', level: null };
    this.trailingMarkSource = options.trailingMarkSource;
    this.feeSchedule = options.feeSchedule ?? UNPUBLISHED_FEE_SCHEDULE;
    this.convertEnabled = options.convertEnabled ?? true;
    this.standingInstructionsEnabled = options.standingInstructionsEnabled ?? false;
    this.convertSpreadBps = options.convertSpreadBps ?? null;
    this.convertQuoteTtlMs = options.convertQuoteTtlMs ?? null;
    this.convertStore = options.convertStore ?? new SqlConvertQuoteStore(sql);
    this.algoEnabled = options.algoEnabled ?? true;
    this.algoJobsEnabled = options.algoJobsEnabled === true;
    this.algoJobsIntervalMs = options.algoJobsIntervalMs ?? null;
    this.now = options.now ?? (() => new Date());
    this.subAccounts = options.subAccounts ?? new NoSubAccounts();
    this.emailProof = options.emailProof;
    this.allowUnpublishedPairRules = options.allowUnpublishedPairRules === true;
    this.algoStore = options.algoStore ?? new SqlTwapParentStore(sql);
    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();
    this.affiliatePayout = options.affiliatePayout ?? new NoopAffiliatePayout();
    this.dropCopyIngest = options.dropCopyIngest ?? new NoopDropCopyIngest();
    this.onCopyMirrorFill = options.onCopyMirrorFill;
    this.onHoldUnknownAlert = options.onHoldUnknownAlert;
    this.ifcDiscount = options.ifcDiscount ?? UNWIRED_IFC_DISCOUNT;
    const takerMaxAge = options.holdUnknownTakerMaxAgeMs ?? 30_000;
    this.holdUnknownTakerMaxAgeMs = Number.isInteger(takerMaxAge) && takerMaxAge >= 1_000 && takerMaxAge <= 600_000 ? takerMaxAge : 30_000;
    this.algo = new TwapEngine(
      {
        now: () => this.now(),
        randomId: () => crypto.randomUUID(),
        placeChild: async (req) => {
          // Child is an ordinary order — same path, same holds, same gates.
          const parent = this.algo.get(req.parentId);
          if (!parent) throw new TradeError(`algo ${req.parentId} not found`, 'trade.algo_not_found');
          const principal = this.algoPrincipals.get(parent.userId);
          if (!principal) {
            // Pre-migration rows, expired grant, or missing trade:write on
            // stored claims. Creating a TWAP persists the presented grant
            // (`grant_claims`); tick reinstalls it. Never mint from userId.
            throw new TradeError(
              "this schedule has no durable place grant — refusing to place on the caller's behalf",
              'trade.algo_principal_unavailable',
            );
          }
          try {
            const order = await this.placeOrderInner(
              principal,
              {
                symbol: req.symbol,
                marketId: req.marketId,
                side: req.side,
                type: req.limitPrice === null ? 'market' : 'limit',
                qty: req.qty,
                price: req.limitPrice,
                tif: req.limitPrice === null ? 'IOC' : 'GTC',
                clientOrderId: req.clientOrderId,
                subAccountId: req.subAccountId ?? undefined,
              },
              'algo.child',
              `algo:${parent.id}`,
            );
            return { orderId: order.id };
          } catch (err) {
            if (err instanceof InsufficientFundsError) {
              throw new TradeError(err.message, 'trade.algo_insufficient_balance');
            }
            throw err;
          }
        },
        cancelChild: async (orderId) => {
          const row = await this.sql<OrderRow[]>`SELECT * FROM trade.orders WHERE id = ${orderId} LIMIT 1`;
          if (!row[0]) return;
          // Already terminal — nothing to cancel; silent success is honest.
          if (
            row[0].status !== 'open' &&
            row[0].status !== 'pending' &&
            row[0].status !== 'recovery_required' &&
            row[0].status !== 'hold_unknown'
          )
            return;
          // A cancel that does not cancel is worse than a refused cancel.
          // Open child without the live caller's principal must THROW so the
          // parent stays non-cancelled (engine cancel collects failures first).
          const principal = this.algoPrincipals.get(row[0].user_id);
          if (!principal) {
            throw new TradeError(
              `cannot cancel open algo child ${orderId} without the caller's principal — install principal on cancelAlgo before engine.cancel (never mint from userId)`,
              'trade.algo_principal_unavailable',
            );
          }
          await this.cancelOrder(principal, orderId);
        },
        bestOpposingPrice: async (marketId, side) => {
          const depth = await this.matching.depth(marketId, 1);
          const level = side === 'buy' ? depth.asks[0] : depth.bids[0];
          return level ? parseAmount(level[0]) : null;
        },
        recordArrivalMark: (parentId, mark) => this.algoStore.recordArrivalMark(parentId, mark.price, mark.asOf),
        markFor: async (marketId): Promise<AlgoQuotedMark | null> => {
          const depth = await this.matching.depth(marketId, 1);
          const bid = depth.bids[0] ? parseAmount(depth.bids[0][0]) : null;
          const ask = depth.asks[0] ? parseAmount(depth.asks[0][0]) : null;
          if (bid === null || ask === null || bid <= 0n || ask <= 0n) return null;
          return {
            marketId,
            price: (bid + ask) / 2n,
            asOf: this.now(),
            quality: 'mid',
          };
        },
        intervalTakerVolume: async (marketId, from, to) => queryTakerVolumeFromFills(this.sql, { marketId, from, to }),
      },
      {
        onChange: (parent, plan) => this.algoStore.save({ parent, plan }),
        markPolicy: this.algoMarkPolicy,
      },
    );
  }

  /** One lifecycle snapshot shared by the public projection and order gate. */
  async marketLifecycleSnapshot(market: Market) {
    return (await this.marketLifecycle?.snapshot(market)) ?? null;
  }

  /**
   * The PLACE lifecycle proof for a market, for matched futures orders (futures ADR slice 6). It is the same gate
   * spot placement passes, so a halt or a suspension refuses a futures order the same way.
   */
  async placeLifecycleProofForMarket(marketId: string): Promise<LifecycleAdmissionProof> {
    const market = await this.marketById(marketId);
    if (!market) throw new TradeError(`market ${marketId} not found`, 'trade.market_not_found');
    return this.assertLifecycleAction(market, 'PLACE');
  }

  private async assertLifecycleAction(
    market: Market,
    action: 'PLACE' | 'PLACE_POST_ONLY' | 'AMEND',
    orderType?: string,
  ): Promise<LifecycleAdmissionProof> {
    if (!this.marketLifecycle) {
      throw new TradeError('market lifecycle authority is not configured', 'trade.lifecycle_authority_unavailable');
    }
    const snapshot = await this.marketLifecycle.snapshot(market, { now: this.now().toISOString() });
    const decision = this.marketLifecycle.admit(snapshot, action);
    if (decision.decision === 'ELIGIBLE') {
      // Limit-only mode keeps placement open for limit orders and refuses a market order here, before any hold.
      if (snapshot.state === 'LIMIT_ONLY' && orderType === 'market') {
        throw new TradeError(`market ${market.symbol} is limit-only: market orders are refused`, 'trade.mode_limit_only');
      }
      try {
        return createLifecycleAdmissionProof(snapshot, decision, action);
      } catch {
        throw new TradeError(`market ${market.symbol} lifecycle proof does not match ${action}`, 'trade.lifecycle_proof_mismatch');
      }
    }
    const knownCodes = new Set<TradeErrorCode>([
      'trade.market_halted',
      'trade.market_suspended',
      'trade.lifecycle_authority_unavailable',
      'trade.lifecycle_dossier_required',
      'trade.lifecycle_dossier_invalid',
      'trade.lifecycle_readiness_socket',
      'trade.lifecycle_transition_partial',
      'trade.lifecycle_transition_unknown',
      'trade.lifecycle_recovery_required',
      'trade.product_disabled',
      'trade.matching_market_missing',
      'trade.matching_unavailable',
      'trade.lifecycle_wrong_market',
      'trade.market_status_unknown',
      'trade.lifecycle_authority_stale',
      'trade.market_closed',
      'trade.unknown_schedule',
    ]);
    const code = knownCodes.has(decision.reasonCode as TradeErrorCode)
      ? (decision.reasonCode as TradeErrorCode)
      : 'trade.lifecycle_authority_unavailable';
    throw new TradeError(`market ${market.symbol} lifecycle refuses ${action}: ${decision.reasonCode ?? snapshot.state}`, code);
  }

  private readonly algoPrincipals = new Map<string, Principal>();

  async admitAccountOperation(
    principal: Principal,
    kind: TradingOperationKind,
    businessId: string,
    payload: unknown,
    parentBusinessId?: string,
    subAccountId?: string,
  ) {
    if (!this.accountAdmission) throw new TradingControlError('authority.unavailable');
    const parent = parentBusinessId ? await this.accountAdmission.original(principal.userId, parentBusinessId) : null;
    if (parentBusinessId && (!parent?.admission || !parent.grantId)) throw new TradingControlError('auth.credential_denied');
    return this.accountAdmission.admit(
      principal,
      kind,
      businessId,
      payload,
      parentBusinessId && parent?.grantId ? { parentBusinessId, parentGrantId: parent.grantId } : undefined,
      subAccountId,
    );
  }

  /** Original native-amend funding can be recovered; it never authorizes changed risk. */
  async admitNativeQtyIncrease(principal: Principal, businessId: string, payload: Record<string, unknown>) {
    if (!this.accountAdmission) throw new TradingControlError('authority.unavailable');
    const original = await this.accountAdmission.original(principal.userId, businessId);
    if (!original) return this.admitAccountOperation(principal, 'order.increase', businessId, payload);
    const frozen = original.payload as Record<string, unknown>;
    if (
      !frozen ||
      ['orderId', 'expectedVersion', 'qty', 'newHold', 'holdAsset'].some((key) => frozen[key] !== payload[key]) ||
      (payload.extra !== '0' && (frozen.extra !== payload.extra || frozen.holdAmount !== payload.holdAmount))
    )
      throw new TradingControlError('operation.conflict');
    // An already-funded original increase needs no second hold. A changed
    // remaining risk/amount requires reconciliation, never reuse of this grant.
    return this.admitAccountOperation(principal, 'order.increase', businessId, frozen);
  }

  /** Owning CopyService supplies its verified follow id; old follows refuse new mirrors. */
  async placeCopyMirror(principal: Principal, input: PlaceOrderInput, followId: string): Promise<OrderRecord> {
    return this.placeOrderInner(principal, input, 'copy.mirror', `copy.follow:${followId}`);
  }

  /** Owning GridService supplies its bot id: one level order, a delegated child of the bot's admitted `strategy.start`. */
  async placeGridLevel(principal: Principal, input: PlaceOrderInput, botId: string): Promise<OrderRecord> {
    return this.placeOrderInner(principal, input, 'algo.child', `grid:${botId}`);
  }

  /** Owned worker hook: resolve uncertain grant, then execute only its original payload. */
  async recoverAdmittedOrder(userId: string, orderId: string): Promise<OrderRecord | null> {
    const existing = await this.findOrder(orderId);
    if (existing) return existing.userId === userId ? existing : null;
    if (!this.accountAdmission) throw new TradingControlError('authority.unavailable');
    const original = await this.accountAdmission.resolve(userId, `order:${orderId}`);
    if (!original) return null;
    return this.executeAdmittedOrder(original.payload as Record<string, unknown>);
  }

  // ── Listings (operator surface) ────────────────────────────────────────────

  /**
   * List a market. Operator-only; there is no user-facing path to this.
   *
   * A listing decides the tick and lot grid, and therefore decides whether a
   * legal fill on this market can have a quote amount of zero. The database
   * enforces `tick x lot >= 1 wei` because a bad listing would otherwise lie
   * dormant until the first partial fill hit it in production.
   */
  async listMarket(input: ListMarketInput): Promise<Market> {
    return listings.listMarket(this.internal, input);
  }

  /**
   * Halt, resume or delist a market.
   *
   * Halting does NOT touch open orders or their holds. An operator halting a
   * market is stopping new risk, not confiscating positions — the funds stay
   * held and the orders stay cancellable, which is the only behaviour that
   * lets a user out of a market the operator has frozen.
   */
  async setMarketStatus(marketId: string, status: Market['status']): Promise<Market> {
    return listings.setMarketStatus(this.internal, marketId, status);
  }

  /**
   * Listed markets, symbol ASC. Limit is required — missing / non-int / out of
   * 1..500 refuses (never invent 50). Owner/query may pass 50 explicitly.
   */
  async markets(limit: number): Promise<Market[]> {
    const capped = publishedMarketsLimit(limit);
    const rows = await loadListedMarketRows(this.sql, capped, this.futuresTestSeed);
    return rows.map(toMarket);
  }

  // ── Convert — firm RFQ (M27). Book is the source, not the trade. ───────────

  /**
   * Firm quote. Observes the book as source, stores exact in/out + expiry.
   * No hold, no matching order.
   */
  async convertQuote(principal: Principal, input: ConvertQuoteRequest) {
    requireScope(principal, 'trade:read');
    return this.convertQuoteFor(principal.userId, input);
  }

  private async convertQuoteFor(userId: string, input: ConvertQuoteRequest) {
    return convert.convertQuoteFor(this.internal, userId, input);
  }

  private requireStandingInstructions() {
    if (!this.standingInstructionsEnabled) {
      throw new TradeError('standing-instruction convert is not enabled', 'trade.standing_instruction_disabled');
    }
  }

  /** Quote for a user on behalf of a svc-bank schedule. The door has proved the caller. */
  async standingConvertQuote(userId: string, _instructionId: string, input: ConvertQuoteRequest) {
    this.requireStandingInstructions();
    return this.convertQuoteFor(userId, input);
  }

  /**
   * Settle a stored quote for a user on behalf of a svc-bank schedule. Same quote,
   * ledger recipes and idempotency as the interactive door; only admission differs.
   */
  async standingConvertExecute(userId: string, instructionId: string, input: ConvertExecuteRequest): Promise<ConvertTradeWire> {
    return convert.standingConvertExecute(this.internal, userId, instructionId, input);
  }

  /**
   * Accept a stored firm quote and settle via ledger-client.
   * Missing quote / expiry / amounts refuse. Idempotent on quoteId.
   */
  async convertAccept(principal: Principal, input: ConvertExecuteRequest): Promise<ConvertTradeWire> {
    return this.convertExecute(principal, input);
  }

  async convertExecute(principal: Principal, input: ConvertExecuteRequest): Promise<ConvertTradeWire> {
    return convert.convertExecute(this.internal, principal, input);
  }

  private async convertExecuteFor(
    userId: string,
    input: ConvertExecuteRequest,
    admit: (businessId: string, payload: unknown) => Promise<unknown>,
  ): Promise<ConvertTradeWire> {
    return convert.convertExecuteFor(this.internal, userId, input, admit);
  }

  convertList(principal: Principal, input: ConvertListQuery) {
    return listConvertHistory(this.sql, principal, input, this.now());
  }

  convertStatus(principal: Principal, clientConvertId: string) {
    return readConvertStatus(this.sql, this.ledger, principal, clientConvertId, this.now());
  }

  convertExport(principal: Principal, query: { from?: string; to?: string }) {
    return exportConvertHistory(this.sql, principal, query, this.now());
  }

  algoList(principal: Principal, query: AlgoListQuery) {
    return this.algoScheduler().then((scheduler) => listAlgoParents(this.sql, principal, query, this.now(), scheduler));
  }

  algoReports(principal: Principal, query: { algoId: string; limit?: number | null; cursor?: string | null }) {
    return listAlgoReports(this.sql, principal, query);
  }

  optionsCatalogue(principal: Principal, query: OptionsCatalogueQuery) {
    return listOptionsCatalogue(this.sql, principal, query, this.optionsSettlementAssetLaw);
  }

  optionsPositions(principal: Principal) {
    return optionsPositionsDoor(principal, this.optionsDoorConfig());
  }

  optionsExercises(principal: Principal, jobsEnabled: boolean) {
    return optionsExercisesDoor(principal, { ...this.optionsDoorConfig(), jobsEnabled });
  }

  optionsMarginPreview(principal: Principal) {
    return optionsMarginPreviewDoor(principal, this.optionsDoorConfig());
  }

  rfqList(principal: Principal, query: RfqListQuery) {
    return listRfqHistory(this.sql, principal, query);
  }

  rfqExport(principal: Principal, query: { from?: string; to?: string }) {
    return exportRfqHistory(this.sql, principal, query);
  }

  scaleCreate(principal: Principal, input: ScaleCreateInput) {
    return createScaleGroup(this.scalePorts(), principal, input);
  }

  scaleGet(principal: Principal, groupId: string) {
    return getScaleGroup(this.scalePorts(), principal, groupId);
  }

  scaleCancel(principal: Principal, groupId: string) {
    return cancelScaleGroup(this.scalePorts(), principal, groupId);
  }

  private optionsDoorConfig() {
    return { settlementAssetLaw: this.optionsSettlementAssetLaw, settlementFixing: this.optionsSettlementFixing };
  }

  private scalePorts() {
    return convert.scalePorts(this.internal);
  }

  private async buildConvertQuote(userId: string, input: ConvertQuoteRequest) {
    return convert.buildConvertQuote(this.internal, userId, input);
  }

  // ── The order flow (§5.2) ──────────────────────────────────────────────────

  async placeOrder(principal: Principal, input: PlaceOrderInput): Promise<OrderRecord> {
    return orderPlace.placeOrder(this.internal, principal, input);
  }

  private async placeOrderInner(
    principal: Principal,
    input: PlaceOrderInput,
    kind: TradingOperationKind = 'order.place',
    parentBusinessId?: string,
  ): Promise<OrderRecord> {
    return orderPlace.placeOrderInner(this.internal, principal, input, kind, parentBusinessId);
  }

  private async recordedFillSequence(marketId: string): Promise<number | undefined> {
    return orderPlace.recordedFillSequence(this.internal, marketId);
  }

  private async refuseRestartedEngineSequence(market: Market): Promise<void> {
    return orderPlace.refuseRestartedEngineSequence(this.internal, market);
  }

  private async executeAdmittedOrder(evidence: Record<string, unknown>): Promise<OrderRecord> {
    return orderPlace.executeAdmittedOrder(this.internal, evidence);
  }

  private async placePaperOrderIsolated(
    principal: Principal,
    input: PlaceOrderInput,
    market: Market,
    orderType: OrderType,
    tif: TimeInForce,
    lifecycleProof: LifecycleAdmissionProof,
  ): Promise<OrderRecord> {
    return orderPlace.placePaperOrderIsolated(this.internal, principal, input, market, orderType, tif, lifecycleProof);
  }

  /**
   * Cancel an open order and return what is left of its hold (§5.2 step 3).
   *
   * ORDERING: the engine first, this service second. Cancelling at the engine
   * is what makes "no further fills for this order" true; only once it is true
   * can the remainder be computed and released. Releasing first would race a
   * fill that is already in flight, and the release would draw down a hold that
   * a fill is about to need.
   */
  async cancelOrder(principal: Principal, orderId: string): Promise<OrderRecord> {
    return orderChange.cancelOrder(this.internal, principal, orderId);
  }

  /**
   * Native amend (PX-S03 §8.2) — one matching PATCH, same order id.
   *
   * Only spot qty-down at the same price is native: that is the case that
   * retains queue priority and whose hold shrinks by a proven remainder.
   * Side, market, type, price, TIF, and qty-up stay CANCEL_REPLACE / NOT_AMENDABLE
   * and never silently cancel-plus-new. Unknown matching outcome never releases.
   */
  async amendOrder(principal: Principal, orderId: string, input: AmendOrderInput): Promise<AmendOrderOutcome> {
    return orderChange.amendOrder(this.internal, principal, orderId, input);
  }

  private amendOutcome(
    order: OrderRecord,
    code: AmendOutcomeCode,
    reasonCode: string | null,
    reconciliationRequired: boolean,
    idempotent: boolean,
    priority: AmendPriority | null,
  ): AmendOrderOutcome {
    return orderChange.amendOutcome(this.internal, order, code, reasonCode, reconciliationRequired, idempotent, priority);
  }

  private async applyNativeAmendHold(
    order: OrderRecord,
    market: Market,
    newRemaining: Amount,
    version: number,
    sequence: number | null,
  ): Promise<void> {
    return orderChange.applyNativeAmendHold(this.internal, order, market, newRemaining, version, sequence);
  }

  /**
   * Cancel/replace is a named CANCEL_REPLACE saga, never native amend:
   *
   *   1. prove the caller and replacement are admissible;
   *   2. cancel the original through the engine and finalize its ledger hold;
   *   3. submit the replacement through the ordinary funded place path.
   *
   * The replacement key is persisted on the replacement row. A retry therefore
   * returns the same row, while a different request using that key is refused.
   * No replacement is attempted after a partial/terminal original or any
   * unresolved cancel/reconciliation state. Side/market change belongs here,
   * not on the native PATCH door.
   */
  async replaceOrder(principal: Principal, originalOrderId: string, input: PlaceOrderInput): Promise<ReplaceOrderOutcome> {
    return orderChange.replaceOrder(this.internal, principal, originalOrderId, input);
  }

  private replaceOutcome(
    original: OrderRecord,
    replacement: OrderRecord | null,
    code: ReplaceOutcomeCode,
    reasonCode: string | null,
    reconciliationRequired = false,
    idempotent = false,
  ): ReplaceOrderOutcome {
    return orderChange.replaceOutcome(this.internal, original, replacement, code, reasonCode, reconciliationRequired, idempotent);
  }

  /**
   * Cancel every open/pending order for the principal (optional market filter).
   * Sequential on purpose: each cancel is its own hold-release money path.
   */
  async cancelAllOrders(principal: Principal, marketId?: string, kind?: MarketKind): Promise<OrderRecord[]> {
    return orderChange.cancelAllOrders(this.internal, principal, marketId, kind);
  }

  /**
   * Matching mass-cancel for this principal on one market.
   * Owner is the authenticated account. Trade never sends another account or a session.
   * Engine first, then one finalize per pulled rest — unknown outcome does not release.
   */
  async massCancelOrders(principal: Principal, marketId: string): Promise<OrderRecord[]> {
    return orderChange.massCancelOrders(this.internal, principal, marketId);
  }

  // ── Applying what the engine said ─────────────────────────────────────────

  private async applySubmitResult(market: Market, orderId: string, result: EngineSubmitResult): Promise<void> {
    return fillFlow.applySubmitResult(this.internal, market, orderId, result);
  }

  private async settleOutcome(market: Market, fills: readonly EngineFill[], cancellations: readonly EngineCancellation[]): Promise<void> {
    return fillFlow.settleOutcome(this.internal, market, fills, cancellations);
  }

  private async finalizeOcoWhenNoLegLive(
    marketId: string,
    legId: string,
    reason?: string | null,
    status: 'cancelled' | 'expired' = 'cancelled',
  ): Promise<boolean> {
    return fillFlow.finalizeOcoWhenNoLegLive(this.internal, marketId, legId, reason, status);
  }

  /** Remember how much of an OCO leg the engine had NOT executed when it cancelled the leg. Idempotent. */
  async recordOcoLegEnd(legId: string, remainingQty: string, reason?: string | null): Promise<void> {
    return fillFlow.recordOcoLegEnd(this.internal, legId, remainingQty, reason);
  }

  /**
   * True when the parent's settled fills cover what its legs executed. By default both legs must have a recorded
   * end: a leg with none is gone because it filled, and its last fill may be unsettled. Fails closed. A caller
   * that has itself just pulled the resting legs passes `requireBothLegs: false`: a leg with no record is then the
   * sibling the engine cancelled unfilled on a first fill, which executed nothing.
   */
  async ocoExecutionSettled(parentId: string, opts: { requireBothLegs?: boolean } = {}): Promise<boolean> {
    return fillFlow.ocoExecutionSettled(this.internal, parentId, opts);
  }

  private async insertFillLeg(leg: {
    id: string;
    orderId: string;
    counterOrderId: string;
    marketId: string;
    symbol: string;
    userId: string;
    side: 'buy' | 'sell';
    role: 'maker' | 'taker';
    price: bigint;
    qty: bigint;
    quoteAmount: bigint;
    feeAsset: string;
    feeAmount: bigint;
    feeBps: number;
    rebate?: { readonly bps: number; readonly amount: bigint; readonly asset: string } | null;
    sequence: number;
    attribution: AuthAttribution;
  }): Promise<void> {
    return fillFlow.insertFillLeg(this.internal, leg);
  }

  private async settleFill(market: Market, fill: EngineFill): Promise<void> {
    return fillFlow.settleFill(this.internal, market, fill);
  }

  private async notifyAffiliateAccrue(input: {
    fillId: string;
    makerUserId: string;
    takerUserId: string;
    makerFee: Amount;
    takerFee: Amount;
    makerFeeAsset: string;
    takerFeeAsset: string;
  }): Promise<void> {
    return fillFlow.notifyAffiliateAccrue(this.internal, input);
  }

  /** After the fill is stored. Failure is logged; the settled fill stays settled. */
  bindCopyMirrorFill(observe: NonNullable<TradeServiceOptions['onCopyMirrorFill']>): void {
    this.onCopyMirrorFill = observe;
  }

  private async notifyCopyMirrorFill(notice: {
    orderId: string;
    fillId: string;
    side: 'buy' | 'sell';
    price: Amount;
    qty: Amount;
  }): Promise<void> {
    return fillFlow.notifyCopyMirrorFill(this.internal, notice);
  }

  private async notifyDropCopyFill(
    input: Omit<DropCopyFillWire, 'source'> & {
      readonly source?: DropCopyHitchSource;
      readonly order?: { readonly apiKeyId?: string | null };
    },
  ): Promise<void> {
    return fillFlow.notifyDropCopyFill(this.internal, input);
  }

  private async notifyAffiliatePayout(input: {
    fillId: string;
    makerUserId: string;
    takerUserId: string;
    makerFee: Amount;
    takerFee: Amount;
    makerFeeAsset: string;
    takerFeeAsset: string;
  }): Promise<void> {
    return fillFlow.notifyAffiliatePayout(this.internal, input);
  }

  // ── Holds: the only two things that can happen to one ─────────────────────

  private async assertOwnerFeeSchedulePublished(market: Pick<Market, 'kind' | 'symbol'>, at?: Date, tierId?: string): Promise<void> {
    return holds.assertOwnerFeeSchedulePublished(this.internal, market, at, tierId);
  }

  /** The owner schedule in force at `at` (a later approved version, else the boot value). */
  private feeScheduleAt(at: Date): Promise<OwnerFeeSchedule> {
    return feeScheduleAtStore(this.sql, this.feeSchedule, at);
  }

  /** The fee tier an order `userId` places at `at` is charged at (fee-tier-store.ts). */
  async feeTierAt(userId: string, at: Date = this.now()): Promise<string> {
    return feeTierAtStore(this.sql, await this.feeScheduleAt(at), userId, at);
  }

  private async ratesForFill(
    makerDiscountBps: number,
    takerDiscountBps: number,
    kind: 'spot' | 'futures' | 'options' = 'spot',
    symbol?: string,
    placedAt: { readonly maker: Date; readonly taker: Date } = { maker: this.now(), taker: this.now() },
    tiers?: { readonly maker: string; readonly taker: string },
  ): Promise<{ makerFeeBps: number; takerFeeBps: number; makerRebateBps: number }> {
    return holds.ratesForFill(this.internal, makerDiscountBps, takerDiscountBps, kind, symbol, placedAt, tiers);
  }

  private ratesForSchedule(
    schedule: OwnerFeeSchedule,
    makerDiscountBps: number,
    takerDiscountBps: number,
    kind: 'spot' | 'futures' | 'options',
    symbol?: string,
    tierId?: string,
  ) {
    return holds.ratesForSchedule(this.internal, schedule, makerDiscountBps, takerDiscountBps, kind, symbol, tierId);
  }

  private assertFillFeesPostable(
    sequence: number,
    symbol: string,
    takerSide: 'buy' | 'sell',
    qty: Amount,
    quoteAmount: Amount,
    rates: { makerFeeBps: number; takerFeeBps: number },
  ): void {
    return holds.assertFillFeesPostable(this.internal, sequence, symbol, takerSide, qty, quoteAmount, rates);
  }

  private async fillEvidence(orderId: string): Promise<{ count: number; qty: Amount }> {
    return holds.fillEvidence(this.internal, orderId);
  }

  private async remainingHold(sql: Sql, order: OrderRecord): Promise<Amount> {
    return holds.remainingHold(this.internal, sql, order);
  }

  private async finalize(
    orderId: string,
    status: Extract<OrderStatus, 'cancelled' | 'filled' | 'expired' | 'rejected'>,
    reason?: string | null,
  ): Promise<void> {
    return holds.finalize(this.internal, orderId, status, reason);
  }

  private async holdUnknownWaitSeconds(orderId: string): Promise<number> {
    return holds.holdUnknownWaitSeconds(this.internal, orderId);
  }

  private async deleteAbsentHoldUnknownPastBound(orderId: string): Promise<number> {
    return holds.deleteAbsentHoldUnknownPastBound(this.internal, orderId);
  }

  private async cancelAbsentHoldUnknownPastBound(orderId: string): Promise<number> {
    return holds.cancelAbsentHoldUnknownPastBound(this.internal, orderId);
  }

  private orderIsTaker(order: OrderRecord): boolean {
    return order.type === 'market' || order.tif === 'IOC' || order.tif === 'FOK';
  }

  private async takerOlderThanCap(orderId: string): Promise<boolean> {
    return holds.takerOlderThanCap(this.internal, orderId);
  }

  private async holdUnknownSubmitRefusal(order: OrderRecord, market: Market): Promise<string | null> {
    return holds.holdUnknownSubmitRefusal(this.internal, order, market);
  }

  private async rejectBookedHoldUnknown(order: OrderRecord, detail: string): Promise<OrderRecord> {
    return holds.rejectBookedHoldUnknown(this.internal, order, detail);
  }

  private async submitBookedHoldUnknown(order: OrderRecord): Promise<OrderRecord> {
    return holds.submitBookedHoldUnknown(this.internal, order);
  }

  private async repostAbsentHold(order: OrderRecord): Promise<OrderRecord> {
    return holds.repostAbsentHold(this.internal, order);
  }

  private noteHoldUnknown(alert: HoldUnknownAlert): void {
    return holds.noteHoldUnknown(this.internal, alert);
  }

  private async readHoldByKey(orderId: string): Promise<HoldRead> {
    return holds.readHoldByKey(this.internal, orderId);
  }

  private async openAndSubmit(market: Market, orderId: string, request: EngineSubmitRequest): Promise<OrderRecord> {
    return holds.openAndSubmit(this.internal, market, orderId, request);
  }

  private async resumeHoldUnknown(order: OrderRecord, source: 'retry' | 'sweep'): Promise<OrderRecord> {
    return holds.resumeHoldUnknown(this.internal, order, source);
  }

  /**
   * Orders stuck in `hold_unknown`. Each one is read by its own
   * `order.hold:<orderId>` key. A booked hold is submitted, or released when a
   * gate refuses. An absent hold inside the in-flight bound is kept. An absent
   * hold past the bound is deleted with no release. A failed read leaves the
   * row and alerts. This pass never re-posts.
   */
  async sweepHoldUnknown(limit = 50): Promise<HoldUnknownSweepResult> {
    return holds.sweepHoldUnknown(this.internal, limit);
  }

  private async markRecoveryRequired(orderId: string, reason: RecoveryReason): Promise<void> {
    return holds.markRecoveryRequired(this.internal, orderId, reason);
  }

  private async finalizeIfComplete(orderId: string): Promise<void> {
    return holds.finalizeIfComplete(this.internal, orderId);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private async publishXp(order: OrderRecord, status: OrderStatus): Promise<void> {
    return events.publishXp(this.internal, order, status);
  }

  private async publishOrderUpdated(order: OrderRecord): Promise<void> {
    return events.publishOrderUpdated(this.internal, order);
  }

  /**
   * Settle a fill that arrived as an event rather than in a submit response.
   *
   * The recovery path. svc-matching publishes every match to
   * `intafaced.matching.order.filled` regardless of who submitted it, so a
   * process that died between the engine printing a fill and this service
   * settling it heals when the event is delivered. Every step is keyed on
   * (market, engine sequence), so this and the inline path cannot double-settle
   * each other.
   *
   * `makerAccountId` / `takerAccountId` come from the matching event when the
   * catalog carries them. House MM seed makers are matching STP
   * `house:market-maker`. A recorded seed row uses HOUSE_MM_USER_UUID for
   * bookkeeping — recovery rewrites that to the house STP id so the fill
   * cannot look like an anonymous customer. Empty event + no house row must
   * not invent house MM. User makers fall back to the order row's userId.
   */
  async settleFillEvent(input: {
    marketId: string;
    makerOrderId: string;
    takerOrderId: string;
    price: string;
    qty: string;
    sequence: number;
    /** Matching STP account for the maker leg — required for house MM recovery. */
    makerAccountId?: string;
    /** Matching STP account for the taker leg (users: userId). */
    takerAccountId?: string;
  }): Promise<void> {
    return events.settleFillEvent(this.internal, input);
  }

  /**
   * Release the hold for an order the engine says has left the book.
   *
   * The other half of the recovery path. Idempotent: `finalize` returns
   * immediately for an order already in a terminal state, and the release key
   * is fixed per order, so a redelivered `order.cancelled` cannot release
   * twice. The engine's reason rides along, as the inline outcome records
   * it: an order the engine expired (a GTD/GTT at its expiry) ends `expired`,
   * and a self-trade pull keeps its reason. Whichever path comes first decides
   * the row, so both must write the same.
   */
  async releaseOnCancelEvent(orderId: string, remainingQty: string, reason?: string): Promise<void> {
    return events.releaseOnCancelEvent(this.internal, orderId, remainingQty, reason);
  }

  private async refuseCancelAheadOfFill(orderId: string, remainingQty: Amount): Promise<void> {
    return events.refuseCancelAheadOfFill(this.internal, orderId, remainingQty);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getOrder(principal: Principal, orderId: string): Promise<OrderRecord> {
    return reads.getOrder(this.internal, principal, orderId);
  }

  /**
   * Every amend and replace of one order, oldest first. Amends come from the append-only
   * `order_events` rows; a replace is the order this one was replaced by, or the order it replaced.
   * Nothing is derived for an order that was never changed: the list is empty, not invented.
   */
  async orderAmendments(principal: Principal, orderId: string): Promise<OrderAmendment[]> {
    return reads.orderAmendments(this.internal, principal, orderId);
  }

  /**
   * The order this caller already placed under `clientOrderId` on this market,
   * or null when this request would create it. Used to tell an iceberg replay
   * from a new order without a clock.
   */
  async findClientOrder(
    principal: Principal,
    input: { symbol?: string; marketId?: string; clientOrderId?: string },
  ): Promise<OrderRecord | null> {
    return reads.findClientOrder(this.internal, principal, input);
  }

  /**
   * Self open/pending/recovery rows. Limit is required — same inner door as
   * private REST orders/open and tRPC orders.open. Missing / non-integer / out
   * of 1..500 refuses (never invent 100). Owner/query may pass 100 explicitly.
   */
  async openOrders(principal: Principal, marketId: string | undefined, limit: number): Promise<OrderRecord[]> {
    return reads.openOrders(this.internal, principal, marketId, limit);
  }

  /**
   * Operator read of the canonical order rows. Matching remains execution
   * state; this does not reconstruct or maintain a second order book.
   *
   * Limit is required — same inner door as private REST admin/orders/open.
   * Missing / non-integer / out of 1..500 refuses (never invent 100).
   * Owner/query may pass 100 explicitly.
   */
  async adminOpenOrders(principal: Principal, limit: number): Promise<OrderRecord[]> {
    return reads.adminOpenOrders(this.internal, principal, limit);
  }

  /**
   * Terminal orders for the principal (filled / cancelled / rejected / expired).
   * Optional `sinceMs` (unix ms) is applied in SQL on `orders.created_at >= since`
   * (CCXT convention). `created_at` is timestamptz — convert ms via `Date`.
   *
   * Limit is required — same inner door as private REST orders/closed. Missing /
   * non-integer / out of 1..500 refuses (never invent 100). Owner/query may pass
   * 100 explicitly.
   */
  async orderHistory(
    principal: Principal,
    input: {
      marketId?: string;
      limit: number;
      sinceMs?: number;
      untilMs?: number;
      side?: 'buy' | 'sell';
      status?: 'filled' | 'cancelled' | 'rejected' | 'expired';
      type?: 'market' | 'limit' | 'stop_limit' | 'stop';
      before?: string;
    },
  ): Promise<OrderRecord[]> {
    return reads.orderHistory(this.internal, principal, input);
  }

  /**
   * User fills, newest first. Optional `marketId` pushes the symbol filter into
   * SQL (`fills.market_id`) so a per-market limit is honest — not a post-filter
   * of a user-wide page that can under-fill the limit.
   * Optional `sinceMs` (unix ms) filters `fills.ts >= since` in SQL (CCXT).
   * `ts` is timestamptz — convert ms via `Date`, never raw int compare.
   *
   * Limit is required — same inner door as private REST account/trades. Missing /
   * non-integer / out of 1..500 refuses (never invent 100). Owner/query may pass
   * 100 explicitly.
   */
  async myFills(principal: Principal, limit: number, marketId?: string, sinceMs?: number): Promise<FillRecord[]> {
    return reads.myFills(this.internal, principal, limit, marketId, sinceMs);
  }

  /**
   * Fills for one of the caller's orders, oldest first.
   * Limit is required — same 1..500 window as fills.mine / myFills
   * (`publishedFillsMineLimit`). Missing / non-integer / out of range refuses
   * (never invent 100). Owner/query may pass 500 explicitly.
   */
  async fillsForOrder(principal: Principal, orderId: string, limit: number): Promise<FillRecord[]> {
    return reads.fillsForOrder(this.internal, principal, orderId, limit);
  }

  /** Every fill of one owned order (the grid bot's fee and pair sums). */
  async everyFillOfOrder(principal: Principal, orderId: string): Promise<FillRecord[]> {
    return reads.everyFillOfOrder(this.internal, principal, orderId);
  }

  async findOrder(orderId: string): Promise<OrderRecord | null> {
    const rows = await this.sql<OrderRow[]>`SELECT * FROM trade.orders WHERE id = ${orderId}`;
    const row = rows[0];
    return row ? toOrder(row) : null;
  }

  /**
   * CX-9 — open ↔ hold ↔ engine reconcile (Plan P1-5).
   *
   * Operator / recovery entry for a **single** suspect order. Not a cancel-all.
   *
   * | Case | Detection | Action |
   * | --- | --- | --- |
   * | orphan pending | `pending` + hold 0 + older than the in-flight bound | delete row (never held) |
   * | pending in flight | `pending` + hold 0 + inside the bound | no action (a hold may still commit) |
   * | open+hold, engine live | `open` + hold > 0 + list hit | cancel then release remainder once |
   * | open+hold, engine miss, proven empty fills | list miss + `trade.fills` empty + `filled_qty` 0 | cancel remainder (existing path, fills are the evidence) |
   * | open+hold, engine miss, unknown fills | list miss + fills do not prove no fill | **fail closed** — named break, hold stays |
   * | open+engine no hold | `open` + hold 0 | **fail closed** — do not invent hold; cancel free book risk if live |
   *
   * Liveness is **list first** (`GET` engine orders). Cancel is repair, not probe
   * (W6/W7 residual: cancel-as-probe emptied the book to ask if it was live).
   * Fail closed means: never mint a hold from this path; never mark filled without fills;
   * never auto-release on funded engine-miss when `trade.fills` cannot prove no fill.
   */
  async reconcileOrder(orderId: string): Promise<ReconcileResult> {
    return reconcile.reconcileOrder(this.internal, orderId);
  }

  async marketById(marketId: string): Promise<Market | null> {
    return reads.marketById(this.internal, marketId);
  }

  async marketBySymbol(symbol: string): Promise<Market | null> {
    const row = await loadMarketBySymbol(this.sql, symbol, this.futuresTestSeed);
    return row ? toMarket(row) : null;
  }

  /**
   * Public trade tape for a market (CCXT `fetchTrades`).
   *
   * One print per match — the taker leg only — so the tape is not doubled.
   * User ids and order ids are intentionally omitted; this is the public print,
   * not `myFills`. Empty market → empty array (honest 200, not an error).
   * Optional `sinceMs` filters `fills.ts >= since` in SQL (timestamptz via Date).
   *
   * Limit is required — same inner door as HTTP trades. Missing / non-integer /
   * out of 1..500 refuses (never invent 100). Owner/HTTP may pass 100 explicitly.
   */
  async publicTape(marketId: string, limit: number, sinceMs?: number): Promise<PublicTapePrint[]> {
    return reads.publicTape(this.internal, marketId, limit, sinceMs);
  }

  /**
   * Candles for a market (CCXT `fetchOHLCV`), aggregated from real taker fills.
   *
   * SOURCE OF TRUTH: live SQL over `trade.fills` (see `queryCandlesFromFills`).
   * Never invents empty buckets; SD-3 excludes seeded volume. Optional durable
   * materialization is a separate job (`startCandleJobs`, default OFF).
   *
   * Limit is required — same inner door as HTTP OHLCV. Missing / non-integer /
   * out of 1..1000 refuses via `queryCandlesFromFills` (never invent 500).
   * A request is answered in full for the window it asked for, or refused
   * before SQL. Refuse when since→now covers more points than `limit`, or when
   * `limit` is over 720. No shortened series.
   * The export flags the open bucket. Its 720-row slice is only a defensive guard.
   */
  async candles(marketId: string, timeframe: Timeframe, limit: number, sinceMs?: number) {
    return reads.candles(this.internal, marketId, timeframe, limit, sinceMs);
  }

  // ── Algo TWAP (D-S-04) — schedule emits children; parent holds no value ─────

  /**
   * Create a TWAP schedule. Refuses when market not listed/tradable/open.
   * Does not post to the ledger. Children place through `placeOrder` on tick.
   */
  async createTwap(
    principal: Principal,
    input: {
      symbol?: string;
      marketId?: string;
      side: OrderSide;
      totalQty: Amount;
      durationMs: number;
      sliceIntervalMs: number;
      limitPrice?: Amount | null;
      subAccountId?: string;
      clientAlgoId?: string;
      /** `twap` (default), `vwap` (lookback candles), `pov` (live tape × participationBps). */
      kind?: string;
      participationBps?: number;
    },
  ): Promise<TwapParent> {
    return twap.createTwap(this.internal, principal, input);
  }

  async getAlgo(principal: Principal, parentId: string): Promise<TwapParent> {
    requireScope(principal, 'trade:read');
    return hydrateAlgoIfMissing(this.algo, this.algoStore, principal.userId, parentId);
  }

  /** Owner recovery restores only the immutable admitted proposal. Each child
   * still needs a fresh identity decision and local trading admission. */
  async recoverAdmittedAlgo(userId: string, parentId: string): Promise<TwapParent | null> {
    return twap.recoverAdmittedAlgo(this.internal, userId, parentId);
  }

  async algoProgress(principal: Principal, parentId: string): Promise<AlgoProgressView> {
    return twap.algoProgress(this.internal, principal, parentId);
  }

  /** Derived child-fill result. Does not write. Does not put money on the parent. */
  async algoResult(principal: Principal, parentId: string): Promise<AlgoResult> {
    return twap.algoResult(this.internal, principal, parentId);
  }

  /** The public algo policy with this service's own create and scheduler flags. Reads nothing. */
  algoPolicy(): AlgoPolicySummary {
    return describeAlgoPolicy({ createEnabled: this.algoEnabled, jobsEnabled: this.algoJobsEnabled });
  }

  /** Heartbeat read. Selects only. */
  async algoScheduler(): Promise<AlgoSchedulerView> {
    return twap.algoScheduler(this.internal);
  }

  async pauseAlgo(principal: Principal, parentId: string): Promise<TwapParent> {
    requireScope(principal, 'trade:write');
    await hydrateAlgoIfMissing(this.algo, this.algoStore, principal.userId, parentId);
    return persistAlgoMutation(this.algo, this.algoStore, this.algo.pause(principal.userId, parentId));
  }

  async resumeAlgo(principal: Principal, parentId: string): Promise<TwapParent> {
    return twap.resumeAlgo(this.internal, principal, parentId);
  }

  async cancelAlgo(principal: Principal, parentId: string): Promise<TwapParent> {
    return twap.cancelAlgo(this.internal, principal, parentId);
  }

  /** Drive one parent's next due slice (job host / tests). */
  async tickAlgo(parentId: string) {
    return twap.tickAlgo(this.internal, parentId);
  }

  /** Drive all active algos once. Hydrates durable active parents first. */
  async tickAllAlgos() {
    return twap.tickAllAlgos(this.internal);
  }

  private async replayStoredAlgo(userId: string, clientAlgoId: string | undefined): Promise<TwapParent | null> {
    return twap.replayStoredAlgo(this.internal, userId, clientAlgoId);
  }

  private installAlgoPlaceGrant(record: TwapParentRecord): void {
    return twap.installAlgoPlaceGrant(this.internal, record);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async requireMarket(input: { symbol?: string; marketId?: string }): Promise<Market> {
    const market = input.marketId ? await this.marketById(input.marketId) : input.symbol ? await this.marketBySymbol(input.symbol) : null;
    if (!market) throw new TradeError(`market ${input.symbol ?? input.marketId ?? '(unspecified)'} not found`, 'trade.market_not_found');
    return market;
  }

  /**
   * Owner max-order admission (#4725). `price` is the funding price (limit price
   * or market-buy protection price). A market sell has none, so it is valued at
   * the best bid and, with no bid, at its own floor; with neither the notional
   * cannot be known and the order refuses rather than pass unmeasured.
   */
  private async assertOwnerOrderLimit(market: Market, qty: Amount, price: Amount | null): Promise<void> {
    const resolved = resolveAdmissionLimits();
    if ('refusal' in resolved) throw new TradeError(resolved.refusal.message, resolved.refusal.code as TradeErrorCode);
    const { limits } = resolved;
    if (limits.maxOrder == null) return;
    let reference = price;
    if (reference == null) {
      const depth = await this.matching.depth(market.id, 1);
      const bid = depth.bids[0];
      reference = bid ? parseAmount(bid[0]) : null;
    }
    if (reference == null || reference <= 0n) {
      throw new TradeError(
        `order notional cannot be valued (no reference price) so it cannot be checked against the max-order limit of ${limits.maxOrder} ${market.quoteAsset}`,
        'trade.limit_max_order',
      );
    }
    const refusal = checkMaxOrder({ limits, quoteAsset: market.quoteAsset, price: reference, qty });
    if (refusal) throw new TradeError(refusal.message, refusal.code as TradeErrorCode);
  }

  /**
   * TRADE_MAX_OPEN_ORDERS: the user's resting orders across every live market (the same statuses the mass cancel
   * sweeps; paper markets never count). Best effort under concurrency: two requests in flight can each see one free slot, so the book can
   * overshoot the cap by at most the number of parallel placements.
   */
  private async assertOpenOrdersCap(userId: string, clientOrderId: string): Promise<void> {
    const resolved = resolveOpenOrdersCap();
    if ('refusal' in resolved) throw new TradeError(resolved.refusal.message, resolved.refusal.code);
    if (resolved.cap == null) return;
    if (await this.isPendingBracketExit(userId, clientOrderId)) return;
    const [row] = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM trade.orders o
        JOIN trade.markets m ON m.id = o.market_id
       WHERE o.user_id = ${userId} AND NOT m.paper AND o.status IN ('pending', 'open', 'recovery_required', 'hold_unknown')
    `;
    const refusal = checkMaxOpenOrders({ cap: resolved.cap, openCount: row?.n ?? 0 });
    if (refusal) throw new TradeError(refusal.message, refusal.code as TradeErrorCode);
  }

  /**
   * The exit of a bracket (or the close of an OTO) whose entry already filled: no cap or band may refuse it, since that
   * leaves a position with no exit. The name alone is not trusted (a caller can pick any clientOrderId), so it must
   * match this user's own stored intent of that kind that has no exit yet.
   */
  private async isPendingBracketExit(
    userId: string,
    clientOrderId: string,
    opts: { entryDone?: boolean; marketId?: string } = {},
  ): Promise<boolean> {
    const named = /^(bracket|oto):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):(exit|close)$/.exec(clientOrderId);
    if (!named || (named[1] === 'bracket') !== (named[3] === 'exit')) return false;
    const kind = named[1]!;
    const exitOf = named[2]!;
    const pending = opts.entryDone
      ? await this.sql`
          SELECT 1 FROM trade.order_bracket_intent i JOIN trade.orders o ON o.id = i.order_id
           WHERE i.order_id = ${exitOf} AND i.user_id = ${userId} AND i.kind = ${kind} AND i.exit_order_id IS NULL
             AND o.status NOT IN ('open', 'pending', 'recovery_required', 'hold_unknown')
             AND o.market_id = ${opts.marketId ?? null}
        `
      : await this.sql`
          SELECT 1 FROM trade.order_bracket_intent
           WHERE order_id = ${exitOf} AND user_id = ${userId} AND kind = ${kind} AND exit_order_id IS NULL
        `;
    return pending.length > 0;
  }

  /** Operator slippage cap when set; otherwise the existing service cap (which may be unset). */
  private async slippageCap(marketId: string): Promise<number | null> {
    return (await operatorSlippageCapBps(this.sql, marketId)) ?? this.slippageCapBps;
  }

  private async bestAsk(marketId: string): Promise<Amount | null> {
    const depth = await this.matching.depth(marketId, 1);
    const best = depth.asks[0];
    return best ? parseAmount(best[0]) : null;
  }

  /** Best bid and ask in one depth read, for the operator price band. */
  private async touch(marketId: string): Promise<Touch> {
    const depth = await this.matching.depth(marketId, 1);
    const bid = depth.bids[0];
    const ask = depth.asks[0];
    return { bid: bid ? parseAmount(bid[0]) : null, ask: ask ? parseAmount(ask[0]) : null };
  }

  private async bestBid(marketId: string): Promise<Amount | null> {
    const depth = await this.matching.depth(marketId, 1);
    const best = depth.bids[0];
    return best ? parseAmount(best[0]) : null;
  }

  private toEngineRequest(
    orderId: string,
    userId: string,
    input: PlaceOrderInput,
    orderType: OrderType,
    tif: TimeInForce,
    protectionPrice: Amount | null,
    lifecycleProof: LifecycleAdmissionProof,
  ): EngineSubmitRequest {
    // A market BUY goes to the engine as a marketable IOC LIMIT at its
    // protection price. That is not a workaround — it is what makes "the engine
    // only ever matches funded orders" true for an order type that has no price
    // of its own. FOK is preserved because it is a different promise to the
    // caller, and the engine keeps it either way.
    //
    // A market SELL with `minProtectionPrice` is the convert M-03 sell half:
    // same shape (marketable IOC limit), floor rather than ceiling, so the
    // engine cannot print below the avg the user already accepted.
    if (orderType === 'market' && protectionPrice != null) {
      return {
        orderId,
        accountId: userId,
        type: 'limit',
        side: input.side,
        qty: formatAmount(input.qty),
        price: formatAmount(protectionPrice),
        stopPrice: null,
        tif: tif === 'FOK' ? 'FOK' : 'IOC',
        lifecycleProof,
      };
    }

    if (orderType === 'market') {
      return {
        orderId,
        accountId: userId,
        type: 'market',
        side: input.side,
        qty: formatAmount(input.qty),
        price: null,
        stopPrice: null,
        tif: tif === 'FOK' ? 'FOK' : 'IOC',
        lifecycleProof,
      };
    }

    return {
      orderId,
      accountId: userId,
      type: 'limit',
      side: input.side,
      qty: formatAmount(input.qty),
      price: formatAmount(input.price as Amount),
      stopPrice: null,
      tif,
      lifecycleProof,
    };
  }

  private async noteOrderEvent(order: OrderRecord, kind: OrderEventKind, code: string): Promise<void> {
    await appendOrderEvent(this.sql, {
      orderId: order.id,
      parentId: parentIdFromClientOrder(order.clientOrderId),
      kind,
      quantity: formatAmount(order.qty),
      price: order.price === null ? null : formatAmount(order.price),
      code,
    });
  }

  private async notePartialIfOpen(orderId: string, quantity: string, price: string, code: string): Promise<void> {
    const order = await this.findOrder(orderId);
    if (!order || order.filledQty <= 0n || order.filledQty >= order.qty) return;
    await appendOrderEvent(this.sql, {
      orderId: order.id,
      parentId: parentIdFromClientOrder(order.clientOrderId),
      kind: 'partial',
      quantity,
      price,
      code,
    });
  }

  private async refreshFilledQty(orderId: string): Promise<void> {
    await this.sql`
      UPDATE trade.orders o
         SET filled_qty = COALESCE((SELECT SUM(f.qty) FROM trade.fills f WHERE f.order_id = o.id), 0),
             updated_at = now()
       WHERE o.id = ${orderId}
    `;
  }
}

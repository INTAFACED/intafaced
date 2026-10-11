import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  TradingControlError,
  canonicalPayload,
  type TradingAdmissionPort,
  type TradingOperationKind,
} from '../controls/trading-controls.js';
import { businessPayload } from '../controls/business-payload.js';
import type { Timeframe } from '@intafaced/exchange-contract';
import type { EventBus } from '@intafaced/events';
import { requireScope, type Principal } from '@intafaced/auth';
import {
  formatAmount,
  InsufficientFundsError,
  mul,
  mulBps,
  orderHoldAccount,
  parseAmount,
  recipes,
  sub,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { withMoneySpan } from '../tracing.js';
import { queryCandlesFromFills, queryTakerVolumeFromFills } from './candles.js';
import { FeeScheduleError, UNPUBLISHED_FEE_SCHEDULE, type OwnerFeeSchedule } from './fee-schedule.js';
import { fillPayAmounts, fillReceivablesSurviveFees, ratesForFill as feeRatesForFill } from './fees.js';
import { fillIdFor, fillLegIdFor, orderIdFor } from './ids.js';
import {
  assertMarketOpen,
  assertNotional,
  assertPrice,
  assertQty,
  assertSettlementRails,
  assertSpotSurface,
  assertTradable,
  holdFor,
  protectionPriceFor,
  requireSupportedType,
} from './risk.js';
import { resolveOptionsListing } from './options-listing.js';
import { resolveDatedFuturesListing } from '../futures/dated-futures.js';
import { checkInsuranceFundedForListing } from '../futures/insurance-listing-gate.js';
import { assertProductionUnsettledAssetClassListing } from './forex-settlement.js';
import { toFill, toMarket, toOrder, type FillRow, type MarketRow, type OrderRow } from './rows.js';
import type { RankPerksSource } from './rank-perks.js';
import { fireAffiliateAccrue, affiliateLegsAfterFill, NoopAffiliateAccrue, type AffiliateAccruePort } from './affiliate-accrue.js';
import { fireAffiliatePayout, NoopAffiliatePayout, type AffiliatePayoutPort } from './affiliate-payout.js';
import {
  DROP_COPY_SOURCE_RFQ,
  dropCopySourceForBookOrder,
  fireDropCopyFill,
  NoopDropCopyIngest,
  type DropCopyFillWire,
  type DropCopyHitchSource,
  type DropCopyIngestPort,
} from './drop-copy-ingest.js';
import { NoSubAccounts, assertSubAccountOwned, type SubAccountOwnershipSource } from './sub-account-ownership.js';
import type {
  EngineAmendResult,
  EngineCancellation,
  EngineFill,
  EngineSubmitRequest,
  EngineSubmitResult,
  MatchingClient,
} from './matching-client.js';
import {
  acceptConvertQuote,
  buildFirmConvertQuote,
  estimateConvert,
  presentBoundConvertFill,
  presentConvertQuote,
  requireConvertQuoteTtlMs,
  requireConvertSpreadBps,
  type BoundConvertFill,
  type ConvertTradeWire,
} from '../convert/quote.js';
import { convertSettleIdsFor } from '../convert/ids.js';
import { planConvertSettle, postConvertSettle } from '../convert/settle.js';
import { SqlConvertQuoteStore, type ConvertQuoteStore } from '../convert/quote-store.js';
import { isHouseMmAccount } from '../mm/seed-market.js';
import { recoverMatchingAccountId } from '../mm/fill-account.js';
import { HOUSE_MM_USER_UUID } from './ids.js';
import {
  attributionFromOrder,
  attributionFromPrincipal,
  houseMmAttribution,
  requireAuthAttribution,
  withFillLedgerAttribution,
  withLedgerAttribution,
  type AuthAttribution,
} from './auth-attribution.js';
import {
  presentAlgoProgress,
  SqlTwapParentStore,
  TwapEngine,
  type AlgoProgressView,
  type AlgoQuotedMark,
  type CreateTwapInput,
  type TwapParent,
  type TwapParentStore,
} from '../algo/index.js';
import { captureAlgoPlaceGrant, parseAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';
import { alignLookbackVolumes, sliceCount, timeframeForSliceInterval } from '../algo/volume-plan.js';
import type { TwapParentRecord } from '../algo/parent-store.js';
import { hydrateAlgoFromStore, hydrateAlgoIfMissing, persistAlgoCancelAttempt, persistAlgoMutation } from '../algo/hydrate-on-mutate.js';
import type { MarketLifecyclePort } from '../market-lifecycle.js';
import { createLifecycleAdmissionProof, type LifecycleAdmissionProof } from '../lifecycle-proof.js';
import {
  TradeError,
  type Candle,
  type FillRecord,
  type Market,
  type MarketKind,
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

/** True only when `trade.fills` is empty and the order row claims no fill. */
export function fillsProveNoFill(filledQty: Amount, fills: { count: number; qty: Amount }): boolean {
  return fills.count === 0 && fills.qty === 0n && filledQty === 0n;
}

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
   * PTX-M21 owner fee/rebate schedule (`TRADE_FEE_SCHEDULE`).
   * Default unpublished — place/fill refuse; never listing-row 10/20.
   */
  feeSchedule?: OwnerFeeSchedule;
  /** Mirror of the `trade.convert` flag. OFF refuses convert quote + execute. */
  convertEnabled?: boolean;
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
}

export interface ConvertQuoteRequest {
  symbol?: string;
  marketId?: string;
  side: OrderSide;
  qty: Amount;
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
}

const REPLACEMENT_CLIENT_PREFIX = 'replace:';

function replacementClientOrderId(clientOrderId: string): string {
  return `${REPLACEMENT_CLIENT_PREFIX}${clientOrderId}`;
}

function replacementRequestHash(originalId: string, input: PlaceOrderInput): string {
  const canonical = [
    originalId,
    input.symbol ?? '',
    input.marketId ?? '',
    input.side,
    input.type,
    formatAmount(input.qty),
    input.price == null ? '' : formatAmount(input.price),
    input.tif ?? 'GTC',
    input.subAccountId ?? '',
    input.clientOrderId ?? '',
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * A caller-owned identity is an idempotency fence, not permission to reinterpret
 * the command. Persisted fields are the fingerprint so retries need no second
 * table and can still resolve while mutable dependencies are unavailable.
 */
export function assertSamePlaceCommand(
  order: OrderRecord,
  input: PlaceOrderInput,
  orderType: OrderType,
  tif: TimeInForce,
  seeded: boolean,
): OrderRecord {
  const same =
    order.clientOrderId === input.clientOrderId &&
    order.subAccountId === (input.subAccountId ?? null) &&
    order.side === input.side &&
    order.type === orderType &&
    order.qty === input.qty &&
    order.price === (input.price ?? null) &&
    order.tif === tif &&
    order.seeded === seeded &&
    order.replacementOf === (input.replacementOf ?? null) &&
    order.replacementRequestHash === (input.replacementRequestHash ?? null);
  if (!same) {
    throw new TradeError('clientOrderId was already used for a different order request', 'trade.client_order_id_conflict');
  }
  return order;
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
}

/** Blank / non-integer / out of 1..500 public-tape limit refuse. Never invent 100. */
export const TRADE_PUBLIC_TAPE_LIMIT_UNSET = 'trade.public_tape_limit_unset' as const;
export const PUBLIC_TAPE_LIMIT_MAX = 500;

export class PublicTapeLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_PUBLIC_TAPE_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'PublicTapeLimitUnsetError';
  }
}

/** Owner-published tape window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedPublicTapeLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > PUBLIC_TAPE_LIMIT_MAX) {
    throw new PublicTapeLimitUnsetError('public tape limit is unset — refuse to invent 100', TRADE_PUBLIC_TAPE_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..500 fills.mine / myFills limit refuse. Never invent 100. */
export const TRADE_FILLS_MINE_LIMIT_UNSET = 'trade.fills_mine_limit_unset' as const;
export const FILLS_MINE_LIMIT_MAX = 500;

export class FillsMineLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_FILLS_MINE_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'FillsMineLimitUnsetError';
  }
}

/** Owner-published user-fills window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedFillsMineLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > FILLS_MINE_LIMIT_MAX) {
    throw new FillsMineLimitUnsetError('fills.mine limit is unset — refuse to invent 100', TRADE_FILLS_MINE_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..500 orders.history / orderHistory limit refuse. Never invent 100. */
export const TRADE_ORDER_HISTORY_LIMIT_UNSET = 'trade.order_history_limit_unset' as const;
export const ORDER_HISTORY_LIMIT_MAX = 500;

export class OrderHistoryLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_ORDER_HISTORY_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'OrderHistoryLimitUnsetError';
  }
}

/** Owner-published order-history window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedOrderHistoryLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > ORDER_HISTORY_LIMIT_MAX) {
    throw new OrderHistoryLimitUnsetError('orders.history limit is unset — refuse to invent 100', TRADE_ORDER_HISTORY_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..500 adminOpenOrders limit refuse. Never invent 100. */
export const TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET = 'trade.admin_open_orders_limit_unset' as const;
export const ADMIN_OPEN_ORDERS_LIMIT_MAX = 500;

export class AdminOpenOrdersLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'AdminOpenOrdersLimitUnsetError';
  }
}

/** Owner-published admin open-orders window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedAdminOpenOrdersLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > ADMIN_OPEN_ORDERS_LIMIT_MAX) {
    throw new AdminOpenOrdersLimitUnsetError('adminOpenOrders limit is unset — refuse to invent 100', TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..500 openOrders limit refuse. Never invent 100. */
export const TRADE_OPEN_ORDERS_LIMIT_UNSET = 'trade.open_orders_limit_unset' as const;
export const OPEN_ORDERS_LIMIT_MAX = 500;

export class OpenOrdersLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_OPEN_ORDERS_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'OpenOrdersLimitUnsetError';
  }
}

/** Owner-published self open-orders window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedOpenOrdersLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > OPEN_ORDERS_LIMIT_MAX) {
    throw new OpenOrdersLimitUnsetError('orders.open limit is unset — refuse to invent 100', TRADE_OPEN_ORDERS_LIMIT_UNSET);
  }
  return value;
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

export class TradeService {
  private readonly accountAdmission: TradingAdmissionPort | undefined;
  private readonly marketLifecycle?: MarketLifecyclePort;
  private readonly spotEnabled: boolean;
  private readonly futuresEnabled: boolean;
  /** Opaque P0-05 ADR stamp; empty refuses options listing (SOCKET §13). */
  private readonly optionsSettlementAssetLaw: string;
  /** Opaque D7 fixing stamp; empty refuses options listing (after P0-05). */
  private readonly optionsSettlementFixing: string;
  /** Opaque dated-futures fixing stamp; empty refuses style=dated listing. */
  private readonly futuresSettlementFixing: string;
  private readonly seedPlaceEnabled: boolean;
  private readonly slippageCapBps: number | null;
  /** Owner maker/taker schedule. Unpublished refuses place and fill. */
  private readonly feeSchedule: OwnerFeeSchedule;
  private readonly convertEnabled: boolean;
  private readonly convertSpreadBps: number | null;
  private readonly convertQuoteTtlMs: number | null;
  private readonly convertStore: ConvertQuoteStore;
  private readonly algoEnabled: boolean;
  private readonly now: () => Date;
  private readonly subAccounts: SubAccountOwnershipSource;
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
    // Empty defaults — P0-05 / D7 unset means refuse options listing, never invent law.
    this.optionsSettlementAssetLaw = options.optionsSettlementAssetLaw ?? '';
    this.optionsSettlementFixing = options.optionsSettlementFixing ?? '';
    this.futuresSettlementFixing = options.futuresSettlementFixing ?? '';
    this.seedPlaceEnabled = options.seedPlaceEnabled ?? false;
    this.slippageCapBps = options.marketSlippageCapBps ?? null;
    this.feeSchedule = options.feeSchedule ?? UNPUBLISHED_FEE_SCHEDULE;
    this.convertEnabled = options.convertEnabled ?? true;
    this.convertSpreadBps = options.convertSpreadBps ?? null;
    this.convertQuoteTtlMs = options.convertQuoteTtlMs ?? null;
    this.convertStore = options.convertStore ?? new SqlConvertQuoteStore(sql);
    this.algoEnabled = options.algoEnabled ?? true;
    this.now = options.now ?? (() => new Date());
    this.subAccounts = options.subAccounts ?? new NoSubAccounts();
    this.algoStore = options.algoStore ?? new SqlTwapParentStore(sql);
    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();
    this.affiliatePayout = options.affiliatePayout ?? new NoopAffiliatePayout();
    this.dropCopyIngest = options.dropCopyIngest ?? new NoopDropCopyIngest();
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
          if (row[0].status !== 'open' && row[0].status !== 'pending' && row[0].status !== 'recovery_required') return;
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
      },
    );
  }

  /** One lifecycle snapshot shared by the public projection and order gate. */
  async marketLifecycleSnapshot(market: Market) {
    return (await this.marketLifecycle?.snapshot(market)) ?? null;
  }

  private async assertLifecycleAction(market: Market, action: 'PLACE' | 'PLACE_POST_ONLY' | 'AMEND'): Promise<LifecycleAdmissionProof> {
    if (!this.marketLifecycle) {
      throw new TradeError('market lifecycle authority is not configured', 'trade.lifecycle_authority_unavailable');
    }
    const snapshot = await this.marketLifecycle.snapshot(market, { now: this.now().toISOString() });
    const decision = this.marketLifecycle.admit(snapshot, action);
    if (decision.decision === 'ELIGIBLE') {
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
    const assetClass = input.assetClass ?? 'crypto';
    const paper = input.paper === true;
    const status = input.status ?? 'active';
    const kind = input.kind ?? 'spot';
    // D26-P1-T7 / D-S-05: modelling forex/commodities is honest; production
    // active listing without P0-05 + fiat settle rails is the lie (§13 socket.forex-settlement).
    // paper=true (drills) and non-active status remain allowed. Never invent settlement.
    assertProductionUnsettledAssetClassListing({ assetClass, status, paper });
    // DIRECTION:33 — empty insurance fund → no real-money futures list.
    // Target size/schedule stay owner-open; any positive balance passes.
    const insuranceGate = await checkInsuranceFundedForListing({
      kind,
      status,
      paper,
      quoteAsset: input.quoteAsset,
      balance: (ref) => this.ledger.balance(ref),
    });
    if (!insuranceGate.ok) {
      throw new TradeError(insuranceGate.reason, insuranceGate.code);
    }
    // trade.options: refuse kind=options until P0-05 law + D7 fixing; require
    // complete European terms so half-listed options cannot exist.
    // No IV surface, no pricing model, no invented settlement asset / matrix.
    const optionTerms = resolveOptionsListing({
      kind,
      settlementAssetLawConfigured: this.optionsSettlementAssetLaw,
      settlementFixingConfigured: this.optionsSettlementFixing,
      optionType: input.optionType,
      optionStyle: input.optionStyle,
      strike: input.optionStrike,
      expiryAt: input.optionExpiryAt,
      paper,
    });
    const datedTerms = resolveDatedFuturesListing({
      kind,
      futuresContractStyle: input.futuresContractStyle,
      expiryAt: input.futuresExpiryAt,
      settlementFixingConfigured: this.futuresSettlementFixing,
      paper,
    });
    const rows = await this.sql<MarketRow[]>`
      INSERT INTO trade.markets (
        symbol, base_asset, quote_asset, kind, tick_size, lot_size,
        min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
        asset_class, schedule, display_name, paper,
        option_type, option_style, option_strike, option_expiry_at, settlement_fixing,
        futures_contract_style, futures_expiry_at, futures_settlement_fixing
      ) VALUES (
        ${input.symbol}, ${input.baseAsset}, ${input.quoteAsset}, ${kind},
        ${formatAmount(input.tickSize)}::numeric, ${formatAmount(input.lotSize)}::numeric,
        ${formatAmount(input.minQty)}::numeric,
        ${input.maxQty == null ? null : formatAmount(input.maxQty)}::numeric,
        ${formatAmount(input.minNotional)}::numeric,
        ${status}, ${input.makerBps}, ${input.takerBps}, now(),
        ${assetClass}, ${input.schedule ?? 'crypto-24x7'},
        ${input.displayName ?? input.symbol}, ${paper},
        ${optionTerms?.optionType ?? null},
        ${optionTerms?.optionStyle ?? null},
        ${optionTerms == null ? null : formatAmount(optionTerms.strike)}::numeric,
        ${optionTerms?.expiryAt ?? null},
        ${optionTerms?.settlementFixing ?? null},
        ${datedTerms?.style ?? null},
        ${datedTerms?.expiryAt ?? null},
        ${datedTerms?.settlementFixing ?? null}
      )
      ON CONFLICT (symbol) DO UPDATE SET updated_at = now()
      RETURNING id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
                min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
                asset_class, schedule, paper,
                futures_contract_style, futures_expiry_at, futures_settlement_fixing
    `;
    return toMarket(rows[0] as MarketRow);
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
    // Load first: FX/commodity re-activate must not bypass socket.forex-settlement,
    // and empty-fund futures enable-to-active must refuse (DIRECTION:33).
    const existing = await this.sql<MarketRow[]>`
      SELECT id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
             min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
             asset_class, schedule, paper,
             futures_contract_style, futures_expiry_at, futures_settlement_fixing
        FROM trade.markets WHERE id = ${marketId}
    `;
    const current = existing[0];
    if (!current) throw new TradeError(`market ${marketId} not found`, 'trade.market_not_found');
    const currentMarket = toMarket(current);
    assertProductionUnsettledAssetClassListing({
      assetClass: current.asset_class,
      status,
      paper: currentMarket.paper,
    });
    const insuranceGate = await checkInsuranceFundedForListing({
      kind: currentMarket.kind,
      status,
      paper: currentMarket.paper,
      quoteAsset: currentMarket.quoteAsset,
      balance: (ref) => this.ledger.balance(ref),
    });
    if (!insuranceGate.ok) {
      throw new TradeError(insuranceGate.reason, insuranceGate.code);
    }
    const rows = await this.sql<MarketRow[]>`
      UPDATE trade.markets SET status = ${status}, updated_at = now() WHERE id = ${marketId}
      RETURNING id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
                min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
                asset_class, schedule, paper,
                futures_contract_style, futures_expiry_at, futures_settlement_fixing
    `;
    const row = rows[0];
    if (!row) throw new TradeError(`market ${marketId} not found`, 'trade.market_not_found');
    return toMarket(row);
  }

  /**
   * Listed markets, symbol ASC. Limit is required — missing / non-int / out of
   * 1..500 refuses (never invent 50). Owner/query may pass 50 explicitly.
   */
  async markets(limit: number): Promise<Market[]> {
    const capped = publishedMarketsLimit(limit);
    const rows = await this.sql<MarketRow[]>`
      SELECT id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
             min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
                asset_class, schedule, paper,
                futures_contract_style, futures_expiry_at, futures_settlement_fixing
        FROM trade.markets ORDER BY symbol ASC
        LIMIT ${capped}
    `;
    return rows.map(toMarket);
  }

  // ── Convert — firm RFQ (M27). Book is the source, not the trade. ───────────

  /**
   * Firm quote. Observes the book as source, stores exact in/out + expiry.
   * No hold, no matching order.
   */
  async convertQuote(principal: Principal, input: ConvertQuoteRequest) {
    requireScope(principal, 'trade:read');
    const quote = await this.buildConvertQuote(principal.userId, input);
    await this.convertStore.saveOpen(quote);
    return presentConvertQuote(quote);
  }

  /**
   * Accept a stored firm quote and settle via ledger-client.
   * Missing quote / expiry / amounts refuse. Idempotent on quoteId.
   */
  async convertAccept(principal: Principal, input: ConvertExecuteRequest): Promise<ConvertTradeWire> {
    return this.convertExecute(principal, input);
  }

  async convertExecute(principal: Principal, input: ConvertExecuteRequest): Promise<ConvertTradeWire> {
    return withMoneySpan(
      'trade.convertExecute',
      {
        operation: 'convert',
        userId: principal.userId,
        orderId: input.quoteId,
      },
      async (span) => {
        requireScope(principal, 'trade:write');
        if (!this.convertEnabled) {
          throw new TradeError('convert is disabled by the operator kill-switch', 'trade.convert_disabled');
        }
        requireConvertSpreadBps(this.convertSpreadBps);
        requireConvertQuoteTtlMs(this.convertQuoteTtlMs);
        if (!input.quoteId || input.quoteId.trim().length < 1) {
          throw new TradeError('convert quote id is required — refuse rather than invent a mid', 'trade.convert_quote_missing');
        }

        const stored = await this.convertStore.load(input.quoteId);
        if (!stored) {
          throw new TradeError('convert quote not found', 'trade.convert_quote_missing');
        }
        if (stored.quote.userId !== principal.userId) {
          throw new TradeError('convert quote belongs to another user', 'trade.convert_not_owner');
        }

        const ids = convertSettleIdsFor(stored.quote.quoteId);
        if (stored.lifecycle === 'settled') {
          span.setAttribute('intafaced.fill_id', ids.fillId);
          return presentBoundConvertFill(stored.bound, { ...ids, settledAt: stored.settledAt });
        }

        if (input.symbol != null && input.symbol !== stored.quote.symbol) {
          throw new TradeError('convert accept must honour the quoted symbol', 'trade.convert_price_moved');
        }
        if (input.side != null && input.side !== stored.quote.side) {
          throw new TradeError('convert accept must honour the quoted side', 'trade.convert_price_moved');
        }
        if (input.qty != null && input.qty !== stored.quote.requestedQty) {
          throw new TradeError('convert accept must honour the quoted quantity', 'trade.convert_price_moved');
        }

        const original = await this.accountAdmission?.original(principal.userId, `convert:${stored.quote.quoteId}`);
        const recordedBound = (original?.payload as { bound?: { fillPrice: string; fillNotional: string; acceptedAt: string } } | undefined)
          ?.bound;
        let bound: BoundConvertFill;
        if (recordedBound) {
          bound = {
            quote: stored.quote,
            fillPrice: parseAmount(recordedBound.fillPrice),
            fillNotional: parseAmount(recordedBound.fillNotional),
            acceptedAt: recordedBound.acceptedAt,
          };
        } else if (stored.lifecycle === 'bound') {
          bound = stored.bound;
        } else {
          bound = acceptConvertQuote({
            quote: stored.quote,
            now: this.now(),
            assertedPrice: input.maxAvgPrice ?? null,
          });
        }
        // The quote's immutable original bound is the business payload. A retry
        // recovers this decision rather than sampling a new price or quantity.
        if (stored.lifecycle === 'open' || original) {
          await this.admitAccountOperation(
            principal,
            'order.place',
            `convert:${stored.quote.quoteId}`,
            original?.payload ?? businessPayload({ quote: stored.quote, bound, ids }),
          );
        }
        if (stored.lifecycle === 'open') {
          await this.convertStore.saveBound(stored.quote, bound);
        }

        // Expiry governs the original accept, not recovery of already bound effects.
        const plan = planConvertSettle({ bound, ...ids, now: new Date(bound.acceptedAt) });
        await postConvertSettle(this.ledger, plan);
        const settledAt = this.now();
        await this.convertStore.saveSettled(stored.quote, bound, settledAt);
        await this.notifyDropCopyFill({
          fillId: ids.fillId,
          orderId: ids.takerOrderId,
          userId: bound.quote.userId,
          marketId: bound.quote.marketId,
          side: bound.quote.side,
          price: formatAmount(bound.fillPrice),
          qty: formatAmount(bound.quote.filledQty),
          quoteAmount: formatAmount(bound.fillNotional),
          feeAsset: bound.quote.quoteAsset,
          feeAmount: '0',
          ts: settledAt.toISOString(),
          source: DROP_COPY_SOURCE_RFQ,
        });
        span.setAttribute('intafaced.fill_id', ids.fillId);
        return presentBoundConvertFill(bound, { ...ids, settledAt: settledAt.toISOString() });
      },
    );
  }

  private async buildConvertQuote(userId: string, input: ConvertQuoteRequest) {
    if (!this.convertEnabled) {
      throw new TradeError('convert is disabled by the operator kill-switch', 'trade.convert_disabled');
    }
    const convertSpreadBps = requireConvertSpreadBps(this.convertSpreadBps);
    const quoteTtlMs = requireConvertQuoteTtlMs(this.convertQuoteTtlMs);
    if (!this.spotEnabled) {
      throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
    }

    const market = await this.requireMarket(input);
    // Convert is a spot-shaped RFQ and says so itself, rather than inheriting the
    // order path's kind refusal — which is about to become a flag. See
    // `assertSpotSurface`.
    assertSpotSurface(market, 'convert');
    assertTradable(market);
    assertSettlementRails(market);
    // Same schedule gate as placeOrder / TWAP create — before qty or book walk.
    // A quote for a shut / unrecognised venue is a lie (invented mid / weekend
    // EUR/USD fundable quote while place refuses market_closed).
    assertMarketOpen(market, this.now());
    assertQty(market, input.qty);

    const depth = await this.matching.depth(market.id, 50);
    const levels = input.side === 'buy' ? depth.asks : depth.bids;
    const estimate = estimateConvert({
      side: input.side,
      qty: input.qty,
      levels,
      convertSpreadBps,
      tickSize: market.tickSize,
    });

    if (!estimate.fullyFilled) {
      throw new TradeError(
        `insufficient book depth to convert ${formatAmount(input.qty)} ${market.baseAsset} — only ${formatAmount(estimate.filledQty)} available`,
        'trade.convert_insufficient_depth',
      );
    }

    const now = this.now();
    return buildFirmConvertQuote({
      quoteId: crypto.randomUUID(),
      userId,
      symbol: market.symbol,
      marketId: market.id,
      side: input.side,
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      requestedQty: input.qty,
      estimate,
      convertSpreadBps,
      source: { kind: 'book', symbol: market.symbol, asOf: now.toISOString() },
      now,
      quoteTtlMs,
    });
  }

  // ── The order flow (§5.2) ──────────────────────────────────────────────────

  async placeOrder(principal: Principal, input: PlaceOrderInput): Promise<OrderRecord> {
    return withMoneySpan(
      'trade.placeOrder',
      {
        operation: 'place_order',
        userId: principal.userId,
        symbol: input.symbol,
        side: input.side,
        qty: formatAmount(input.qty),
      },
      async (span) => {
        const order = await this.placeOrderInner(principal, input);
        span.setAttribute('intafaced.order_id', order.id);
        span.setAttribute('intafaced.order_status', order.status);
        // User-visible lifecycle (private WS). The legacy event catalog cannot
        // represent RECOVERY_REQUIRED, so unresolved snapshots are exposed via
        // the REST/private projections below and are deliberately not emitted
        // as a misleading OPEN/REJECTED event.
        if (order.status !== 'recovery_required') await this.publishOrderUpdated(order);
        return order;
      },
    );
  }

  private async placeOrderInner(
    principal: Principal,
    input: PlaceOrderInput,
    kind: TradingOperationKind = 'order.place',
    parentBusinessId?: string,
  ): Promise<OrderRecord> {
    // ── 1 · AUTH + SCOPE ────────────────────────────────────────────────────
    // First, before anything is read and long before anything is held. The
    // tRPC router applies the same check as a `scopedProcedure`; it is repeated
    // here so that every caller of this service — router, event consumer,
    // future gRPC edge — passes through the same gate, rather than the gate
    // living in one transport.
    requireScope(principal, 'trade:write');
    const attribution = attributionFromPrincipal(principal);
    const userId = principal.userId;

    // NO ORDERABLE PLANE AT ALL — refused before the registry is touched.
    //
    // This check used to be `if (!this.spotEnabled)`, and it runs BEFORE
    // `requireMarket` on purpose: an operator who has halted the venue should be
    // told the venue is halted, not sent on a symbol lookup that answers
    // `market_not_found` for a market that exists. Keeping it here preserves that
    // ordering exactly.
    //
    // With futures orderable there are two planes, so the pre-resolution refusal
    // can only fire when NEITHER can take an order; the per-kind answer needs the
    // market and comes straight after it is loaded. With `TRADE_FUTURES_ENABLED`
    // off — the shipped default — `!spotEnabled && !futuresEnabled` reduces to
    // `!spotEnabled` and this line behaves identically to the one it replaced.
    if (!this.spotEnabled && !this.futuresEnabled) {
      throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
    }

    const seeded = input.seeded === true;
    if (seeded && !this.seedPlaceEnabled) {
      throw new TradeError('seed/mm place is disabled by the operator kill-switch', 'trade.seed_disabled');
    }

    // ── 2 · RISK CHECKS ─────────────────────────────────────────────────────
    const market = await this.requireMarket(input);

    // Retry identity is resolved before mutable market/operator/dependency
    // checks. A retry must find the original even after a halt or outage; it
    // never creates new risk and cannot blind-resubmit an unresolved command.
    if (input.clientOrderId == null || input.clientOrderId.length < 1 || input.clientOrderId.length > 64) {
      throw new TradeError('clientOrderId is required (1–64 chars) so a retry cannot open a second hold', 'trade.client_order_id_required');
    }
    const orderType: OrderType = requireSupportedType(input.type);
    let tif: TimeInForce = input.seeded === true ? 'PO' : (input.tif ?? 'GTC');
    const expectedSeeded = market.paper ? false : seeded;
    const orderId = orderIdFor(userId, market.id, input.clientOrderId);
    const existing = await this.findOrder(orderId);
    if (existing) return assertSamePlaceCommand(existing, input, orderType, tif, expectedSeeded);
    const businessId = `order:${orderId}`;
    const request = businessPayload({ ...input, symbol: market.symbol, marketId: market.id, type: orderType, tif });
    const original = await this.accountAdmission?.original(userId, businessId);
    if (original) {
      const evidence = original.payload as Record<string, unknown>;
      if (canonicalPayload(evidence.request) !== canonicalPayload(request)) throw new TradingControlError('operation.conflict');
      await this.admitAccountOperation(principal, kind, businessId, evidence, parentBusinessId, input.subAccountId);
      return this.executeAdmittedOrder(evidence);
    }

    // Normalize the actual command before PX-S01. Seed/mm is forced post-only,
    // so its proof must say PLACE_POST_ONLY even when the caller omitted tif.
    // PX-S01 is the single state gate for both projections and new risk. It is
    // deliberately after idempotency lookup: a retry of an existing command
    // cannot create new value and remains recoverable during an authority
    // outage. A fresh PLACE/PLACE_POST_ONLY must have explicit authority,
    // dossier, session, risk, and matching readiness evidence.
    const lifecycleProof = await this.assertLifecycleAction(market, tif === 'PO' ? 'PLACE_POST_ONLY' : 'PLACE');

    // The per-kind half of the kill-switch. `TRADE_SPOT_ENABLED` is the spot
    // plane's switch and stays exactly that — it does not halt futures, and
    // `TRADE_FUTURES_ENABLED` does not halt spot. Two planes, two switches; a
    // single boolean standing for both would make an operator stopping one stop
    // the other, and there is no version of that which is the honest answer.
    if (market.kind === 'spot' && !this.spotEnabled) {
      throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
    }
    // SD-5 applies before the paper branch too: a seeded command is always a
    // priced maker command, and its proof has already been bound to PO above.
    if (seeded && orderType !== 'limit') {
      throw new TradeError('seed/mm orders must be limit post-only (liquidity provision only)', 'trade.seed_must_make');
    }
    if (tif === 'PO' && orderType !== 'limit') {
      throw new TradeError('post-only requires a limit price', 'trade.invalid_price');
    }
    assertTradable(market, {
      futuresEnabled: this.futuresEnabled,
      optionsSettlementLawStamped: this.optionsSettlementAssetLaw.trim().length > 0,
      now: this.now(),
    });
    // W4 U1: seed FX/commodity stay active in DB; place must refuse before hold.
    assertSettlementRails(market);

    // Hours/schedule refuse BEFORE paper SQL, clientOrderId, or any hold.
    // A closed or unrecognised venue must not take funds (weekend EUR/USD used
    // to rest a funded order until Monday). Read the clock ONCE so this request
    // cannot straddle a session boundary and get two answers.
    assertMarketOpen(market, this.now());

    // Owner schedule before paper SQL or any hold. Listing-row 10/20 is not a
    // schedule; unpublished is a typed refuse (same hitch as order preview).
    this.assertOwnerFeeSchedulePublished();

    // Ownership + revoked gate (identity S2S). Before any new row or hold — a
    // foreign or revoked id must never land on trade.orders.sub_account_id.
    // Existing clientOrderId retries return above even if identity is down;
    // they cannot create new risk and must remain recoverable.
    if (input.subAccountId != null) {
      await assertSubAccountOwned(this.subAccounts, userId, input.subAccountId);
    }

    // Stage-1 paper isolation (academy.paper-trading): a paper market must never
    // post orderHold / tradeFill against real available balances. Live markets
    // keep the funded path below unchanged.
    if (market.paper) {
      return this.placePaperOrderIsolated(principal, input, market, orderType, tif, lifecycleProof);
    }
    assertQty(market, input.qty);

    // SD-5: seed/mm is liquidity provision only — never take liquidity (no
    // market orders, force post-only so the engine refuses unfair crosses).
    if (seeded) {
      if (orderType !== 'limit') {
        throw new TradeError('seed/mm orders must be limit post-only (liquidity provision only)', 'trade.seed_must_make');
      }
      tif = 'PO';
    }
    if (tif === 'PO' && orderType !== 'limit') {
      // Post-only is a promise to be a maker, and only a priced order can make
      // it. Refused here rather than by the engine so no hold is taken first.
      throw new TradeError('post-only requires a limit price', 'trade.invalid_price');
    }

    /**
     * The price the order is FUNDED at, which is not always the price it is
     * matched at:
     *   · limit      — its own price. Fills come in at or better than it.
     *   · market buy — a protection price derived from the best ask, and the
     *                  order is submitted as a marketable IOC limit there, so
     *                  the engine cannot fill above what was held.
     *   · market sell— hold is base quantity (no funding price). Optional
     *                  `minProtectionPrice` still becomes an engine floor so
     *                  convert (M-03) cannot fill worse than the accepted avg.
     */
    let fundingPrice: Amount | null = null;
    let protectionPrice: Amount | null = null;

    if (orderType === 'limit') {
      if (input.price == null) throw new TradeError('a limit order requires a price', 'trade.invalid_price');
      assertPrice(market, input.price);
      assertNotional(market, input.price, input.qty);
      fundingPrice = input.price;
    } else if (input.side === 'buy') {
      protectionPrice = protectionPriceFor(market, await this.bestAsk(market.id), this.slippageCapBps);
      if (input.maxProtectionPrice != null && input.maxProtectionPrice < protectionPrice) {
        if (input.maxProtectionPrice <= 0n) {
          throw new TradeError('maxProtectionPrice must be positive', 'trade.invalid_price');
        }
        protectionPrice = input.maxProtectionPrice;
      }
      assertNotional(market, protectionPrice, input.qty);
      fundingPrice = protectionPrice;
    } else if (input.minProtectionPrice != null) {
      // Market sell with an execution floor (convert M-03). Hold stays base qty
      // — fundingPrice remains null — but the engine path uses this floor.
      if (input.minProtectionPrice <= 0n) {
        throw new TradeError('minProtectionPrice must be positive', 'trade.invalid_price');
      }
      assertPrice(market, input.minProtectionPrice);
      protectionPrice = input.minProtectionPrice;
    }

    // A market SELL holds base quantity, so `holdFor` ignores the price on that
    // branch — the zero is never read, and passing one is what keeps the
    // function total rather than partial.
    const hold = holdFor(market, input.side, fundingPrice ?? 0n, input.qty);

    // Rank perks are read ONCE, here, and snapshotted onto the row. Fails
    // closed — but nothing has moved yet, which is exactly why this is the
    // right place to be strict about a dependency being down.
    const perks = await this.perks.perksOf(userId);

    const evidence = businessPayload({
      request,
      market,
      orderId,
      userId,
      orderType,
      tif,
      hold,
      perks,
      protectionPrice,
      seeded,
      attribution,
      lifecycleProof,
      engineRequest: this.toEngineRequest(orderId, userId, input, orderType, tif, protectionPrice, lifecycleProof),
    });
    await this.admitAccountOperation(principal, kind, businessId, evidence, parentBusinessId, input.subAccountId);
    return this.executeAdmittedOrder(evidence);
  }

  /** Only called with the owner's immutable prepared payload, never public receipts. */
  private async executeAdmittedOrder(evidence: Record<string, unknown>): Promise<OrderRecord> {
    const rawInput = evidence.request as Record<string, unknown>;
    const input = {
      ...rawInput,
      qty: parseAmount(String(rawInput.qty)),
      price: rawInput.price == null ? null : parseAmount(String(rawInput.price)),
    } as unknown as PlaceOrderInput;
    const rawMarket = evidence.market as Record<string, unknown>;
    const market = { ...rawMarket } as unknown as Market;
    for (const field of ['tickSize', 'lotSize', 'minQty', 'maxQty', 'minNotional'] as const) {
      (market as unknown as Record<string, unknown>)[field] = rawMarket[field] == null ? null : parseAmount(String(rawMarket[field]));
    }
    const orderId = String(evidence.orderId),
      userId = String(evidence.userId);
    const orderType = evidence.orderType as OrderType,
      tif = evidence.tif as TimeInForce;
    const rawHold = evidence.hold as { assetId: string; amount: string };
    const hold = { assetId: rawHold.assetId, amount: parseAmount(rawHold.amount) };
    const perks = evidence.perks as { feeDiscountBps: number };
    const protectionPrice = evidence.protectionPrice == null ? null : parseAmount(String(evidence.protectionPrice));
    const seeded = evidence.seeded === true;
    const attribution = evidence.attribution as AuthAttribution;
    const lifecycleProof = evidence.lifecycleProof as LifecycleAdmissionProof;
    const engineRequest = evidence.engineRequest as EngineSubmitRequest;
    // ── 2b · THE INTENT ROW ─────────────────────────────────────────────────
    //
    // If this crashes exactly here, whose funds are stranded? Nobody's. A
    // `pending` row is an order with no ledger post behind it and no engine
    // presence, so the only correct recovery is to delete it, and that is the
    // only thing it can do.
    //
    // The row comes before the hold so that the hold is never the orphan: a
    // hold posted against an order id that exists nowhere is money nobody can
    // find. This way there is always a row pointing at the money, in every
    // interleaving.
    const inserted = await this.sql<Array<{ id: string }>>`
      INSERT INTO trade.orders (
        id, user_id, sub_account_id, market_id, client_order_id, side, type,
        price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, protection_price, seeded, lifecycle_proof,
        replacement_of, replacement_request_hash, session_id, api_key_id
      ) VALUES (
        ${orderId}, ${userId}, ${input.subAccountId ?? null}, ${market.id}, ${input.clientOrderId!},
        ${input.side}, ${orderType},
        ${input.price == null ? null : formatAmount(input.price)}::numeric,
        ${formatAmount(input.qty)}::numeric, 'pending', ${tif},
        ${hold.assetId}, ${formatAmount(hold.amount)}::numeric, ${perks.feeDiscountBps},
        ${protectionPrice === null ? null : formatAmount(protectionPrice)}::numeric,
        ${seeded}, ${JSON.stringify(lifecycleProof)}::jsonb,
        ${input.replacementOf ?? null}, ${input.replacementRequestHash ?? null},
        ${attribution.sessionId}, ${attribution.apiKeyId}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    if (inserted.length === 0) {
      // Lost a race with a concurrent identical submission. The winner owns the
      // hold and the engine submission; return what it wrote.
      const raced = await this.findOrder(orderId);
      if (raced) return assertSamePlaceCommand(raced, input, orderType, tif, seeded);
      throw new TradeError(`order ${orderId} vanished between insert and read`, 'trade.order_not_found');
    }

    // ── 3 · THE HOLD ────────────────────────────────────────────────────────
    //
    // Quote for buys, base for sells (§5.2). Keyed `order.hold:<orderId>` — a
    // business key, never a random one, so a retry finds the original post.
    try {
      await this.ledger.post(
        withLedgerAttribution(recipes.orderHold({ orderId, userId, assetId: hold.assetId, amount: hold.amount }), attribution),
      );
    } catch (err) {
      // Insufficient funds, a frozen module, a ledger outage — whatever it was,
      // no value moved and no engine has seen this order. Remove the intent row
      // so the failure leaves nothing behind at all.
      //
      // Guarded on `status = 'pending'`: if a concurrent path has already
      // funded and opened this order, this delete must not touch it.
      await this.sql`DELETE FROM trade.orders WHERE id = ${orderId} AND status = 'pending'`;
      throw err;
    }

    // The order is now funded. From here on the hold exists, so every exit path
    // below must end in either a fill or a release — never in silence.
    await this.sql`UPDATE trade.orders SET status = 'open', updated_at = now() WHERE id = ${orderId} AND status = 'pending'`;

    // ── 4 · THE ENGINE ──────────────────────────────────────────────────────
    let result: EngineSubmitResult;
    try {
      result = await this.matching.submit(market.id, engineRequest);
    } catch (err) {
      // INDETERMINATE. The request failed at the transport, so the engine may
      // or may not hold this order. Persist the frozen spine's
      // OUTCOME_UNKNOWN/SUBMIT_UNKNOWN evidence before returning the failure;
      // the hold stays encumbered and the retry fence now returns this row.
      await this.markRecoveryRequired(orderId, 'SUBMIT_UNKNOWN');
      throw err;
    }

    await this.applySubmitResult(market, orderId, result);

    const settled = await this.findOrder(orderId);
    if (!settled) throw new TradeError(`order ${orderId} vanished during settlement`, 'trade.order_not_found');
    return settled;
  }

  /**
   * Paper market place — Stage-1 isolation.
   *
   * Records an intent/open order with zero hold and never calls the ledger.
   * Simulated fills / workbook wiring are Stage-2. Live placeOrder path is
   * unchanged for non-paper markets.
   */
  private async placePaperOrderIsolated(
    principal: Principal,
    input: PlaceOrderInput,
    market: Market,
    orderType: OrderType,
    tif: TimeInForce,
    lifecycleProof: LifecycleAdmissionProof,
  ): Promise<OrderRecord> {
    requireScope(principal, 'trade:write');
    const attribution = attributionFromPrincipal(principal);
    const userId = principal.userId;
    if (input.subAccountId != null) {
      await assertSubAccountOwned(this.subAccounts, userId, input.subAccountId);
    }
    // Session already sealed in placeOrderInner (one clock). Do not re-read now().
    assertQty(market, input.qty);
    if (orderType === 'limit') {
      if (input.price == null) throw new TradeError('a limit order requires a price', 'trade.invalid_price');
      assertPrice(market, input.price);
      assertNotional(market, input.price, input.qty);
    }
    // Schema requires hold columns; paper posts zero amount and never ledger-posts.
    const holdAsset = input.side === 'buy' ? market.quoteAsset : market.baseAsset;
    // Caller already required clientOrderId in placeOrder — never random here.
    const orderId = orderIdFor(userId, market.id, input.clientOrderId as string);
    const existing = await this.findOrder(orderId);
    if (existing) return assertSamePlaceCommand(existing, input, orderType, tif, false);

    const inserted = await this.sql<Array<{ id: string }>>`
      INSERT INTO trade.orders (
        id, user_id, sub_account_id, market_id, client_order_id, side, type,
        price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, protection_price, seeded, lifecycle_proof,
        replacement_of, replacement_request_hash, session_id, api_key_id
      ) VALUES (
        ${orderId}, ${userId}, ${input.subAccountId ?? null}, ${market.id}, ${input.clientOrderId as string},
        ${input.side}, ${orderType},
        ${input.price == null ? null : formatAmount(input.price)}::numeric,
        ${formatAmount(input.qty)}::numeric, 'open', ${tif},
        ${holdAsset}, ${formatAmount(0n)}::numeric, 0,
        null,
        false, ${JSON.stringify(lifecycleProof)}::jsonb,
        ${input.replacementOf ?? null}, ${input.replacementRequestHash ?? null},
        ${attribution.sessionId}, ${attribution.apiKeyId}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      const raced = await this.findOrder(orderId);
      if (raced) return assertSamePlaceCommand(raced, input, orderType, tif, false);
      throw new TradeError(`order ${orderId} vanished between insert and read`, 'trade.order_not_found');
    }
    // No ledger.post. Paper options rest on the matching book so the desk is
    // not an empty invented book — still no live settlement asset.
    if (market.kind === 'options' && orderType === 'limit' && input.price != null) {
      try {
        await this.matching.submit(market.id, this.toEngineRequest(orderId, userId, input, orderType, tif, null, lifecycleProof));
      } catch {
        // Transport miss: the paper row still exists. Recovery is cancel.
      }
    }
    const settled = await this.findOrder(orderId);
    if (!settled) throw new TradeError(`order ${orderId} vanished during paper place`, 'trade.order_not_found');
    await this.publishOrderUpdated(settled);
    return settled;
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
    return withMoneySpan('trade.cancelOrder', { operation: 'cancel_order', userId: principal.userId, orderId }, async () => {
      requireScope(principal, 'trade:write');

      const order = await this.findOrder(orderId);
      if (!order) throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
      if (order.userId !== principal.userId) {
        // Deliberately the same code a stranger's order id would produce — do
        // not confirm the existence of another account's order.
        throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
      }
      if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required') {
        throw new TradeError(`order ${orderId} is ${order.status} and cannot be cancelled`, 'trade.order_not_open');
      }

      // `cancelled: false` means the engine has no such live order — it already
      // filled, or it never arrived (the indeterminate-submit case above).
      // Either way the hold still has to be reconciled, so the answer is the
      // same and this is not an error path.
      let cancellation: Awaited<ReturnType<MatchingClient['cancel']>>;
      try {
        cancellation = await this.matching.cancel(order.marketId, orderId);
      } catch (err) {
        // A cancel timeout is itself OUTCOME_UNKNOWN. Do not release on an
        // unproven cancel; recovery uses the stable key below.
        await this.markRecoveryRequired(orderId, 'CANCEL_UNKNOWN');
        throw err;
      }

      // A false cancel response claims absence, but verify that claim with the
      // non-destructive list before releasing. If the lookup is ambiguous or
      // still live, preserve the hold and surface a cancel recovery case.
      if (!cancellation.cancelled) {
        try {
          const listed = await this.matching.listOrders(order.marketId);
          if (listed.orders.some((candidate) => candidate.orderId === orderId)) {
            await this.markRecoveryRequired(orderId, 'CANCEL_UNKNOWN');
            throw new TradeError(`order ${orderId} remains live after definitive cancel miss`, 'trade.order_not_open');
          }
        } catch (err) {
          if (err instanceof TradeError) throw err;
          await this.markRecoveryRequired(orderId, 'CANCEL_UNKNOWN');
          throw err;
        }
      }

      // A successful cancel or a verified engine absence is now safe to
      // reconcile. Transport ambiguity above is deliberately kept separate and
      // remains recovery-required.
      await this.finalize(orderId, 'cancelled');

      const settled = await this.findOrder(orderId);
      return settled as OrderRecord;
    });
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
    return withMoneySpan('trade.amendOrder', { operation: 'amend_order', userId: principal.userId, orderId }, async () => {
      requireScope(principal, 'trade:write');

      const order = await this.findOrder(orderId);
      if (!order || order.userId !== principal.userId) {
        throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
      }
      if (order.status === 'recovery_required') {
        return this.amendOutcome(order, 'AMEND_UNKNOWN', order.recoveryReason ?? 'AMEND_UNKNOWN', true, false, null);
      }
      if (order.status !== 'open') {
        return this.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
      }

      if (input.side != null && input.side !== order.side) {
        return this.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_side_change', false, false, null);
      }
      if (input.type != null && input.type !== order.type) {
        return this.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_type_change', false, false, null);
      }
      if (input.tif != null && input.tif !== order.tif) {
        return this.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_tif_change', false, false, null);
      }
      if (input.price != null && order.price != null && input.price !== order.price) {
        return this.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_price_change', false, false, null);
      }
      if (input.marketId != null && input.marketId !== order.marketId) {
        return this.amendOutcome(order, 'CANCEL_REPLACE', 'trade.replace_market_mismatch', false, false, null);
      }

      const market = await this.marketById(order.marketId);
      if (!market) throw new TradeError(`market ${order.marketId} not found`, 'trade.market_not_found');
      if (input.symbol != null && input.symbol !== market.symbol) {
        return this.amendOutcome(order, 'CANCEL_REPLACE', 'trade.replace_market_mismatch', false, false, null);
      }

      if (market.kind !== 'spot' || market.paper) {
        return this.amendOutcome(order, 'NOT_AMENDABLE', 'trade.market_kind_unsupported', false, false, null);
      }
      if (order.type !== 'limit' || order.price == null) {
        return this.amendOutcome(order, 'NOT_AMENDABLE', 'trade.invalid_price', false, false, null);
      }
      if (order.tif === 'IOC' || order.tif === 'FOK') {
        return this.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
      }
      if (input.qty <= 0n) {
        throw new TradeError('amend quantity must be strictly positive', 'trade.invalid_qty');
      }

      const remainingQty = sub(order.qty, order.filledQty);
      if (remainingQty <= 0n) {
        return this.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
      }
      if (input.qty > remainingQty) {
        // Qty-up needs a larger hold. Native amend will not invent one.
        return this.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_qty_up', false, false, null);
      }

      try {
        assertTradable(market, {
          futuresEnabled: this.futuresEnabled,
          optionsSettlementLawStamped: this.optionsSettlementAssetLaw.trim().length > 0,
        });
        assertSettlementRails(market);
        assertMarketOpen(market, this.now());
        assertQty(market, input.qty);
        assertPrice(market, order.price);
        assertNotional(market, order.price, input.qty);
      } catch (err) {
        if (err instanceof TradeError) {
          return this.amendOutcome(order, 'NOT_AMENDABLE', err.code, false, false, null);
        }
        throw err;
      }

      let lifecycleProof: LifecycleAdmissionProof;
      try {
        lifecycleProof = await this.assertLifecycleAction(market, 'AMEND');
      } catch (err) {
        if (err instanceof TradeError && err.code.startsWith('trade.lifecycle_')) {
          return this.amendOutcome(order, 'LIFECYCLE_REFUSED', err.code, false, false, null);
        }
        if (err instanceof TradeError && (err.code === 'trade.market_halted' || err.code === 'trade.market_suspended')) {
          return this.amendOutcome(order, 'LIFECYCLE_REFUSED', err.code, false, false, null);
        }
        throw err;
      }

      const newHold = holdFor(market, order.side, order.price, input.qty).amount;
      const leftover = await this.remainingHold(this.sql, order);
      if (leftover < newHold) {
        return this.amendOutcome(order, 'NOT_AMENDABLE', 'trade.hold_uncovered', false, false, null);
      }

      let listed;
      try {
        listed = await this.matching.listOrders(order.marketId);
      } catch {
        await this.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
        const frozen = (await this.findOrder(order.id)) ?? order;
        return this.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
      }
      const live = listed.orders.find((candidate) => candidate.orderId === order.id);
      if (!live) {
        await this.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
        const frozen = (await this.findOrder(order.id)) ?? order;
        return this.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
      }

      const engineRemaining = parseAmount(live.remaining);
      const expectedVersion = live.version ?? order.engineVersion;
      if (engineRemaining === input.qty) {
        await this.applyNativeAmendHold(order, market, input.qty, expectedVersion, live.sequence);
        const settled = (await this.findOrder(order.id)) ?? order;
        return this.amendOutcome(settled, 'IDEMPOTENT_RETRY', null, false, true, 'retained');
      }
      if (engineRemaining < input.qty) {
        return this.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_qty_up', false, false, null);
      }

      let result: EngineAmendResult;
      try {
        result = await this.matching.amend(order.marketId, order.id, {
          expectedVersion,
          qty: formatAmount(input.qty),
          lifecycleProof,
        });
      } catch {
        await this.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
        const frozen = (await this.findOrder(order.id)) ?? order;
        return this.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
      }

      if (!result.accepted) {
        if (result.rejected?.code === 'order_not_found') {
          await this.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
          const frozen = (await this.findOrder(order.id)) ?? order;
          return this.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
        }
        if (result.rejected?.code === 'version_mismatch') {
          return this.amendOutcome(order, 'VERSION_MISMATCH', 'version_mismatch', false, false, null);
        }
        return this.amendOutcome(order, 'ENGINE_REFUSED', result.rejected?.code ?? 'refused', false, false, null);
      }

      await this.settleOutcome(market, result.fills, result.cancellations);
      const afterFills = (await this.findOrder(order.id)) ?? order;
      if (afterFills.status !== 'open' && afterFills.status !== 'recovery_required') {
        return this.amendOutcome(afterFills, 'AMENDED', null, false, false, result.priority);
      }

      const version = result.version ?? expectedVersion + 1;
      await this.applyNativeAmendHold(afterFills, market, input.qty, version, result.sequence);
      const settled = (await this.findOrder(order.id)) ?? afterFills;
      return this.amendOutcome(settled, 'AMENDED', null, false, false, result.priority);
    });
  }

  private amendOutcome(
    order: OrderRecord,
    code: AmendOutcomeCode,
    reasonCode: string | null,
    reconciliationRequired: boolean,
    idempotent: boolean,
    priority: AmendPriority | null,
  ): AmendOrderOutcome {
    return {
      accepted: code === 'AMENDED' || code === 'IDEMPOTENT_RETRY',
      idempotent,
      code,
      reasonCode,
      reconciliationRequired,
      path: 'NATIVE_AMEND',
      priority,
      order,
    };
  }

  /**
   * After a proven engine remaining, shrink qty and post the exact leftover
   * hold. Sequence is the new instruction version so it never collides with
   * the terminal sequence-0 release.
   */
  private async applyNativeAmendHold(
    order: OrderRecord,
    market: Market,
    newRemaining: Amount,
    version: number,
    sequence: number | null,
  ): Promise<void> {
    if (order.price == null) return;
    await transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<OrderRow[]>`SELECT * FROM trade.orders WHERE id = ${order.id} FOR UPDATE`;
        const row = rows[0];
        if (!row) return;
        const locked = toOrder(row);
        if (locked.status !== 'open' && locked.status !== 'recovery_required') return;
        if (locked.price == null) return;

        const leftover = await this.remainingHold(tx, locked);
        const newHold = holdFor(market, locked.side, locked.price, newRemaining).amount;
        if (leftover < newHold) {
          throw new TradeError(
            `order ${locked.id} remaining hold ${formatAmount(leftover)} cannot cover amended hold ${formatAmount(newHold)}`,
            'trade.hold_uncovered',
          );
        }
        const release = sub(leftover, newHold);
        if (release > 0n) {
          await this.ledger.post(
            withLedgerAttribution(
              recipes.orderHoldRelease({
                orderId: locked.id,
                userId: locked.userId,
                assetId: locked.holdAsset,
                amount: release,
                sequence: version,
              }),
              attributionFromOrder(locked),
            ),
          );
        }
        const newQty = locked.filledQty + newRemaining;
        const amendReleased = locked.amendReleased + release;
        await tx`
          UPDATE trade.orders
             SET qty = ${formatAmount(newQty)}::numeric,
                 amend_released = ${formatAmount(amendReleased)}::numeric,
                 engine_version = ${version},
                 engine_sequence = COALESCE(${sequence}, engine_sequence),
                 status = 'open',
                 recovery_reason = NULL,
                 reconciliation_key = NULL,
                 updated_at = now()
           WHERE id = ${locked.id}
        `;
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
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
    return withMoneySpan(
      'trade.replaceOrder',
      { operation: 'replace_order', userId: principal.userId, orderId: originalOrderId },
      async () => {
        requireScope(principal, 'trade:write');

        const original = await this.findOrder(originalOrderId);
        if (!original || original.userId !== principal.userId) {
          throw new TradeError(`order ${originalOrderId} not found`, 'trade.order_not_found');
        }
        if (!input.clientOrderId || input.clientOrderId.length < 1 || input.clientOrderId.length > 56) {
          throw new TradeError('replacement clientOrderId is required (1–56 chars)', 'trade.client_order_id_required');
        }

        const market = await this.requireMarket(input);
        if (market.id !== original.marketId) {
          return this.replaceOutcome(original, null, 'ORIGINAL_NOT_REPLACEABLE', 'trade.replace_market_mismatch');
        }
        if (market.kind !== 'spot' || market.paper) {
          return this.replaceOutcome(original, null, 'ORIGINAL_NOT_REPLACEABLE', 'trade.market_kind_unsupported');
        }
        const requestHash = replacementRequestHash(original.id, input);
        const replacementClientId = replacementClientOrderId(input.clientOrderId);
        const replacementId = orderIdFor(principal.userId, market.id, replacementClientId);
        const requestFence = await this.sql<
          Array<{ original_order_id: string; request_hash: string; replacement_order_id: string | null }>
        >`
          INSERT INTO trade.order_replace_requests
            (user_id, market_id, client_order_id, original_order_id, request_hash)
          VALUES
            (${principal.userId}, ${market.id}, ${input.clientOrderId}, ${original.id}, ${requestHash})
          ON CONFLICT (user_id, market_id, client_order_id) DO NOTHING
          RETURNING original_order_id, request_hash, replacement_order_id
        `;
        const requestAlreadyExists = requestFence.length === 0;
        if (requestAlreadyExists) {
          const prior = await this.sql<Array<{ original_order_id: string; request_hash: string; replacement_order_id: string | null }>>`
            SELECT original_order_id, request_hash, replacement_order_id
              FROM trade.order_replace_requests
             WHERE user_id = ${principal.userId}
               AND market_id = ${market.id}
               AND client_order_id = ${input.clientOrderId}
          `;
          const priorRow = prior[0];
          if (!priorRow || priorRow.original_order_id !== original.id || priorRow.request_hash !== requestHash) {
            return this.replaceOutcome(original, null, 'REPLACE_CONFLICT', 'trade.replace_conflict');
          }
        }
        const existingReplacement = await this.findOrder(replacementId);
        if (existingReplacement) {
          if (existingReplacement.replacementOf !== original.id || existingReplacement.replacementRequestHash !== requestHash) {
            return this.replaceOutcome(original, null, 'REPLACE_CONFLICT', 'trade.replace_conflict');
          }
          return this.replaceOutcome(
            original,
            existingReplacement,
            existingReplacement.status === 'recovery_required' ? 'REPLACEMENT_SUBMIT_UNKNOWN' : 'IDEMPOTENT_RETRY',
            existingReplacement.recoveryReason,
            existingReplacement.status === 'recovery_required',
            true,
          );
        }

        if (original.status === 'recovery_required') {
          return this.replaceOutcome(
            original,
            null,
            'RECONCILIATION_REQUIRED',
            original.recoveryReason ?? 'RECONCILIATION_REQUIRED',
            true,
            requestAlreadyExists,
          );
        }
        if (original.filledQty > 0n) {
          return this.replaceOutcome(original, null, 'ORIGINAL_PARTIAL', 'trade.replace_partial_original', false, requestAlreadyExists);
        }
        if (original.status !== 'open') {
          return this.replaceOutcome(original, null, 'ORIGINAL_NOT_REPLACEABLE', 'trade.order_not_open', false, requestAlreadyExists);
        }

        // Ownership is checked before the original is cancelled. A replacement
        // must never cancel a live order and then discover its new label is foreign.
        if (input.subAccountId != null) await assertSubAccountOwned(this.subAccounts, principal.userId, input.subAccountId);
        const orderType = requireSupportedType(input.type);
        assertTradable(market, {
          futuresEnabled: this.futuresEnabled,
          optionsSettlementLawStamped: this.optionsSettlementAssetLaw.trim().length > 0,
        });
        assertSettlementRails(market);
        assertMarketOpen(market, this.now());
        assertQty(market, input.qty);
        if (orderType === 'limit') {
          if (input.price == null) throw new TradeError('a limit order requires a price', 'trade.invalid_price');
          assertPrice(market, input.price);
          assertNotional(market, input.price, input.qty);
        } else if (input.price != null) {
          throw new TradeError('a market order must not carry a price', 'trade.invalid_price');
        }

        // Authority is required before cancel, so an unavailable PX-S01 source
        // cannot strand the caller by cancelling an order it cannot replace.
        try {
          await this.assertLifecycleAction(market, input.tif === 'PO' ? 'PLACE_POST_ONLY' : 'PLACE');
        } catch (err) {
          if (err instanceof TradeError && err.code.startsWith('trade.lifecycle_')) {
            return this.replaceOutcome(original, null, 'LIFECYCLE_REFUSED', err.code, false, requestAlreadyExists);
          }
          throw err;
        }

        let cancelled: OrderRecord;
        try {
          cancelled = await this.cancelOrder(principal, original.id);
        } catch (err) {
          const afterCancel = await this.findOrder(original.id);
          const racedReplacement = await this.findOrder(replacementId);
          if (racedReplacement?.replacementOf === original.id && racedReplacement.replacementRequestHash === requestHash) {
            return this.replaceOutcome(
              afterCancel ?? original,
              racedReplacement,
              racedReplacement.status === 'recovery_required' ? 'REPLACEMENT_SUBMIT_UNKNOWN' : 'IDEMPOTENT_RETRY',
              racedReplacement.recoveryReason,
              racedReplacement.status === 'recovery_required',
              true,
            );
          }
          if (afterCancel?.recoveryReason === 'CANCEL_UNKNOWN') {
            return this.replaceOutcome(afterCancel, null, 'CANCEL_UNKNOWN', 'CANCEL_UNKNOWN', true, requestAlreadyExists);
          }
          if (afterCancel?.status === 'recovery_required') {
            return this.replaceOutcome(
              afterCancel,
              null,
              'RECONCILIATION_REQUIRED',
              afterCancel.recoveryReason ?? 'RECONCILIATION_REQUIRED',
              true,
              requestAlreadyExists,
            );
          }
          // The engine may already be cancelled while finalization failed at
          // the ledger boundary. Freeze the original rather than pretending
          // the release completed or attempting a replacement hold.
          if (afterCancel?.status === 'open' || afterCancel?.status === 'pending') {
            await this.markRecoveryRequired(original.id, 'RECONCILIATION_REQUIRED');
            const frozen = (await this.findOrder(original.id)) ?? afterCancel;
            return this.replaceOutcome(frozen, null, 'RECONCILIATION_REQUIRED', 'RECONCILIATION_REQUIRED', true, requestAlreadyExists);
          }
          throw err;
        }
        if (cancelled.status !== 'cancelled') {
          return this.replaceOutcome(cancelled, null, 'RECONCILIATION_REQUIRED', 'RECONCILIATION_REQUIRED', true, requestAlreadyExists);
        }

        const replacementInput: PlaceOrderInput = {
          ...input,
          marketId: market.id,
          clientOrderId: replacementClientId,
          replacementOf: original.id,
          replacementRequestHash: requestHash,
        };
        try {
          const replacement = await this.placeOrder(principal, replacementInput);
          await this.sql`
            UPDATE trade.order_replace_requests
               SET replacement_order_id = ${replacement.id}
             WHERE user_id = ${principal.userId}
               AND market_id = ${market.id}
               AND client_order_id = ${input.clientOrderId}
          `;
          return this.replaceOutcome(cancelled, replacement, 'REPLACED', null, false);
        } catch (err) {
          const persistedReplacement = await this.findOrder(replacementId);
          if (persistedReplacement?.replacementOf === original.id && persistedReplacement.replacementRequestHash === requestHash) {
            if (persistedReplacement.status === 'recovery_required') {
              await this.sql`
                UPDATE trade.order_replace_requests
                   SET replacement_order_id = ${persistedReplacement.id}
                 WHERE user_id = ${principal.userId}
                   AND market_id = ${market.id}
                   AND client_order_id = ${input.clientOrderId}
              `;
              return this.replaceOutcome(
                cancelled,
                persistedReplacement,
                'REPLACEMENT_SUBMIT_UNKNOWN',
                persistedReplacement.recoveryReason,
                true,
              );
            }
            return this.replaceOutcome(cancelled, persistedReplacement, 'IDEMPOTENT_RETRY', null, false, true);
          }
          // No row means no replacement hold was posted. The original is still
          // honestly cancelled; callers may correct the request or retry the
          // same replacement key without any hidden second risk.
          if (err instanceof TradeError) {
            return this.replaceOutcome(cancelled, null, 'REPLACEMENT_NOT_SUBMITTED', err.code);
          }
          throw err;
        }
      },
    );
  }

  private replaceOutcome(
    original: OrderRecord,
    replacement: OrderRecord | null,
    code: ReplaceOutcomeCode,
    reasonCode: string | null,
    reconciliationRequired = false,
    idempotent = false,
  ): ReplaceOrderOutcome {
    return {
      accepted: code === 'REPLACED' || code === 'IDEMPOTENT_RETRY',
      idempotent,
      code,
      reasonCode,
      reconciliationRequired,
      original,
      replacement,
    };
  }

  /**
   * Cancel every open/pending order for the principal (optional market filter).
   * Sequential on purpose: each cancel is its own hold-release money path.
   */
  async cancelAllOrders(principal: Principal, marketId?: string): Promise<OrderRecord[]> {
    requireScope(principal, 'trade:write');
    // Mutation, not a list door: pull every rest for this principal. openOrders is a
    // published page and must not silently leave orders past LIMIT uncancelled.
    const rows = marketId
      ? await this.sql<OrderRow[]>`
          SELECT * FROM trade.orders
           WHERE user_id = ${principal.userId} AND status IN ('pending', 'open', 'recovery_required') AND market_id = ${marketId}
           ORDER BY created_at DESC
        `
      : await this.sql<OrderRow[]>`
          SELECT * FROM trade.orders
           WHERE user_id = ${principal.userId} AND status IN ('pending', 'open', 'recovery_required')
           ORDER BY created_at DESC
        `;
    const open = rows.map(toOrder);
    const out: OrderRecord[] = [];
    for (const order of open) {
      out.push(await this.cancelOrder(principal, order.id));
    }
    return out;
  }

  /**
   * Matching mass-cancel for this principal on one market.
   * Owner is the authenticated account. Trade never sends another account or a session.
   * Engine first, then one finalize per pulled rest — unknown outcome does not release.
   */
  async massCancelOrders(principal: Principal, marketId: string): Promise<OrderRecord[]> {
    return withMoneySpan('trade.massCancelOrders', { operation: 'mass_cancel', userId: principal.userId, marketId }, async () => {
      requireScope(principal, 'trade:write');
      const accountId = principal.userId;
      if (accountId.length === 0) {
        throw new TradeError('missing account cannot mass-cancel; trade does not invent an owner', 'trade.not_owner');
      }

      const market = await this.marketById(marketId);
      if (!market) {
        throw new TradeError(`market ${marketId} not found`, 'trade.market_not_found');
      }

      let result: Awaited<ReturnType<MatchingClient['massCancel']>>;
      try {
        result = await this.matching.massCancel(market.id, { accountId });
      } catch (err) {
        throw err;
      }

      if (!result.accepted) {
        throw new TradeError(result.rejected?.message ?? 'mass-cancel refused', 'trade.order_not_open');
      }

      const out: OrderRecord[] = [];
      for (const cancellation of result.cancellations) {
        if (cancellation.accountId !== accountId) continue;
        const order = await this.findOrder(cancellation.orderId);
        if (!order || order.userId !== principal.userId) continue;
        if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required') continue;
        await this.finalize(order.id, 'cancelled');
        const settled = await this.findOrder(order.id);
        if (settled) out.push(settled);
      }
      return out;
    });
  }

  // ── Applying what the engine said ─────────────────────────────────────────

  private async applySubmitResult(market: Market, orderId: string, result: EngineSubmitResult): Promise<void> {
    if (!result.accepted) {
      // H8c: matching already accepted this orderId (200 then trade death).
      // Retry is duplicate_order_id with empty fills — not a reject. Releasing
      // would unfund a live rest. Hold stays; fills arrive on the bus.
      if (result.rejected?.code === 'duplicate_order_id') {
        return;
      }
      // A rejection is a valid answer, not a fault: post-only refusing to cross
      // is the feature working. The order never touched the book, so the whole
      // hold comes straight back.
      //
      // The reject code is recorded first because it carries no money; the
      // release and the terminal status are done together by `finalize`, in
      // that order, for the reason spelled out there.
      await this.sql`
        UPDATE trade.orders SET reject_code = ${result.rejected?.code ?? 'rejected'}, updated_at = now() WHERE id = ${orderId}
      `;
      await this.finalize(orderId, 'rejected');
      return;
    }

    if (result.sequence !== null || result.resting?.version != null) {
      const version = result.resting?.version ?? 1;
      await this.sql`
        UPDATE trade.orders
           SET engine_sequence = COALESCE(${result.sequence}, engine_sequence),
               engine_version = ${version},
               updated_at = now()
         WHERE id = ${orderId}
      `;
    }

    // A triggered stop cannot occur while this service refuses stop orders, but
    // the outcome is flattened rather than ignored: if the engine ever reports
    // one, the fills and cancellations inside it settle exactly like any other,
    // instead of being silently dropped along with somebody's money.
    const fills: EngineFill[] = [...result.fills];
    const cancellations: EngineCancellation[] = [...result.cancellations];
    for (const triggered of result.triggered) {
      fills.push(...triggered.fills);
      cancellations.push(...triggered.cancellations);
    }

    await this.settleOutcome(market, fills, cancellations);

    // The submitted order rested with a remainder → it stays open, holding the
    // rest of its funds. It did not rest → it is done, and whatever is left of
    // the hold goes back now rather than at some future sweep.
    if (result.resting === null || result.resting.orderId !== orderId) {
      await this.finalizeIfComplete(orderId);
    }
  }

  /**
   * Settle one submission's fills and cancellations, in that order.
   *
   * Fills first, always. A cancellation releases `hold - consumed`, and
   * `consumed` is derived from the fills table — so releasing before the fills
   * are recorded would hand back money a fill is about to spend.
   */
  private async settleOutcome(market: Market, fills: readonly EngineFill[], cancellations: readonly EngineCancellation[]): Promise<void> {
    const touched = new Set<string>();

    for (const fill of [...fills].sort((a, b) => a.sequence - b.sequence)) {
      await this.settleFill(market, fill);
      touched.add(fill.makerOrderId);
      touched.add(fill.takerOrderId);
    }

    // An IOC remainder, a market remainder, or a resting order pulled by
    // self-trade prevention. §5.1 unifies them because this service does the
    // same thing with all three: the order is done, release what is left.
    for (const cancellation of cancellations) {
      await this.finalize(cancellation.orderId, 'cancelled');
      touched.delete(cancellation.orderId);
    }

    // A maker that filled completely leaves the book without a cancellation —
    // it simply is not there any more. It still has a hold to close out: a buy
    // was funded at `ceil(price x qty)` and consumed `sum(floor(price x qty_i))`,
    // so a wei of rounding can be left behind. Left behind is exactly what it
    // must not be.
    for (const id of touched) await this.finalizeIfComplete(id);
  }

  /**
   * Turn one match into one `tradeFill` ledger transaction (§5.2 step 3).
   *
   * ORDERING — the rows are committed BEFORE the ledger post, which is the
   * opposite of the order svc-token uses for a stake, and deliberately so. The
   * amount still owed back to a user is derived as `hold - Σ fills`, so:
   *
   *   · rows first  → the fills table can only ever be AHEAD of the ledger, so
   *                   `consumed` is never understated, so a release is never
   *                   overstated. Worst case a fill is recorded but unsettled:
   *                   the funds stay in `hold`, nothing is lost, and re-running
   *                   this method re-posts the same idempotency key and heals it.
   *   · ledger first→ a crash before the row is written understates `consumed`,
   *                   and the next release hands back money this fill already
   *                   spent — drawn out of whatever else that user has in
   *                   `hold`. That is one order silently paying for another.
   *
   * Idempotent at both layers: the ledger key is `trade.fill:<fillId>` where
   * `fillId` derives from (market, engine sequence), and the unique index on
   * (market, sequence, liquidity) makes a second row impossible.
   */
  /**
   * Write one leg of a fill, and decide what a collision MEANS before absorbing it.
   *
   * ── The gap this closes ──────────────────────────────────────────────────
   *
   * `trade.fills` carries TWO unique keys: `fills_pkey` on `id`, and
   * `fills_market_sequence_role_idx` on `(market_id, sequence, liquidity)`. The
   * insert arbitrated on `id` only. Postgres applies `ON CONFLICT` to the named
   * arbiter and to nothing else, so a row that cleared the primary key and then
   * collided on the sequence index raised a bare 23505 — surfacing to the
   * caller as a 500 with a Postgres string in it, and to CI as an intermittent
   * CX-8 failure that a re-run makes disappear.
   *
   * ── Why this is not just a wider ON CONFLICT ─────────────────────────────
   *
   * Widening to `ON CONFLICT DO NOTHING` would make the symptom vanish, and
   * that is exactly why it is wrong. The two ways to reach this collision want
   * OPPOSITE handling:
   *
   *   · REDELIVERY — the same match settled twice (JetStream redelivery, a
   *     retried submission, an operator replaying a day). `fillLegIdFor` is
   *     derived from `(market, sequence, role)`, so the same match always
   *     computes the same id and the same row. Nothing to do: the row is
   *     already correct and the ledger post below is idempotent on
   *     `trade.fill:<fillId>`. Absorb it silently.
   *
   *   · SEQUENCE REUSE — a DIFFERENT match claimed a `(market, sequence)` that
   *     is already spoken for. `OrderBook.sequence` is an in-memory counter
   *     that starts at 0 and is rebuilt by journal replay, so a book restored
   *     without its journal while `trade.fills` still holds the old rows hands
   *     the same sequence to a new trade. That is not a duplicate — it is the
   *     ledger's `trade.fill:<fillId>` key aliasing two different trades onto
   *     one transaction, and the second one silently never settling.
   *
   * Swallowing the second case is worse than the 500 it replaces: a 500 is at
   * least visible. So the row is read back and compared, and only a byte-equal
   * match is treated as a redelivery.
   *
   * The comparison is on the money-bearing columns — price, qty, quote amount,
   * fee — plus both order ids and the owner. `ts`/`created_at` are excluded:
   * they differ between the original write and a replay by construction, and
   * comparing them would turn every legitimate redelivery into an incident.
   */
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
    sequence: number;
    attribution: AuthAttribution;
  }): Promise<void> {
    const attribution = requireAuthAttribution(leg.attribution);
    let inserted: Array<{ id: string }>;
    try {
      inserted = await this.sql<Array<{ id: string }>>`
        INSERT INTO trade.fills (
          id, order_id, counter_order_id, market_id, user_id, side, liquidity,
          price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence,
          session_id, api_key_id
        ) VALUES (
          ${leg.id}, ${leg.orderId}, ${leg.counterOrderId},
          ${leg.marketId}, ${leg.userId}, ${leg.side}, ${leg.role},
          ${formatAmount(leg.price)}::numeric, ${formatAmount(leg.qty)}::numeric, ${formatAmount(leg.quoteAmount)}::numeric,
          ${leg.feeAsset}, ${formatAmount(leg.feeAmount)}::numeric, ${leg.feeBps}, ${leg.sequence},
          ${attribution.sessionId}, ${attribution.apiKeyId}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
    } catch (err) {
      /**
       * `ON CONFLICT (id)` names ONE arbiter, and Postgres applies the DO
       * NOTHING to that index alone. A row that clears `fills_pkey` and then
       * collides on `fills_market_sequence_role_idx` therefore RAISES rather
       * than returning zero rows — which is the whole bug: it left the caller
       * with a 500 carrying a Postgres string.
       *
       * Catching only 23505 (unique_violation). Anything else — a foreign key
       * to a deleted order, a CHECK on a negative amount — is a different
       * failure and must not be quietly re-interpreted as an idempotency
       * question.
       */
      if ((err as { code?: string })?.code !== '23505') throw err;
      inserted = [];
    }

    // Inserted, or the id already held this exact row. Either way we are done —
    // the id IS the business key, so an id collision cannot be a different fill.
    if (inserted.length > 0) return;

    /**
     * Nothing inserted. Two sub-cases, and only one of them is benign.
     *
     * The id conflict path is the ordinary redelivery and needs no read: the id
     * is derived from the same three columns the sequence index covers, so a
     * row holding this id necessarily holds this `(market, sequence, role)`.
     * Read it back anyway — cheaply, once, off the happy path — because the
     * whole point of this method is to stop assuming which conflict fired.
     */
    const [existing] = await this.sql<Array<FillRow>>`
      SELECT * FROM trade.fills
      WHERE market_id = ${leg.marketId} AND sequence = ${leg.sequence} AND liquidity = ${leg.role}
      LIMIT 1
    `;

    if (!existing) {
      // The insert did nothing and no row is there. A concurrent transaction
      // holds it uncommitted, or something outside this service deleted it.
      // Either way this settle has not happened and must not report success.
      throw new TradeError(
        `fill ${leg.sequence} on ${leg.symbol} (${leg.role}) neither inserted nor found — a concurrent writer holds it uncommitted`,
        'trade.fill_sequence_conflict',
      );
    }

    const same =
      existing.id === leg.id &&
      existing.order_id === leg.orderId &&
      existing.counter_order_id === leg.counterOrderId &&
      existing.user_id === leg.userId &&
      parseAmount(existing.price) === leg.price &&
      parseAmount(existing.qty) === leg.qty &&
      parseAmount(existing.quote_amount) === leg.quoteAmount &&
      parseAmount(existing.fee_amount) === leg.feeAmount &&
      existing.fee_asset === leg.feeAsset &&
      (existing.session_id ?? null) === attribution.sessionId &&
      (existing.api_key_id ?? null) === attribution.apiKeyId;

    // The ordinary case: this match already settled. The ledger post that
    // follows is keyed on `trade.fill:<fillId>` and returns the original
    // transaction, so continuing is a no-op rather than a second movement.
    if (same) return;

    /**
     * A DIFFERENT trade already owns this sequence.
     *
     * Refusing is the only safe answer. Writing under a new id would leave the
     * ledger key `trade.fill:<market>:<sequence>` pointing at whichever trade
     * settled first, and the second trade's money would never move while its
     * fill row claimed it had. The order fails, the hold stays intact, and the
     * name says what to investigate.
     */
    throw new TradeError(
      `fill sequence ${leg.sequence} on ${leg.symbol} (${leg.role}) is already held by a DIFFERENT match ` +
        `(stored fill ${existing.id} for order ${existing.order_id}; this match is ${leg.id} for order ${leg.orderId}). ` +
        `The engine's sequence counter has been reused — a book was almost certainly restored without its journal. ` +
        `Settling would alias two trades onto one ledger idempotency key.`,
      'trade.fill_sequence_conflict',
    );
  }

  private async settleFill(market: Market, fill: EngineFill): Promise<void> {
    const qty = parseAmount(fill.qty);
    const price = parseAmount(fill.price);

    /**
     * FLOORED, and it has to be. The buy side was funded at `ceil(price x qty)`
     * for the whole order; a sum of floored parts can never exceed the ceiling
     * of the whole, so a partially filled order can never consume more hold
     * than it was given. Ceiling the parts could, by one wei per fill, and one
     * wei short at settlement is a fill the ledger refuses to post.
     */
    const quoteAmount = mul(price, qty, 'floor');
    if (quoteAmount <= 0n) {
      // The market's tick x lot grid is supposed to make this unreachable, and
      // the database has a CHECK saying so. If it happens anyway the listing is
      // wrong, and settling it is impossible — the ledger will not post a
      // movement of nothing.
      throw new TradeError(
        `fill ${fill.sequence} on ${market.symbol} has a zero quote amount — check the market's tick and lot sizes`,
        'trade.dust_fill',
      );
    }

    const maker = await this.findOrder(fill.makerOrderId);
    const taker = await this.findOrder(fill.takerOrderId);
    const makerIsHouseMm = isHouseMmAccount(fill.makerAccountId);

    // House MM seed orders are not in trade.orders (seedMarket holds + matching
    // only). User taker must still exist. MM-as-taker is residual.
    if (!taker) {
      throw new TradeError(
        `fill ${fill.sequence} references an order this service does not know (${fill.makerOrderId} / ${fill.takerOrderId})`,
        'trade.order_not_found',
      );
    }
    if (!maker && !makerIsHouseMm) {
      throw new TradeError(
        `fill ${fill.sequence} references an order this service does not know (${fill.makerOrderId} / ${fill.takerOrderId})`,
        'trade.order_not_found',
      );
    }

    // ── House MM maker path (trade.mm-bot) ──────────────────────────────────
    // Route by identity, not "order row missing". A prior partial fill inserts a
    // stub trade.orders row; the next match must still use marketMakerMakerFill
    // (MM pot holds), never user tradeFill against HOUSE_MM_USER_UUID.
    const makerIsHouseMmRow = maker != null && maker.userId === HOUSE_MM_USER_UUID;
    if (makerIsHouseMm || makerIsHouseMmRow) {
      const rates = this.ratesForFill(0, taker.feeDiscountBps);
      const takerBuys = fill.takerSide === 'buy';
      // BEFORE any fill row: fee-equal-to-receivable is permanently unpostable
      // (recipe throws; re-run throws). Inserting first left remainingHold
      // overstated forever — README recovery claim was false for this class.
      this.assertFillFeesPostable(fill.sequence, market.symbol, fill.takerSide, qty, quoteAmount, rates);
      const takerFee = mulBps(takerBuys ? qty : quoteAmount, rates.takerFeeBps);
      const makerFee = mulBps(takerBuys ? quoteAmount : qty, rates.makerFeeBps);
      const makerSide = takerBuys ? ('sell' as const) : ('buy' as const);
      const makerFeeAsset = takerBuys ? market.quoteAsset : market.baseAsset;
      const takerFeeAsset = takerBuys ? market.baseAsset : market.quoteAsset;
      // fills.order_id FK → trade.orders. Seed path never wrote a row; insert a
      // bookkeeping stub. Hold value lives on MM ledger pots; row hold_amount
      // is the fill notional (orders_hold_positive_ck) for this match only.
      // seeded=true so public tape / candles exclude house MM prints (SD-3).
      const makerHoldAsset = takerBuys ? market.baseAsset : market.quoteAsset;
      const makerHoldAmount = takerBuys ? qty : quoteAmount;
      const mmAttribution = houseMmAttribution();
      const takerAttribution = attributionFromOrder(taker);
      await this.sql`
        INSERT INTO trade.orders (
          id, user_id, market_id, side, type, price, qty, status, tif,
          hold_asset, hold_amount, fee_discount_bps, seeded, session_id, api_key_id
        ) VALUES (
          ${fill.makerOrderId}, ${HOUSE_MM_USER_UUID}, ${market.id}, ${makerSide}, ${'limit'},
          ${formatAmount(price)}::numeric, ${formatAmount(qty)}::numeric, ${'open'}, ${'PO'},
          ${makerHoldAsset}, ${formatAmount(makerHoldAmount)}::numeric, ${0}, ${true},
          ${mmAttribution.sessionId}, ${mmAttribution.apiKeyId}
        )
        ON CONFLICT (id) DO NOTHING
      `;

      // Same guard as the classic path below: a sequence already owned by a
      // different match must refuse, not silently no-op. The MM pot is still
      // real money.
      await this.insertFillLeg({
        id: fillLegIdFor(market.id, fill.sequence, 'maker'),
        orderId: fill.makerOrderId,
        counterOrderId: taker.id,
        marketId: market.id,
        symbol: market.symbol,
        userId: HOUSE_MM_USER_UUID,
        side: makerSide,
        role: 'maker',
        price,
        qty,
        quoteAmount,
        feeAsset: makerFeeAsset,
        feeAmount: makerFee,
        feeBps: rates.makerFeeBps,
        sequence: fill.sequence,
        attribution: mmAttribution,
      });
      await this.insertFillLeg({
        id: fillLegIdFor(market.id, fill.sequence, 'taker'),
        orderId: taker.id,
        counterOrderId: fill.makerOrderId,
        marketId: market.id,
        symbol: market.symbol,
        userId: taker.userId,
        side: fill.takerSide,
        role: 'taker',
        price,
        qty,
        quoteAmount,
        feeAsset: takerFeeAsset,
        feeAmount: takerFee,
        feeBps: rates.takerFeeBps,
        sequence: fill.sequence,
        attribution: takerAttribution,
      });

      await this.refreshFilledQty(taker.id);

      await this.ledger.post(
        withFillLedgerAttribution(
          recipes.marketMakerMakerFill({
            fillId: fillIdFor(market.id, fill.sequence),
            takerId: taker.userId,
            makerOrderId: fill.makerOrderId,
            takerOrderId: taker.id,
            baseAsset: market.baseAsset,
            quoteAsset: market.quoteAsset,
            qty,
            quoteAmount,
            takerSide: fill.takerSide,
            makerFeeBps: rates.makerFeeBps,
            takerFeeBps: rates.takerFeeBps,
          }),
          mmAttribution,
          takerAttribution,
        ),
      );

      await this.notifyAffiliateAccrue({
        fillId: fillIdFor(market.id, fill.sequence),
        makerUserId: HOUSE_MM_USER_UUID,
        takerUserId: taker.userId,
        makerFee,
        takerFee,
        makerFeeAsset,
        takerFeeAsset,
      });
      await this.notifyAffiliatePayout({
        fillId: fillIdFor(market.id, fill.sequence),
        makerUserId: HOUSE_MM_USER_UUID,
        takerUserId: taker.userId,
        makerFee,
        takerFee,
        makerFeeAsset,
        takerFeeAsset,
      });

      const takerSettledAt = new Date().toISOString();
      await this.bus.publish(
        'fillSettled',
        {
          fillId: fillLegIdFor(market.id, fill.sequence, 'taker'),
          orderId: taker.id,
          userId: taker.userId,
          marketId: market.id,
          side: fill.takerSide,
          liquidity: 'taker',
          price: formatAmount(price),
          qty: formatAmount(qty),
          quoteAmount: formatAmount(quoteAmount),
          feeAsset: takerFeeAsset,
          feeAmount: formatAmount(takerFee),
          feeBps: rates.takerFeeBps,
          sequence: fill.sequence,
          ts: takerSettledAt,
        },
        { idempotencyKey: `trade.fill.settled:${market.id}:${fill.sequence}:taker` },
      );
      await this.notifyDropCopyFill({
        fillId: fillLegIdFor(market.id, fill.sequence, 'taker'),
        orderId: taker.id,
        userId: taker.userId,
        marketId: market.id,
        side: fill.takerSide,
        price: formatAmount(price),
        qty: formatAmount(qty),
        quoteAmount: formatAmount(quoteAmount),
        feeAsset: takerFeeAsset,
        feeAmount: formatAmount(takerFee),
        sequence: fill.sequence,
        ts: takerSettledAt,
        order: taker,
      });
      const latest = await this.findOrder(taker.id);
      if (latest) await this.publishOrderUpdated(latest);
      return;
    }

    // Both user orders — classic path.
    if (!maker) {
      throw new TradeError(
        `fill ${fill.sequence} references an order this service does not know (${fill.makerOrderId} / ${fill.takerOrderId})`,
        'trade.order_not_found',
      );
    }

    // Both rates in one place: `tradeFill` posts them in one six-entry
    // transaction, and resolving them apart would let one side's rounding drift
    // from the other's without anything failing.
    const rates = this.ratesForFill(maker.feeDiscountBps, taker.feeDiscountBps);

    const takerBuys = fill.takerSide === 'buy';
    // BEFORE fill rows: same fee-exhaust guard as the MM path above. Recipe
    // layer already refuses; without this the fills table permanently outruns
    // the ledger and release understates remainder.
    this.assertFillFeesPostable(fill.sequence, market.symbol, fill.takerSide, qty, quoteAmount, rates);
    // Each side's fee comes out of what that side RECEIVES (see `tradeFill`).
    const takerFee = mulBps(takerBuys ? qty : quoteAmount, rates.takerFeeBps);
    const makerFee = mulBps(takerBuys ? quoteAmount : qty, rates.makerFeeBps);

    const legs = [
      {
        role: 'maker' as const,
        order: maker,
        counterOrderId: taker.id,
        side: takerBuys ? ('sell' as const) : ('buy' as const),
        feeAsset: takerBuys ? market.quoteAsset : market.baseAsset,
        feeAmount: makerFee,
        feeBps: rates.makerFeeBps,
      },
      {
        role: 'taker' as const,
        order: taker,
        counterOrderId: maker.id,
        side: fill.takerSide,
        feeAsset: takerBuys ? market.baseAsset : market.quoteAsset,
        feeAmount: takerFee,
        feeBps: rates.takerFeeBps,
      },
    ];

    // Conflict on deterministic fill id (market+seq+role). Concurrent inline
    // settle + NATS redelivery must not 500 on fills_pkey — that broke CX-8 L3.
    const makerAttribution = attributionFromOrder(maker);
    const takerAttribution = attributionFromOrder(taker);
    for (const leg of legs) {
      await this.insertFillLeg({
        id: fillLegIdFor(market.id, fill.sequence, leg.role),
        orderId: leg.order.id,
        counterOrderId: leg.counterOrderId,
        marketId: market.id,
        symbol: market.symbol,
        userId: leg.order.userId,
        side: leg.side,
        role: leg.role,
        price,
        qty,
        quoteAmount,
        feeAsset: leg.feeAsset,
        feeAmount: leg.feeAmount,
        feeBps: leg.feeBps,
        sequence: fill.sequence,
        attribution: leg.role === 'maker' ? makerAttribution : takerAttribution,
      });
    }

    // Recomputed from the fills rather than incremented, so it is idempotent by
    // construction and `filled_qty = Σ fills.qty` is true by definition rather
    // than by hope. A test asserts it anyway.
    for (const leg of legs) await this.refreshFilledQty(leg.order.id);

    // ── 5 · THE FILL ────────────────────────────────────────────────────────
    //
    // The six-entry atomic fill. Both sides' holds are drawn down and both
    // sides' fees land in `houseFees('trade', …)` in one transaction, so there
    // is no interleaving in which one side has paid and the other has not.
    await this.ledger.post(
      withFillLedgerAttribution(
        recipes.tradeFill({
          fillId: fillIdFor(market.id, fill.sequence),
          makerId: maker.userId,
          takerId: taker.userId,
          // P0-3: name whose reservation each side is spending. These come from
          // the order store — this service's source of truth for a fill (see the
          // P0-2 ADR) — not from the engine event, which carries neither.
          makerOrderId: maker.id,
          takerOrderId: taker.id,
          baseAsset: market.baseAsset,
          quoteAsset: market.quoteAsset,
          qty,
          quoteAmount,
          takerSide: fill.takerSide,
          makerFeeBps: rates.makerFeeBps,
          takerFeeBps: rates.takerFeeBps,
        }),
        makerAttribution,
        takerAttribution,
      ),
    );

    await this.notifyAffiliateAccrue({
      fillId: fillIdFor(market.id, fill.sequence),
      makerUserId: maker.userId,
      takerUserId: taker.userId,
      makerFee,
      takerFee,
      makerFeeAsset: takerBuys ? market.quoteAsset : market.baseAsset,
      takerFeeAsset: takerBuys ? market.baseAsset : market.quoteAsset,
    });
    await this.notifyAffiliatePayout({
      fillId: fillIdFor(market.id, fill.sequence),
      makerUserId: maker.userId,
      takerUserId: taker.userId,
      makerFee,
      takerFee,
      makerFeeAsset: takerBuys ? market.quoteAsset : market.baseAsset,
      takerFeeAsset: takerBuys ? market.baseAsset : market.quoteAsset,
    });

    // User-visible fill + order snapshots for private WS (not money — ledger already moved).
    for (const leg of legs) {
      const settledAt = new Date().toISOString();
      await this.bus.publish(
        'fillSettled',
        {
          fillId: fillLegIdFor(market.id, fill.sequence, leg.role),
          orderId: leg.order.id,
          userId: leg.order.userId,
          marketId: market.id,
          side: leg.side,
          liquidity: leg.role,
          price: formatAmount(price),
          qty: formatAmount(qty),
          quoteAmount: formatAmount(quoteAmount),
          feeAsset: leg.feeAsset,
          feeAmount: formatAmount(leg.feeAmount),
          feeBps: leg.feeBps,
          sequence: fill.sequence,
          ts: settledAt,
        },
        { idempotencyKey: `trade.fill.settled:${market.id}:${fill.sequence}:${leg.role}` },
      );
      await this.notifyDropCopyFill({
        fillId: fillLegIdFor(market.id, fill.sequence, leg.role),
        orderId: leg.order.id,
        userId: leg.order.userId,
        marketId: market.id,
        side: leg.side,
        price: formatAmount(price),
        qty: formatAmount(qty),
        quoteAmount: formatAmount(quoteAmount),
        feeAsset: leg.feeAsset,
        feeAmount: formatAmount(leg.feeAmount),
        sequence: fill.sequence,
        ts: settledAt,
        order: leg.order,
      });
      const latest = await this.findOrder(leg.order.id);
      if (latest) await this.publishOrderUpdated(latest);
    }
  }

  /**
   * After house fees posted. Identity accrue is best-effort (412 / down / timeout
   * must not unwind the fill). Never invents commission rates.
   */
  private async notifyAffiliateAccrue(input: {
    fillId: string;
    makerUserId: string;
    takerUserId: string;
    makerFee: Amount;
    takerFee: Amount;
    makerFeeAsset: string;
    takerFeeAsset: string;
  }): Promise<void> {
    await fireAffiliateAccrue(this.affiliateAccrue, affiliateLegsAfterFill({ ...input, houseMmUserId: HOUSE_MM_USER_UUID }));
  }

  /**
   * After ledger settle. Drop-copy is evidence — ingest failure must not unwind money.
   * Source is explicit (rfq) or proveable from the order (rest). Session-only omits.
   */
  private async notifyDropCopyFill(
    input: Omit<DropCopyFillWire, 'source'> & {
      readonly source?: DropCopyHitchSource;
      readonly order?: { readonly apiKeyId?: string | null };
    },
  ): Promise<void> {
    const source = input.source ?? (input.order !== undefined ? dropCopySourceForBookOrder(input.order) : null);
    if (source === null) return;
    await fireDropCopyFill(this.dropCopyIngest, {
      fillId: input.fillId,
      orderId: input.orderId,
      userId: input.userId,
      marketId: input.marketId,
      side: input.side,
      price: input.price,
      qty: input.qty,
      quoteAmount: input.quoteAmount,
      feeAsset: input.feeAsset,
      feeAmount: input.feeAmount,
      sequence: input.sequence,
      ts: input.ts,
      source,
    });
  }

  /** Best-effort payout after accrue; never throws. Fill already committed. */
  private async notifyAffiliatePayout(input: {
    fillId: string;
    makerUserId: string;
    takerUserId: string;
    makerFee: Amount;
    takerFee: Amount;
    makerFeeAsset: string;
    takerFeeAsset: string;
  }): Promise<void> {
    await fireAffiliatePayout(this.affiliatePayout, affiliateLegsAfterFill({ ...input, houseMmUserId: HOUSE_MM_USER_UUID }));
  }

  // ── Holds: the only two things that can happen to one ─────────────────────

  /** Unpublished owner schedule is a typed refuse — never listing-row 10/20. */
  private assertOwnerFeeSchedulePublished(): void {
    if (this.feeSchedule.published !== true) {
      throw new TradeError('published fee schedule is unavailable', 'trade.fee_schedule_blank');
    }
  }

  private ratesForFill(makerDiscountBps: number, takerDiscountBps: number) {
    try {
      return feeRatesForFill(this.feeSchedule, makerDiscountBps, takerDiscountBps);
    } catch (err) {
      if (err instanceof FeeScheduleError) {
        throw new TradeError(err.message, 'trade.fee_schedule_blank');
      }
      throw err;
    }
  }

  /**
   * Refuse a match whose fees leave a side with nothing — BEFORE fill rows.
   *
   * `tradeFill` already throws `InvalidEntryError` for this class, but it runs
   * after the insert. Re-running then re-throws forever while `remainingHold`
   * treats the unposted fill as consumed. Checking here keeps the fills table
   * from outrunning the ledger when the post cannot heal.
   */
  private assertFillFeesPostable(
    sequence: number,
    symbol: string,
    takerSide: 'buy' | 'sell',
    qty: Amount,
    quoteAmount: Amount,
    rates: { makerFeeBps: number; takerFeeBps: number },
  ): void {
    const pays = fillPayAmounts({ takerSide, qty, quoteAmount });
    if (
      fillReceivablesSurviveFees({
        ...pays,
        makerFeeBps: rates.makerFeeBps,
        takerFeeBps: rates.takerFeeBps,
      })
    ) {
      return;
    }
    throw new TradeError(
      `fill ${sequence} on ${symbol} would leave a side with nothing after fees ` +
        `(maker ${rates.makerFeeBps} bps / taker ${rates.takerFeeBps} bps) — refuse before recording the fill`,
      'trade.fee_exceeds_fill',
    );
  }

  /**
   * How much of an order's hold has NOT been spent by its fills or proven
   * native-amend qty-down releases.
   *
   * Derived, never stored as a running total. `hold_amount` is written once;
   * fills and `amend_released` are the only other inputs.
   */
  /**
   * Local fill proof for operator reconcile. Empty `trade.fills` plus
   * `filled_qty = 0` is the only "no fill" this service can prove. A lost
   * engine fill is indistinguishable from never-filled until a fill row lands;
   * when rows exist (or filled_qty disagrees), we refuse to pick a money winner.
   */
  private async fillEvidence(orderId: string): Promise<{ count: number; qty: Amount }> {
    const rows = await this.sql<Array<{ count: string; qty: string }>>`
      SELECT COUNT(*)::text AS count, COALESCE(SUM(qty), 0)::text AS qty
        FROM trade.fills
       WHERE order_id = ${orderId}
    `;
    const countRaw = rows[0]?.count ?? '0';
    if (!/^[0-9]+$/.test(countRaw)) {
      throw new TradeError(`trade.fills count for ${orderId} is not an integer`, 'trade.reconcile_unknown_engine_miss');
    }
    return { count: Number(countRaw), qty: parseAmount(rows[0]?.qty ?? '0') };
  }

  private async remainingHold(sql: Sql, order: OrderRecord): Promise<Amount> {
    // A buy consumed quote, a sell consumed base. Expressed as a CASE over a
    // bound parameter rather than a dynamic column name: the two are the same
    // query plan, and this one cannot be turned into an injection by a future
    // edit that forgets where `side` came from.
    const rows = await sql<Array<{ consumed: string }>>`
      SELECT COALESCE(SUM(CASE WHEN ${order.side === 'buy'} THEN quote_amount ELSE qty END), 0) AS consumed
        FROM trade.fills WHERE order_id = ${order.id}
    `;
    const consumed = parseAmount(rows[0]?.consumed ?? '0');
    const remaining = sub(sub(order.holdAmount, consumed), order.amendReleased);

    if (remaining < 0n) {
      // The fills say this order spent more than it was funded for. That is not
      // a rounding question: either the engine matched an order it should not
      // have, or a fill was recorded twice. Refuse to guess — releasing a
      // negative would draw down whatever else this user has in `hold`, which
      // is another order's money.
      throw new TradeError(
        `order ${order.id} consumed ${formatAmount(consumed)} against a ${formatAmount(order.holdAmount)} hold`,
        'trade.hold_uncovered',
      );
    }

    return remaining;
  }

  /**
   * Move an order to a terminal state and give back what is left of its hold.
   *
   * THE RELEASE HAPPENS BEFORE THE STATUS CHANGE, and that ordering is the
   * answer to "if this crashes exactly here, whose funds are stranded?".
   * Terminal status is what makes this method return early, so setting it first
   * and crashing before the release would strand the remainder behind a row
   * that says there is nothing to do. This way a crash leaves a non-terminal
   * row, a retry recomputes the same remainder, and the ledger's
   * `order.release:<orderId>:0` key makes the second post a no-op.
   *
   * ONE RELEASE PER ORDER, EVER — sequence 0, fixed. An order reaches a
   * terminal state exactly once, so the key never needs to vary, and a fixed
   * key is what makes a double-release impossible rather than merely unlikely.
   * This is the bug the "partial fill then cancel" test exists to catch: the
   * remainder is `hold - Σ fills`, so the filled part is never released and the
   * unfilled part is never released twice.
   */
  private async finalize(orderId: string, status: Extract<OrderStatus, 'cancelled' | 'filled' | 'expired' | 'rejected'>): Promise<void> {
    const outcome = await transaction(
      this.sql,
      async (tx): Promise<{ order: OrderRecord; status: OrderStatus } | null> => {
        const rows = await tx<OrderRow[]>`SELECT * FROM trade.orders WHERE id = ${orderId} FOR UPDATE`;
        const row = rows[0];
        if (!row) return null;

        const order = toOrder(row);
        if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required') return null;

        const remaining = await this.remainingHold(tx, order);
        if (remaining > 0n) {
          // ── 6 · THE RELEASE ────────────────────────────────────────────────
          await this.ledger.post(
            withLedgerAttribution(
              recipes.orderHoldRelease({
                orderId,
                userId: order.userId,
                assetId: order.holdAsset,
                amount: remaining,
                sequence: 0,
              }),
              attributionFromOrder(order),
            ),
          );
        }

        const finalStatus: OrderStatus = order.filledQty > 0n && order.filledQty >= order.qty ? 'filled' : status;
        await tx`UPDATE trade.orders SET status = ${finalStatus}, updated_at = now() WHERE id = ${orderId}`;

        return { order, status: finalStatus };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    // Published outside the transaction. An XP award is not money and must not
    // be able to roll back a release, nor hold a database transaction open
    // across a broker round trip.
    if (outcome) {
      const latest = (await this.findOrder(orderId)) ?? { ...outcome.order, status: outcome.status };
      await this.publishOrderUpdated({ ...latest, status: outcome.status });
      if (outcome.order.filledQty > 0n) await this.publishXp(outcome.order, outcome.status);
    }
  }

  /**
   * Persist an unresolved command without touching the ledger. The
   * reconciliation key is deterministic per order/reason, so restart/replay
   * and client retries all converge on one recovery case.
   */
  private async markRecoveryRequired(orderId: string, reason: RecoveryReason): Promise<void> {
    const reconciliationKey = `trade.order.reconcile:${orderId}:${reason}`;
    await this.sql`
      UPDATE trade.orders
         SET status = 'recovery_required',
             recovery_reason = ${reason},
             reconciliation_key = ${reconciliationKey},
             updated_at = now()
       WHERE id = ${orderId}
         AND status IN ('pending', 'open', 'recovery_required')
    `;
  }

  /** Close out an order that filled completely — no cancellation is emitted for one. */
  private async finalizeIfComplete(orderId: string): Promise<void> {
    const order = await this.findOrder(orderId);
    if (!order) return;
    if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required') return;
    if (order.filledQty < order.qty) return;
    await this.finalize(orderId, 'filled');
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * §5.2 step 4: "XP event emitted per filled order."
   *
   * Emitted once, at the terminal transition, keyed on the order id so a
   * redelivery cannot pay the same achievement twice. svc-identity is the only
   * writer of rank state (§4.1) — this service says what happened and has no
   * opinion about what it is worth.
   *
   * SOCKET §13 — volume-weighted XP and rolling fee tiers. §5.2 also asks for
   * "volume aggregates per user per window [to] feed rank + fee-tier". That is
   * a windowed aggregation job over `fills`, which needs a window table and a
   * schedule of its own; the fills it would read are all written here already.
   */
  private async publishXp(order: OrderRecord, status: OrderStatus): Promise<void> {
    await this.bus.publish(
      'xpEarned',
      {
        userId: order.userId,
        sourceModule: 'trade',
        action: status === 'filled' ? 'order.filled' : 'order.partially_filled',
        xpDelta: status === 'filled' ? 10 : 5,
        meta: { orderId: order.id, marketId: order.marketId },
      },
      { idempotencyKey: `trade.order.xp:${order.id}` },
    );
  }

  /**
   * Private order stream feed. Not a money path — the ledger already moved.
   * Keyed on (order, status, filledQty) so redelivery of the same snapshot is
   * a bus no-op while a fill that advances filledQty still ships.
   */
  private async publishOrderUpdated(order: OrderRecord): Promise<void> {
    // The v1 event catalog predates RECOVERY_REQUIRED. Never downgrade this
    // state to OPEN/REJECTED on the bus; REST projections carry the additive
    // recovery evidence until the catalog version is extended.
    if (order.status === 'recovery_required') return;
    await this.bus.publish(
      'orderUpdated',
      {
        orderId: order.id,
        userId: order.userId,
        marketId: order.marketId,
        status: order.status,
        side: order.side,
        type: order.type,
        qty: formatAmount(order.qty),
        filledQty: formatAmount(order.filledQty),
        price: order.price == null ? null : formatAmount(order.price),
        clientOrderId: order.clientOrderId,
        ts: new Date().toISOString(),
      },
      { idempotencyKey: `trade.order.updated:${order.id}:${order.status}:${formatAmount(order.filledQty)}` },
    );
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
    const market = await this.marketById(input.marketId);
    if (!market) throw new TradeError(`market ${input.marketId} not found`, 'trade.market_not_found');

    const taker = await this.findOrder(input.takerOrderId);
    if (!taker) throw new TradeError(`order ${input.takerOrderId} not found`, 'trade.order_not_found');

    // Prefer event payload; then orders table. House bookkeeping UUID → house STP id.
    // Never invent house MM from an unknown maker (empty + no house row).
    const makerRow = await this.findOrder(input.makerOrderId);
    const makerAccountId = recoverMatchingAccountId({
      eventAccountId: input.makerAccountId,
      orderUserId: makerRow?.userId,
    });
    const takerAccountId = recoverMatchingAccountId({
      eventAccountId: input.takerAccountId,
      orderUserId: taker.userId,
    });

    await withMoneySpan(
      'trade.settleFillEvent',
      { operation: 'settle_fill', marketId: input.marketId, symbol: market.symbol, qty: input.qty },
      async () => {
        await this.settleFill(market, {
          sequence: input.sequence,
          makerOrderId: input.makerOrderId,
          makerAccountId,
          takerOrderId: input.takerOrderId,
          takerAccountId,
          takerSide: taker.side,
          price: input.price,
          qty: input.qty,
        });
        await this.finalizeIfComplete(input.makerOrderId);
        await this.finalizeIfComplete(input.takerOrderId);
      },
    );
  }

  /**
   * Release the hold for an order the engine says has left the book.
   *
   * The other half of the recovery path. Idempotent: `finalize` returns
   * immediately for an order already in a terminal state, and the release key
   * is fixed per order, so a redelivered `order.cancelled` cannot release
   * twice.
   */
  async releaseOnCancelEvent(orderId: string): Promise<void> {
    await withMoneySpan('trade.releaseOnCancelEvent', { operation: 'release_hold', orderId }, async () => {
      await this.finalize(orderId, 'cancelled');
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getOrder(principal: Principal, orderId: string): Promise<OrderRecord> {
    requireScope(principal, 'trade:read');
    const order = await this.findOrder(orderId);
    if (!order || order.userId !== principal.userId) {
      throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
    }
    return order;
  }

  /**
   * Self open/pending/recovery rows. Limit is required — same inner door as
   * private REST orders/open and tRPC orders.open. Missing / non-integer / out
   * of 1..500 refuses (never invent 100). Owner/query may pass 100 explicitly.
   */
  async openOrders(principal: Principal, marketId: string | undefined, limit: number): Promise<OrderRecord[]> {
    requireScope(principal, 'trade:read');
    const capped = publishedOpenOrdersLimit(limit);
    const rows = marketId
      ? await this.sql<OrderRow[]>`
          SELECT * FROM trade.orders
           WHERE user_id = ${principal.userId} AND status IN ('pending', 'open', 'recovery_required') AND market_id = ${marketId}
           ORDER BY created_at DESC
           LIMIT ${capped}
        `
      : await this.sql<OrderRow[]>`
          SELECT * FROM trade.orders
           WHERE user_id = ${principal.userId} AND status IN ('pending', 'open', 'recovery_required')
           ORDER BY created_at DESC
           LIMIT ${capped}
        `;
    return rows.map(toOrder);
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
    requireScope(principal, 'admin:read');
    const capped = publishedAdminOpenOrdersLimit(limit);
    const rows = await this.sql<OrderRow[]>`
      SELECT * FROM trade.orders
       WHERE status IN ('pending', 'open', 'recovery_required')
       ORDER BY created_at DESC
       LIMIT ${capped}
    `;
    return rows.map(toOrder);
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
  async orderHistory(principal: Principal, input: { marketId?: string; limit: number; sinceMs?: number }): Promise<OrderRecord[]> {
    requireScope(principal, 'trade:read');
    const limit = publishedOrderHistoryLimit(input.limit);
    // timestamptz compare: Date carries ms precision into postgres.js.
    const sinceDate = input.sinceMs !== undefined ? new Date(input.sinceMs) : undefined;
    const rows =
      input.marketId && sinceDate
        ? await this.sql<OrderRow[]>`
            SELECT * FROM trade.orders
             WHERE user_id = ${principal.userId}
               AND market_id = ${input.marketId}
               AND status IN ('filled', 'cancelled', 'rejected', 'expired')
               AND created_at >= ${sinceDate}
             ORDER BY created_at DESC
             LIMIT ${limit}
          `
        : input.marketId
          ? await this.sql<OrderRow[]>`
              SELECT * FROM trade.orders
               WHERE user_id = ${principal.userId}
                 AND market_id = ${input.marketId}
                 AND status IN ('filled', 'cancelled', 'rejected', 'expired')
               ORDER BY created_at DESC
               LIMIT ${limit}
            `
          : sinceDate
            ? await this.sql<OrderRow[]>`
                SELECT * FROM trade.orders
                 WHERE user_id = ${principal.userId}
                   AND status IN ('filled', 'cancelled', 'rejected', 'expired')
                   AND created_at >= ${sinceDate}
                 ORDER BY created_at DESC
                 LIMIT ${limit}
              `
            : await this.sql<OrderRow[]>`
                SELECT * FROM trade.orders
                 WHERE user_id = ${principal.userId}
                   AND status IN ('filled', 'cancelled', 'rejected', 'expired')
                 ORDER BY created_at DESC
                 LIMIT ${limit}
              `;
    return rows.map(toOrder);
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
    requireScope(principal, 'trade:read');
    const capped = publishedFillsMineLimit(limit);
    const sinceDate = sinceMs !== undefined ? new Date(sinceMs) : undefined;
    const rows =
      marketId && sinceDate
        ? await this.sql<FillRow[]>`
            SELECT * FROM trade.fills
             WHERE user_id = ${principal.userId}
               AND market_id = ${marketId}
               AND ts >= ${sinceDate}
             ORDER BY ts DESC LIMIT ${capped}
          `
        : marketId
          ? await this.sql<FillRow[]>`
              SELECT * FROM trade.fills
               WHERE user_id = ${principal.userId} AND market_id = ${marketId}
               ORDER BY ts DESC LIMIT ${capped}
            `
          : sinceDate
            ? await this.sql<FillRow[]>`
                SELECT * FROM trade.fills
                 WHERE user_id = ${principal.userId}
                   AND ts >= ${sinceDate}
                 ORDER BY ts DESC LIMIT ${capped}
              `
            : await this.sql<FillRow[]>`
                SELECT * FROM trade.fills
                 WHERE user_id = ${principal.userId}
                 ORDER BY ts DESC LIMIT ${capped}
              `;
    return rows.map(toFill);
  }

  /**
   * Fills for one of the caller's orders, oldest first.
   * Limit is required — same 1..500 window as fills.mine / myFills
   * (`publishedFillsMineLimit`). Missing / non-integer / out of range refuses
   * (never invent 100). Owner/query may pass 500 explicitly.
   */
  async fillsForOrder(principal: Principal, orderId: string, limit: number): Promise<FillRecord[]> {
    requireScope(principal, 'trade:read');
    const capped = publishedFillsMineLimit(limit);
    const order = await this.findOrder(orderId);
    if (!order || order.userId !== principal.userId) {
      throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
    }
    const rows = await this.sql<FillRow[]>`
      SELECT * FROM trade.fills WHERE order_id = ${orderId} AND user_id = ${principal.userId} ORDER BY ts ASC LIMIT ${capped}
    `;
    return rows.map(toFill);
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
   * | orphan pending | `pending` + hold 0 | delete row (never held) |
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
    return withMoneySpan('trade.reconcileOrder', { operation: 'reconcile_order', orderId }, async () => {
      const order = await this.findOrder(orderId);
      if (!order) {
        return {
          orderId,
          case: 'not_found',
          action: 'none',
          holdBefore: '0',
          engineLive: null,
          detail: 'no order row',
        };
      }

      if (order.status !== 'pending' && order.status !== 'open' && order.status !== 'recovery_required') {
        return {
          orderId,
          case: 'terminal',
          action: 'none',
          holdBefore: '0',
          engineLive: null,
          detail: `status=${order.status}`,
        };
      }

      const holdBal = (await this.ledger.balance(orderHoldAccount(order.userId, order.holdAsset, order.id))).amount;
      const holdBefore = formatAmount(holdBal);

      // ── orphan pending: intent row, never funded ───────────────────────────
      if (order.status === 'pending' && holdBal === 0n) {
        await this.sql`DELETE FROM trade.orders WHERE id = ${orderId} AND status = 'pending'`;
        return {
          orderId,
          case: 'orphan_pending',
          action: 'deleted',
          holdBefore,
          engineLive: false,
          detail: 'pending row with no hold — deleted (fail-closed safe)',
        };
      }

      // Non-destructive liveness: list before any cancel.
      const listed = await this.matching.listOrders(order.marketId);
      const engineLive = listed.orders.some((o) => o.orderId === orderId);

      // Recovery is a lookup, not a blind resubmit. A live engine order stays
      // unresolved and encumbered. List miss still consults trade.fills before
      // any release — unknown fills are a named break, not a refund.
      if (order.status === 'recovery_required') {
        if (holdBal === 0n) {
          await this.finalize(orderId, 'cancelled');
          return {
            orderId,
            case: 'recovery_required_no_hold',
            action: 'fail_closed',
            holdBefore,
            engineLive,
            detail: engineLive
              ? 'recovery-required order is live but has no hold — cancelled free book risk; NO hold invented'
              : 'recovery-required order has no hold and is absent — terminalized; NO hold invented',
          };
        }
        if (engineLive) {
          return {
            orderId,
            case: 'recovery_required_live',
            action: 'none',
            holdBefore,
            engineLive: true,
            detail: `recovery-required (${order.recoveryReason ?? 'unknown'}) is live; hold retained pending engine outcome`,
          };
        }
        const recoveryFills = await this.fillEvidence(orderId);
        if (!fillsProveNoFill(order.filledQty, recoveryFills)) {
          return {
            orderId,
            case: 'open_hold_no_engine_unknown',
            action: 'fail_closed',
            holdBefore,
            engineLive: false,
            detail: `trade.reconcile_unknown_engine_miss: recovery-required (${order.recoveryReason ?? 'unknown'}) absent from engine; trade.fills count=${recoveryFills.count} qty=${formatAmount(recoveryFills.qty)} filled_qty=${formatAmount(order.filledQty)} — hold retained`,
          };
        }
        await this.finalize(orderId, 'cancelled');
        return {
          orderId,
          case: 'recovery_required_absent',
          action: 'released',
          holdBefore,
          engineLive: false,
          detail: `recovery-required (${order.recoveryReason ?? 'unknown'}) absent from engine; trade.fills prove empty; remainder released once`,
        };
      }

      // ── open (or pending-with-hold) + no ledger hold — FAIL CLOSED ────────
      // Spec: open+engine no hold. We treat any open/pending with zero hold as
      // fail-closed: never invent a hold. Cancel only if list says live (free book risk).
      if (holdBal === 0n) {
        if (engineLive) {
          await this.matching.cancel(order.marketId, orderId);
        }
        // Terminalize without release (remainder already 0). Do not invent money.
        await this.finalize(orderId, 'cancelled');
        return {
          orderId,
          case: 'open_engine_no_hold',
          action: 'fail_closed',
          holdBefore,
          engineLive,
          detail: engineLive
            ? 'open/pending with zero hold while engine list had the order — cancelled free book risk; NO hold invented'
            : 'open/pending with zero hold and engine list miss — terminalized; NO hold invented',
        };
      }

      // ── open+hold: list then cancel-if-live, or miss → consult fills ───────
      // Engine miss + hold is three shapes (never live / already gone / lost
      // fill). Order row + hold cannot tell them apart. `trade.fills` is the
      // only local proof of no fill. No fills table row and filled_qty 0 is
      // the existing cancel path. Anything else is unknown: refuse, no refund.
      if (engineLive) {
        await this.matching.cancel(order.marketId, orderId);
        await this.finalize(orderId, 'cancelled');
        return {
          orderId,
          case: 'open_hold_engine_cleared',
          action: 'released',
          holdBefore,
          engineLive: true,
          detail: 'open+hold; engine list live then cancelled; remainder released once',
        };
      }

      const fills = await this.fillEvidence(orderId);
      if (!fillsProveNoFill(order.filledQty, fills)) {
        return {
          orderId,
          case: 'open_hold_no_engine_unknown',
          action: 'fail_closed',
          holdBefore,
          engineLive: false,
          detail: `trade.reconcile_unknown_engine_miss: open+hold; engine list miss; trade.fills count=${fills.count} qty=${formatAmount(fills.qty)} filled_qty=${formatAmount(order.filledQty)} — hold retained, no refund`,
        };
      }

      await this.finalize(orderId, 'cancelled');
      return {
        orderId,
        case: 'open_hold_no_engine',
        action: 'released',
        holdBefore,
        engineLive: false,
        detail: 'open+hold; engine list miss; trade.fills prove empty; remainder released once',
      };
    });
  }

  async marketById(marketId: string): Promise<Market | null> {
    const rows = await this.sql<MarketRow[]>`
      SELECT id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
             min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
                asset_class, schedule, paper,
                futures_contract_style, futures_expiry_at, futures_settlement_fixing
        FROM trade.markets WHERE id = ${marketId}
    `;
    const row = rows[0];
    return row ? toMarket(row) : null;
  }

  async marketBySymbol(symbol: string): Promise<Market | null> {
    const rows = await this.sql<MarketRow[]>`
      SELECT id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
             min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
                asset_class, schedule, paper,
                futures_contract_style, futures_expiry_at, futures_settlement_fixing
        FROM trade.markets WHERE symbol = ${symbol}
    `;
    const row = rows[0];
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
    const capped = publishedPublicTapeLimit(limit);
    const sinceDate = sinceMs !== undefined ? new Date(sinceMs) : undefined;
    type TapeRow = {
      id: string;
      side: OrderSide;
      price: string;
      qty: string;
      quote_amount: string;
      sequence: number;
      ts: Date;
    };
    // SD-3: exclude prints involving any seeded order (seed volume is not "real activity").
    const rows = sinceDate
      ? await this.sql<TapeRow[]>`
          SELECT f.id, f.side, f.price, f.qty, f.quote_amount, f.sequence, f.ts
            FROM trade.fills f
            INNER JOIN trade.orders o ON o.id = f.order_id
            INNER JOIN trade.orders c ON c.id = f.counter_order_id
           WHERE f.market_id = ${marketId}
             AND f.liquidity = 'taker'
             AND f.ts >= ${sinceDate}
             AND o.seeded = false
             AND c.seeded = false
           ORDER BY f.sequence DESC
           LIMIT ${capped}
        `
      : await this.sql<TapeRow[]>`
          SELECT f.id, f.side, f.price, f.qty, f.quote_amount, f.sequence, f.ts
            FROM trade.fills f
            INNER JOIN trade.orders o ON o.id = f.order_id
            INNER JOIN trade.orders c ON c.id = f.counter_order_id
           WHERE f.market_id = ${marketId}
             AND f.liquidity = 'taker'
             AND o.seeded = false
             AND c.seeded = false
           ORDER BY f.sequence DESC
           LIMIT ${capped}
        `;
    return rows.map((row) => ({
      id: row.id,
      side: row.side,
      price: parseAmount(row.price),
      qty: parseAmount(row.qty),
      quoteAmount: parseAmount(row.quote_amount),
      sequence: row.sequence,
      ts: row.ts,
    }));
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
   */
  async candles(marketId: string, timeframe: Timeframe, limit: number, sinceMs?: number): Promise<Candle[]> {
    return queryCandlesFromFills(this.sql, { marketId, timeframe, limit, sinceMs });
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
    requireScope(principal, 'trade:write');
    if (!this.algoEnabled) {
      throw new TradeError('algo execution is disabled by the operator kill-switch', 'trade.algo_disabled');
    }
    if (!this.spotEnabled) {
      throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
    }
    const kind = (input.kind ?? 'twap').toLowerCase();
    if (kind !== 'twap' && kind !== 'vwap' && kind !== 'pov') {
      throw new TradeError(
        `algo kind "${kind}" is not available — v1 is TWAP / VWAP / POV (icebergs still out)`,
        'trade.algo_unsupported_kind',
      );
    }

    const market = await this.requireMarket(input);
    // TWAP is spot-only by name (see `assertSpotSurface`), not because
    // `assertTradable` happens to refuse the kind.
    assertSpotSurface(market, kind === 'twap' ? 'TWAP' : kind === 'vwap' ? 'VWAP' : 'POV');
    assertTradable(market);
    assertSettlementRails(market);
    assertMarketOpen(market, this.now());
    assertQty(market, input.totalQty);
    if (input.subAccountId) {
      await assertSubAccountOwned(this.subAccounts, principal.userId, input.subAccountId);
    }

    // Refuse at creation when mark feed is blank — never accept a schedule that cannot run.
    const depth = await this.matching.depth(market.id, 1);
    const bid = depth.bids[0] ? parseAmount(depth.bids[0][0]) : null;
    const ask = depth.asks[0] ? parseAmount(depth.asks[0][0]) : null;
    if (bid === null || ask === null) {
      throw new TradeError(
        `${market.symbol}: no two-sided mark at creation — refusing algo rather than inventing a feed`,
        'trade.algo_mark_missing',
      );
    }

    let createInput: CreateTwapInput = {
      marketId: market.id,
      symbol: market.symbol,
      side: input.side,
      totalQty: input.totalQty,
      durationMs: input.durationMs,
      sliceIntervalMs: input.sliceIntervalMs,
      limitPrice: input.limitPrice ?? null,
      subAccountId: input.subAccountId ?? null,
      clientAlgoId: input.clientAlgoId,
      kind,
    };

    if (kind === 'vwap') {
      const tf = timeframeForSliceInterval(input.sliceIntervalMs);
      if (tf == null) {
        throw new TradeError(
          'VWAP sliceIntervalMs must match a listed OHLCV timeframe (1m, 5m, 1h, …) — refuse rather than invent a finer volume bucket',
          'trade.algo_invalid_schedule',
        );
      }
      const n = sliceCount(input.durationMs, input.sliceIntervalMs);
      const nowMs = this.now().getTime();
      const windowEndMs = Math.floor(nowMs / input.sliceIntervalMs) * input.sliceIntervalMs;
      const candles = await queryCandlesFromFills(this.sql, {
        marketId: market.id,
        timeframe: tf,
        limit: n + 2,
        sinceMs: windowEndMs - n * input.sliceIntervalMs,
      });
      createInput = {
        ...createInput,
        volumeProfile: alignLookbackVolumes(candles, n, input.sliceIntervalMs, windowEndMs),
      };
    }

    if (kind === 'pov') {
      createInput = { ...createInput, participationBps: input.participationBps };
    }

    // A preview must not emit the store callback or expose an active parent
    // before its durable owner admission. Children are separate decisions.
    const { parent, plan } = this.algo.prepare(principal.userId, createInput, market.lotSize);
    await this.admitAccountOperation(
      principal,
      'strategy.start',
      `algo:${parent.id}`,
      businessPayload({ request: input, parent, plan, grant: captureAlgoPlaceGrant(principal) }),
      undefined,
      input.subAccountId,
    );
    await this.algoStore.save({ parent, plan, grant: captureAlgoPlaceGrant(principal) });
    this.algoPrincipals.set(principal.userId, principal);
    this.algo.hydrate(parent, plan);
    return parent;
  }

  async getAlgo(principal: Principal, parentId: string): Promise<TwapParent> {
    requireScope(principal, 'trade:read');
    return hydrateAlgoIfMissing(this.algo, this.algoStore, principal.userId, parentId);
  }

  /** Owner recovery restores only the immutable admitted proposal. Each child
   * still needs a fresh identity decision and local trading admission. */
  async recoverAdmittedAlgo(userId: string, parentId: string): Promise<TwapParent | null> {
    const existing = await this.algoStore.load(parentId);
    if (existing) return existing.parent.userId === userId ? existing.parent : null;
    if (!this.accountAdmission) throw new TradingControlError('authority.unavailable');
    const original = await this.accountAdmission.resolve(userId, `algo:${parentId}`);
    if (!original) return null;
    const wire = original.payload as { parent: Record<string, unknown>; plan: string[]; grant: unknown };
    if (
      wire.parent?.id !== parentId ||
      wire.parent.userId !== userId ||
      !Array.isArray(wire.plan) ||
      !Array.isArray(wire.parent.children) ||
      wire.parent.children.length !== 0 ||
      !Array.isArray(wire.parent.misses) ||
      wire.parent.misses.length !== 0
    )
      throw new TradingControlError('operation.conflict');
    const parent = {
      ...wire.parent,
      totalQty: parseAmount(String(wire.parent.totalQty)),
      limitPrice: wire.parent.limitPrice == null ? null : parseAmount(String(wire.parent.limitPrice)),
      lotSize: wire.parent.lotSize == null ? null : parseAmount(String(wire.parent.lotSize)),
      createdAt: new Date(String(wire.parent.createdAt)),
      startedAt: new Date(String(wire.parent.startedAt)),
      nextDueAt: new Date(String(wire.parent.nextDueAt)),
      projectedEndsAt: new Date(String(wire.parent.projectedEndsAt)),
      pausedAt: null,
      children: [],
      misses: [],
    } as unknown as TwapParent;
    const record = { parent, plan: wire.plan.map(parseAmount), grant: parseAlgoPlaceGrant(wire.grant) };
    // Recovery must never rewind a parent that another worker already advanced.
    await this.algoStore.save(record, true);
    const saved = await this.algoStore.load(parentId);
    if (!saved || saved.parent.userId !== userId) throw new TradingControlError('operation.conflict');
    this.algo.hydrate(saved.parent, saved.plan);
    this.installAlgoPlaceGrant(saved);
    return saved.parent;
  }

  async algoProgress(principal: Principal, parentId: string): Promise<AlgoProgressView> {
    const parent = await this.getAlgo(principal, parentId);
    let filled = 0n;
    for (const child of parent.children) {
      const fills = await this.fillsForOrder(principal, child.orderId, FILLS_MINE_LIMIT_MAX);
      for (const f of fills) filled += f.qty;
    }
    return presentAlgoProgress(parent, filled);
  }

  async pauseAlgo(principal: Principal, parentId: string): Promise<TwapParent> {
    requireScope(principal, 'trade:write');
    await hydrateAlgoIfMissing(this.algo, this.algoStore, principal.userId, parentId);
    return persistAlgoMutation(this.algo, this.algoStore, this.algo.pause(principal.userId, parentId));
  }

  async resumeAlgo(principal: Principal, parentId: string): Promise<TwapParent> {
    requireScope(principal, 'trade:write');
    const parent = await hydrateAlgoIfMissing(this.algo, this.algoStore, principal.userId, parentId);
    await this.admitAccountOperation(
      principal,
      'strategy.start',
      `algo.resume:${orderIdFor(principal.userId, parent.id, `${parent.nextSliceIndex}:${parent.pausedAt?.toISOString() ?? 'none'}`)}`,
      businessPayload({ parentId, nextSliceIndex: parent.nextSliceIndex, pausedAt: parent.pausedAt }),
    );
    return persistAlgoMutation(this.algo, this.algoStore, this.algo.resume(principal.userId, parentId));
  }

  async cancelAlgo(principal: Principal, parentId: string): Promise<TwapParent> {
    requireScope(principal, 'trade:write');
    // Install the live caller's principal BEFORE engine.cancel so cancelChild
    // can cancel open children after a process restart. Place still refuses
    // without a durable principal grant (SOCKET §13) — cancel is different:
    // the user is presenting authority right now.
    this.algoPrincipals.set(principal.userId, principal);
    await hydrateAlgoIfMissing(this.algo, this.algoStore, principal.userId, parentId);
    return persistAlgoCancelAttempt(this.algo, this.algoStore, principal.userId, parentId);
  }

  /** Drive one parent's next due slice (job host / tests). */
  async tickAlgo(parentId: string) {
    await hydrateAlgoFromStore(this.algo, this.algoStore, parentId);
    const loaded = await this.algoStore.load(parentId);
    if (loaded) this.installAlgoPlaceGrant(loaded);
    const result = await this.algo.tick(parentId);
    const live = this.algo.get(parentId);
    if (live) await persistAlgoMutation(this.algo, this.algoStore, live);
    return result;
  }

  /** Drive all active algos once. Hydrates durable active parents first. */
  async tickAllAlgos() {
    const active = await this.algoStore.listActive();
    for (const rec of active) {
      if (!this.algo.get(rec.parent.id)) {
        this.algo.hydrate(rec.parent, rec.plan);
      }
      this.installAlgoPlaceGrant(rec);
    }
    await this.algo.tickAll();
    for (const rec of active) {
      const live = this.algo.get(rec.parent.id);
      if (live) await persistAlgoMutation(this.algo, this.algoStore, live);
    }
  }

  /**
   * Reinstall the createTwap place grant after restart. Missing/expired grant
   * leaves the in-memory map empty so placeChild still halts.
   */
  private installAlgoPlaceGrant(record: TwapParentRecord): void {
    if (!record.grant) return;
    try {
      const restored = principalFromAlgoGrant({
        userId: record.parent.userId,
        grant: record.grant,
        expiresAt: record.parent.projectedEndsAt,
        now: this.now(),
      });
      this.algoPrincipals.set(restored.userId, restored);
    } catch {
      this.algoPrincipals.delete(record.parent.userId);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async requireMarket(input: { symbol?: string; marketId?: string }): Promise<Market> {
    const market = input.marketId ? await this.marketById(input.marketId) : input.symbol ? await this.marketBySymbol(input.symbol) : null;
    if (!market) throw new TradeError(`market ${input.symbol ?? input.marketId ?? '(unspecified)'} not found`, 'trade.market_not_found');
    return market;
  }

  private async bestAsk(marketId: string): Promise<Amount | null> {
    const depth = await this.matching.depth(marketId, 1);
    const best = depth.asks[0];
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

  private async refreshFilledQty(orderId: string): Promise<void> {
    await this.sql`
      UPDATE trade.orders o
         SET filled_qty = COALESCE((SELECT SUM(f.qty) FROM trade.fills f WHERE f.order_id = o.id), 0),
             updated_at = now()
       WHERE o.id = ${orderId}
    `;
  }
}

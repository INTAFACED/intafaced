/**
 * Futures position open/close + positionUpdated fan-out (trade.futures F3–F4).
 *
 * STATE in trade.positions; MARGIN only via ledger recipes (Doctrine §0.6).
 * Publishes `positionUpdated` so svc-ws private positions channel is not silent
 * after real opens.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO PRICE IN THIS FILE COMES FROM THE CALLER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `docs/adr/2026-08-05-futures-risk-and-mark-law.md`: **a price that moves money
 * is never supplied by the party it pays.**
 *
 * `open()` used to take `entryPrice` and `close()` used to take `exitPrice`,
 * both straight off the request. Entry price sizes the margin lock; exit price
 * is the entire realised PnL. A caller who named their own exit price named
 * their own profit, and `futuresRealizeProfit` paid it out of a house pot. The
 * service was careful everywhere else — `funding-tick.ts` tells its own oracle
 * "implementations MUST NOT invent a placeholder rate" — but the guard was on
 * the source and not on the caller, and a rule that stops the engine inventing a
 * price while the API accepts one from whoever is being paid protects nothing.
 *
 * Both prices now come from the injected `MarkSource`, which reads the venue
 * fabric or the matching book. Neither is anything a request body can set, and
 * both arrive labelled so `mark-policy.ts` can refuse them.
 *
 * The refusal shape matters as much as the source: a request that carries a
 * price is REFUSED at the REST edge rather than silently re-priced, so a caller
 * learns instead of getting different behaviour than they asked for.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { TradingControlError, canonicalPayload, type TradingAdmissionPort } from '../controls/trading-controls.js';
import { businessPayload } from '../controls/business-payload.js';
import { positionIdFor } from './ids.js';
import {
  div,
  formatAmount,
  futuresOrderMarginAccount,
  parseAmount,
  positionCollateralAccount,
  recipes,
  userAvailable,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { Position } from '@intafaced/exchange-contract';
import type { EventBus } from '@intafaced/events';
import { checkLeverage, initialMargin, LEVERAGE_CAP_UNSET } from './initial-margin.js';
import { checkCollateralClassForMargin, checkMarginModeForFuturesOpen } from './margin-mode.js';
import { planClose } from './close-planner.js';
import type { DerivativesAccessGate } from './derivatives-access.js';
import { planLiquidation, unrealizedPnl } from './liquidation-planner.js';
import { defaultLiquidationId, type DepthNotionalSource, type MarkRequest, type MarkSource } from './liquidation-tick.js';
import { DEPTH_UNKNOWN, FuturesLadderError, planLadderRung, type FuturesLadderPolicy } from './maintenance-ladder.js';
import { tierCrossing, type RiskTierCrossing } from './risk-tier-confirm.js';
import {
  openInterestRefusal,
  openInterestRoom,
  openInterestUnsetRefusal,
  type OpenInterestLimits,
  type OpenInterestRoom,
} from './open-interest-limits.js';
import { liquidationPriceFor } from './liquidation-price.js';
import {
  DEFAULT_FUTURES_MARK_POLICY,
  acceptableForEntry,
  acceptableForLiquidation,
  acceptableForMarking,
  markMissing,
  type FuturesQuotedMark,
  type MarkPolicy,
} from './mark-policy.js';
import { PROFIT_SOURCE_UNCONFIGURED, type ProfitSource } from './profit-source.js';
import { payOrOweProfit, profitLegOf } from './futures-payouts.js';
import { INSURANCE_UNDERFUNDED, checkInsuranceBound } from './insurance-bound.js';
import { breakerBasis, readAcceptedMark, type PreviousMark } from './accepted-mark.js';
import { TradeError } from '../spot/types.js';
import { PRETRADE_LIMIT_HTTP_STATUS, checkOpenAdmission } from './pretrade-limits.js';
import { assertDatedFuturesTradable } from './dated-futures.js';
import {
  COLLATERAL_UNREADABLE,
  HAIRCUT_CREDIT_SHORT,
  HAIRCUT_UNSET,
  collateralCredit,
  decideOpenCredit,
  readOwnerHaircutBps,
  requireOwnerHaircutBps,
} from './haircut-credit.js';
import { checkCloseQuantity, planProportionalClose } from './desk-quantity.js';
import { summarizeMargin, type MarginSummary } from './margin-summary.js';
import { readTradePlanes } from './plane-capabilities.js';
import { assertEmailProved, type EmailProofSource } from '../spot/email-proof.js';
import { decideModeWrite, presentAccountMode, type AccountModeRead, type StoredAccountMode } from './account-mode.js';
import { holdOf, MatchedFuturesOrders, type MatchedFillEvent, type OrderRow, type PlaceMatchedOrderInput } from './matched-orders.js';
import type { FeeRates } from './matched-order-plan.js';
import type { MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';

/**
 * How long one close waits for another close of the SAME position.
 *
 * `close()` holds a row lock across a mark read and the ledger posts, which is
 * the point of it — but an unbounded wait would let one wedged ledger call pin
 * a pooled connection per queued attempt and starve every other request in the
 * service. Three seconds is far longer than an honest close and short enough
 * that a pile-up drains instead of accumulating. Timing out is not the lock
 * failing, it is the lock working: the answer is "somebody is closing this
 * right now", and that is true.
 */
const CLOSE_LOCK_TIMEOUT_MS = 3_000;

/** Postgres `lock_timeout` expiry. Anything else from the driver is a real error. */
const PG_LOCK_NOT_AVAILABLE = '55P03';

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === PG_LOCK_NOT_AVAILABLE;
}

/** Same truthy set as env.ts. Unset, blank, and "false" stay off. */
function publishedFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false;
  return ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
}

/**
 * THE IDEMPOTENCY ROOT OF A VOLUNTARY CLOSE.
 *
 * One position closes once, so the key is the position and nothing else — no
 * clock, no random tail. `close-planner.ts` derives `:profit` and `:loss` from
 * it, `futuresMarginRelease` already keys on `positionId:sequence`, and the
 * result is that a close is a single settlement the ledger can recognise on
 * sight however many times it is asked to perform it.
 *
 * Exported because a test that asserts "paid once" should be able to name the
 * key it means, rather than re-deriving the format and drifting from it.
 */
export function closeIdFor(positionId: string): string {
  return `close:${positionId}`;
}

export class FuturesError extends Error {
  readonly rung?: 'closing' | 'partial';
  readonly addMarginAllowed?: boolean;

  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    extra?: { readonly rung?: 'closing' | 'partial'; readonly addMarginAllowed?: boolean },
  ) {
    super(message);
    this.name = 'FuturesError';
    this.rung = extra?.rung;
    this.addMarginAllowed = extra?.addMarginAllowed;
  }
}

export interface OpenPositionInput {
  userId: string;
  /** Market symbol, e.g. BTC/USDT-PERP — must be kind=futures and active. */
  symbol: string;
  side: 'long' | 'short';
  size: Amount;
  leverage: Amount;
  /**
   * Isolated only. `DIRECTION` §1, and the futures ADR's done bar item 8: *no
   * cross-margin path exists, even disabled*. `'cross'` is not a value this
   * type admits — the REST edge refuses it, and `open()` refuses it again for
   * callers TypeScript is not watching.
   */
  marginMode?: 'isolated';
  /**
   * Posted IM class. Omitted → cash (settled available quote). Yield-bearing,
   * staked, or lending-idle refuse — they are a separate product (PTX-M08-R11).
   */
  collateralClass?: string;
  /**
   * Caller-supplied open intent key (required). Position id and margin lock key
   * are derived from (user, market, clientOpenId) the same way spot derives
   * order ids from clientOrderId. A timeout + retry finds the original open
   * instead of locking a second pot under a random id.
   */
  clientOpenId: string;
  /**
   * When true, the open may only shrink an opposite position. Opening or
   * enlarging refuses `trade.reduce_only_would_increase`. Resting orders are
   * a different door.
   */
  reduceOnly?: boolean;
  /** Forwarded by the account-mode door. The open mill reads it; a direct caller may omit it. */
  positionMode?: 'one_way' | 'hedge';
}

export interface SetLeverageInput {
  userId: string;
  /** Market symbol — must match the open isolated position. */
  symbol: string;
  leverage: Amount;
  /** When omitted, the unique open position on `symbol` is used. */
  positionId?: string;
  /** Durable caller idempotency key. Mandatory at the REST boundary. */
  clientAdjustmentId?: string;
}

export interface AddIsolatedMarginInput {
  userId: string;
  /** Market symbol — must match the open isolated position. */
  symbol: string;
  /** Extra isolated collateral. Decimal string on the wire; scaled bigint here. */
  amount: Amount;
  /** When omitted, the unique open position on `symbol` is used. */
  positionId?: string;
  /** Durable caller idempotency key. Mandatory at the REST boundary. */
  clientAdjustmentId?: string;
  /** Posted IM class. Omitted → cash. Yield/staked/lending-idle refuse. */
  collateralClass?: string;
}

export type ReduceIsolatedMarginInput = AddIsolatedMarginInput;

/** New isolated IM would leave equity ≤ 0 at the current mark. */
export const LEVERAGE_WOULD_LIQUIDATE = 'trade.leverage_would_liquidate';
/** Decreasing leverage needs a lock the available balance cannot fund. */
export const LEVERAGE_INSUFFICIENT_MARGIN = 'trade.insufficient_margin';
/** Isolated reduce would pull collateral below initial margin. */
export const MARGIN_BELOW_INITIAL = 'trade.margin_below_initial';
/** Isolated reduce would leave equity ≤ 0 at the current mark. */
export const MARGIN_WOULD_LIQUIDATE = 'trade.margin_would_liquidate';
/** An open whose row failed was rolled back and its margin released; the same clientOpenId cannot be replayed. */
export const OPEN_ROLLED_BACK = 'trade.open_rolled_back';
/** A previous ledger-backed adjustment must finish before a different one starts. */
export const MARGIN_ADJUSTMENT_IN_PROGRESS = 'trade.margin_adjustment_in_progress';
/** A margin outflow or leverage change refused while reduce-only orders on the position may still fill. */
export const FUTURES_REDUCE_ORDERS_RESTING = 'trade.futures_reduce_orders_resting';
/**
 * A liquidation rung is live (planned or posted) on this position: its loss is booked or
 * about to be, and the row has not caught up. Refused with 409, retryable once the rung
 * has applied (a tick, normally). See `assertLiquidationHold`.
 */
export const LIQUIDATION_IN_PROGRESS = 'trade.liquidation_in_progress';
/**
 * The position is PARKED: its latest liquidation rung was abandoned (loss booked, row not
 * reconciled) or an old-style claim row exists. An operator must reconcile it first
 * (`docs/runbooks/liquidation-rung-ops.md` section 2). Only adding margin is allowed.
 */
export const POSITION_UNDER_REVIEW = 'trade.position_under_review';

/** Blank / non-integer / out of 1..500 listClosed limit refuse. Never invent 100. */
export const TRADE_LIST_CLOSED_LIMIT_UNSET = 'trade.list_closed_limit_unset' as const;
export const LIST_CLOSED_LIMIT_MAX = 500;

export class ListClosedLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_LIST_CLOSED_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'ListClosedLimitUnsetError';
  }
}

/** Owner-published closed-positions window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedListClosedLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > LIST_CLOSED_LIMIT_MAX) {
    throw new ListClosedLimitUnsetError('listClosed limit is unset — refuse to invent 100', TRADE_LIST_CLOSED_LIMIT_UNSET);
  }
  return value;
}

export interface PositionServiceDeps {
  accountAdmission?: TradingAdmissionPort;
  /** Identity email-proof read (RC-identity-01). Unset refuses every new position `trade.identity_unavailable`. */
  emailProof?: EmailProofSource;
  /**
   * Where prices come from. Required, and required to be a port the caller
   * cannot reach: making this optional would put the old defect one missing
   * argument away.
   */
  marks: MarkSource;
  /**
   * The account realised profit is paid from, and the ceiling on it.
   *
   * `null` when the owner has not named one. That is a deliberate inhabitant
   * rather than an oversight: this used to be mandatory and enforced by
   * throwing at module scope in `index.ts`, which meant an unmade decision
   * about a futures pot crash-looped spot, ticker, orderbook, balances and the
   * websocket feeds too. Futures is one feature; a missing futures decision
   * disables FUTURES.
   *
   * With `null`, `open()` refuses outright and `close()` refuses any close that
   * would realise a PROFIT — losing and flat closes still work, because a
   * control that traps a trader in a position is not a safety control. Nothing
   * is ever paid from an account nobody chose, which is the whole of the ADR's
   * requirement.
   */
  profitSource: ProfitSource | null;
  /** Optional: tests may omit; production passes JetStream bus. */
  bus?: EventBus | null;
  markPolicy?: MarkPolicy;
  /**
   * THE LEVERAGE CEILING FOR THIS DEPLOYMENT.
   *
   * Null/omitted means the owner/listing did not name a cap: opens and live
   * re-leverage refuse before ledger mutation. No production default exists.
   */
  maxLeverage?: Amount | null;
  now?: () => Date;
  /**
   * D-account-07 — the identity level derivatives need. When set (production always sets it), a non-reduce `open()`
   * refuses while the caller's verification tier is below the published rule's. A reduce-only open and every close
   * never call it. Omitted only in hermetic tests that are not proving the gate.
   */
  assertDerivativesAccess?: DerivativesAccessGate;
  /** Test-only crash seam after the external ledger accepts, before DB finalize. */
  afterMarginLedgerPost?: (request: string) => Promise<void>;
  /**
   * The published liquidation ladder (the same `depth` source and `policy` the liquidation
   * tick uses). When `policy` is set, the "would this be liquidatable" gate on a margin
   * outflow (`reduceIsolatedMargin`, `setLeverage`) uses the ladder's depth-tiered
   * maintenance, so a withdrawal cannot leave a position the ladder would liquidate on the
   * next tick. Omitted, or `policy` unset (production today: owner D3 numbers are unset):
   * the equity-only gate (`planLiquidation`, equity <= 0) applies, as before.
   */
  ladder?: { depth: DepthNotionalSource; policy?: FuturesLadderPolicy };
  /**
   * Futures orders through svc-matching (futures ADR slice 6). Absent or `enabled: false` refuses NEW matched
   * orders; settling a fill already matched, and releasing a hold, run regardless. The band is the owner's
   * number and stays null until it is named.
   */
  matchedOrders?: {
    matching: MatchingClient | null;
    enabled: boolean;
    priceBand: Amount | null;
    /** The band a new order is held to now, under the operator's dynamic range (D-instruments-08); absent is the static band. */
    priceBandFor?: (marketId: string) => Promise<Amount>;
    lifecycleProof: ((marketId: string) => Promise<LifecycleAdmissionProof>) | null;
    /** The perpetual rates an account pays now (owner schedule less rank discount). Absent refuses opening orders. */
    feeRates?: ((userId: string) => Promise<FeeRates>) | null;
    /** A market open's slippage cap in bps (operator per market, else the owner's); null refuses market opens. */
    slippageCapBps?: (marketId: string) => Promise<number | null>;
    /** The operator's open-interest limits for a market (D-margin-05); null when either is blank, which refuses opens. */
    openInterestLimits?: (marketId: string) => Promise<OpenInterestLimits | null>;
  };
}

/** Why a position is frozen waiting for a mark — futures-namespaced refuse codes. */
export type ClosingReason = 'trade.mark_missing' | 'trade.mark_unusable';

export interface PositionRow {
  id: string;
  user_id: string;
  market_id: string;
  side: 'long' | 'short';
  /**
   * `closing` = trader asked to leave while the feed was dark
   * (`docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`).
   */
  status: 'open' | 'closing' | 'closed' | 'liquidated';
  margin_mode: 'cross' | 'isolated';
  size: string;
  entry_price: string;
  /** Null on a legacy row that never recorded one. Never inferred from margin. */
  leverage: string | null;
  client_open_id: string | null;
  margin_initial: string;
  /** Residual after funding; close/liq release from this, not margin_initial. */
  margin_current: string;
  margin_asset: string;
  funding_paid: string;
  liq_price: string | null;
  opened_at: Date;
  closed_at: Date | null;
  symbol: string;
  /**
   * The last mark this position was accepted against — the deviation breaker's
   * basis, written by this service and reachable by nobody else. NULL only for
   * rows written before `0007_position_accepted_mark.sql`; `open()` fills it in
   * with the entry mark from the moment a position exists.
   */
  accepted_mark: string | null;
  accepted_mark_at: Date | null;
  /** Non-null only while status=closing. */
  closing_reason: string | null;
  /** Present on every `p.*` read. Null only if a writer omitted it. */
  updated_at: Date | null;
  /** From the joined market. Null where that row recorded no contract size. */
  contract_size: string | null;
  /** Last posted futuresMarginAdd/Release sequence; close residual uses 1. */
  margin_adjust_seq: number;
  margin_adjust_request: string | null;
}

/** What a presenter already knows. Omitted mark means this call did not read one. */
interface PresentExtras {
  markPrice?: string | null;
  markReason?: 'mark_missing' | 'mark_unusable' | 'mark_not_read' | null;
  realizedPnl?: string | null;
  /** A closed matched position: the summed quantity of its applied reduce fills. */
  closedSize?: string | null;
  /** The fees the position's fills through the book paid; null when it has none. Omitted when not read. */
  fees?: string | null;
  maintenanceMargin?: string | null;
  maintenanceReason?: string | null;
  /** The ladder's liquidation price at today's depth (`liquidation-price.ts`); shown only, never stored. */
  liquidationPrice?: string | null;
  liquidationReason?: string | null;
  replayed?: boolean;
}

/**
 * Unrealised PnL over initial margin, in CCXT percent points.
 *
 * `div(unrealized * 100n, initialMargin, half-up)`. Amounts are 1e18-scaled
 * bigints, so multiplying the scaled PnL by the plain integer `100n` is exact.
 * Rounding is `half-up` (`div` in `@intafaced/ledger-client`): a percent, not a
 * fee, so neither side is favoured by a one-sided ceil or floor. The PnL
 * itself is `unrealizedPnl` from `liquidation-planner`, the same truncation
 * toward zero that `planClose` posts. `'20'` means +20%.
 */
export const POSITION_PERCENTAGE_ROUNDING = 'half-up' as const;

export function positionPercentage(unrealized: Amount, initialMarginAmount: Amount): Amount {
  return div(unrealized * 100n, initialMarginAmount, POSITION_PERCENTAGE_ROUNDING);
}

export class PositionService {
  private readonly bus: EventBus | null;
  private readonly markPolicy: MarkPolicy;
  private readonly maxLeverage: Amount | null;
  private readonly afterMarginLedgerPost: ((request: string) => Promise<void>) | null;
  private readonly now: () => Date;
  private readonly matched: MatchedFuturesOrders;
  private readonly openInterestLimits: ((marketId: string) => Promise<OpenInterestLimits | null>) | null;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly deps: PositionServiceDeps,
  ) {
    this.bus = deps.bus ?? null;
    this.markPolicy = deps.markPolicy ?? DEFAULT_FUTURES_MARK_POLICY;
    this.maxLeverage = deps.maxLeverage ?? null;
    this.afterMarginLedgerPost = deps.afterMarginLedgerPost ?? null;
    this.now = deps.now ?? (() => new Date());
    const matchedOrders = deps.matchedOrders;
    this.openInterestLimits = matchedOrders?.openInterestLimits ?? null;
    this.matched = new MatchedFuturesOrders({
      sql,
      ledger,
      matching: matchedOrders?.matching ?? null,
      enabled: matchedOrders?.enabled ?? false,
      priceBand: matchedOrders?.priceBand ?? null,
      ...(matchedOrders?.priceBandFor ? { priceBandFor: matchedOrders.priceBandFor } : {}),
      maxLeverage: this.maxLeverage,
      now: this.now,
      markFor: async (marketId, symbol, at, size) => (await this.markFor(marketId, symbol, at, size)).price,
      assertPositionIdle: (positionId) => this.sql.begin((tx) => this.assertLiquidationHold(tx, positionId, 'close')),
      lifecycleProof: matchedOrders?.lifecycleProof ?? null,
      assertDerivativesAccess: deps.assertDerivativesAccess ?? null,
      ...(deps.emailProof ? { emailProof: deps.emailProof } : {}),
      // An opening order takes on exposure the same way the at-mark open did, so it answers to the same exposure door.
      assertOpeningAllowed: async () => {
        this.refuseNewPosition();
      },
      admission: deps.accountAdmission,
      publishPosition: (positionId) => this.publishPositionById(positionId),
      feeRates: matchedOrders?.feeRates ?? null,
      ...(matchedOrders?.slippageCapBps ? { slippageCapBps: matchedOrders.slippageCapBps } : {}),
      assertCollateralCredit: (input) => this.assertMatchedCollateralCredit(input),
      ...(deps.ladder ? { riskTier: (input) => this.riskTierCrossing(input) } : {}),
      ...(matchedOrders?.openInterestLimits ? { openInterest: (input) => this.openInterestRoom(input) } : {}),
    });
  }

  /**
   * The open-interest room this account has on a market (`open-interest-limits.ts`): what every open (or closing)
   * position and live opening order commits on the market, and on this account, against the operator's two limits. Either limit blank
   * refuses `trade.oi_limit_unset`; unwired (tests that build the service by hand) refuses the same way.
   */
  async openInterestRoom(input: {
    userId: string;
    marketId: string;
    symbol: string;
    lotSize: Amount | null;
    /** The order being checked once its own row is written: left out, since it is the order being sized. */
    excludeOrderId?: string;
  }): Promise<OpenInterestRoom> {
    const limits = this.openInterestLimits ? await this.openInterestLimits(input.marketId) : null;
    if (!limits) {
      const unset = openInterestUnsetRefusal(input.symbol);
      throw new FuturesError(unset.message, unset.code, unset.status);
    }
    const exclude = input.excludeOrderId ? this.sql`AND id <> ${input.excludeOrderId}` : this.sql``;
    const [row] = await this.sql<
      { market_positions: string | null; market_orders: string | null; account_positions: string | null; account_orders: string | null }[]
    >`
      SELECT
        (SELECT sum(size) FROM trade.positions
          WHERE market_id = ${input.marketId} AND status IN ('open', 'closing'))::text AS market_positions,
        (SELECT sum(qty - filled_qty) FROM trade.futures_orders
          WHERE market_id = ${input.marketId} AND NOT reduce_only
            AND status IN ('pending', 'held', 'submitting', 'open', 'submit_unknown') ${exclude})::text AS market_orders,
        (SELECT sum(size) FROM trade.positions
          WHERE market_id = ${input.marketId} AND user_id = ${input.userId} AND status IN ('open', 'closing'))::text AS account_positions,
        (SELECT sum(qty - filled_qty) FROM trade.futures_orders
          WHERE market_id = ${input.marketId} AND user_id = ${input.userId} AND NOT reduce_only
            AND status IN ('pending', 'held', 'submitting', 'open', 'submit_unknown') ${exclude})::text AS account_orders
    `;
    const sum = (a: string | null | undefined, b: string | null | undefined): Amount =>
      (parseAmount(a ?? '0') + parseAmount(b ?? '0')) as Amount;
    return openInterestRoom({
      limits,
      marketCommitted: sum(row?.market_positions, row?.market_orders),
      accountCommitted: sum(row?.account_positions, row?.account_orders),
      lotSize: input.lotSize,
    });
  }

  /**
   * The margin tier a side's exposure sits in now and would sit in with `qty` more (`risk-tier-confirm.ts`), rated at
   * `mark` against the depth the liquidation tick reads. Exposure is the open position's size plus what the side's
   * live opening orders can still fill, since those fill into the same position. An unset ladder refuses
   * `trade.ladder_unset` and an unreadable depth `trade.depth_unknown`: with either, no tier can be named.
   */
  async riskTierCrossing(input: {
    userId: string;
    marketId: string;
    symbol: string;
    side: 'long' | 'short';
    qty: Amount;
    mark: Amount;
    /** The order being rated once its own row is written: left out of the exposure, since `qty` is that order. */
    excludeOrderId?: string;
    /** The depth an earlier rating in the same request read; absent reads it now. */
    depthNotional?: Amount;
  }): Promise<RiskTierCrossing> {
    const ladder = this.deps.ladder;
    if (!ladder?.policy) {
      throw new FuturesError(
        'the owner has not published the maintenance tiers, so no margin tier can be named',
        'trade.ladder_unset',
        503,
      );
    }
    let depthNotional: Amount | null = input.depthNotional ?? null;
    if (depthNotional === null) {
      try {
        depthNotional = await ladder.depth.depthNotional({ marketId: input.marketId, side: input.side, symbol: input.symbol });
      } catch {
        depthNotional = null;
      }
    }
    if (depthNotional == null || depthNotional <= 0n) {
      throw new FuturesError('the book depth the margin tiers are rated against is unreadable — nothing was held', DEPTH_UNKNOWN, 503);
    }
    const bookSide = input.side === 'long' ? 'buy' : 'sell';
    const [row] = await this.sql<{ position: string | null; orders: string | null }[]>`
      SELECT
        (SELECT sum(size) FROM trade.positions
          WHERE user_id = ${input.userId} AND market_id = ${input.marketId} AND side = ${input.side}
            AND status IN ('open', 'closing'))::text AS position,
        (SELECT sum(qty - filled_qty) FROM trade.futures_orders
          WHERE user_id = ${input.userId} AND market_id = ${input.marketId} AND side = ${bookSide} AND NOT reduce_only
            AND status IN ('pending', 'held', 'submitting', 'open', 'submit_unknown')
            ${input.excludeOrderId ? this.sql`AND id <> ${input.excludeOrderId}` : this.sql``})::text AS orders
    `;
    const exposure = parseAmount(row?.position ?? '0') + parseAmount(row?.orders ?? '0');
    return tierCrossing({ policy: ladder.policy, depthNotional, mark: input.mark, exposure: exposure as Amount, qty: input.qty });
  }

  private requireLeverageCap(): Amount {
    if (this.maxLeverage == null || this.maxLeverage <= 0n) {
      throw new FuturesError('listing leverage cap is unset — refusing to invent a production leverage limit', LEVERAGE_CAP_UNSET, 503);
    }
    return this.maxLeverage;
  }

  /** The plane refusal an opening action would meet now, or null. The gated list shows it without throwing. */
  futuresExposureRefusal(): { code: string; message: string } | null {
    try {
      this.refuseNewPosition();
      return null;
    } catch (err) {
      if (err instanceof FuturesError) return { code: err.code, message: err.message };
      throw err;
    }
  }

  /**
   * New exposure needs both switches. Trading on with the liquidation job off
   * would open positions nothing is scheduled to close. Reduce and close do
   * not call this. A replay of an already-admitted open returns before it.
   */
  private refuseIfFuturesExposureOff(): void {
    const off: string[] = [];
    if (!readTradePlanes(process.env).futures.enabled) off.push('TRADE_FUTURES_ENABLED');
    if (!publishedFlagOn(process.env.TRADE_FUTURES_JOBS_ENABLED)) off.push('TRADE_FUTURES_JOBS_ENABLED');
    if (off.length === 0) return;
    const verb = off.length === 1 ? 'is' : 'are';
    throw new FuturesError(`futures exposure cannot increase while ${off.join(' and ')} ${verb} off`, 'trade.futures_disabled', 403);
  }

  /**
   * A new or growing position also needs the owner's maintenance ladder where one is wired: with none the
   * liquidation tick refuses `trade.ladder_unset` and closes nothing, so the open would take on risk nothing can
   * unwind. Adding margin to an open position is not an open and does not call this.
   */
  private refuseNewPosition(): void {
    this.refuseIfFuturesExposureOff();
    if (this.deps.ladder && !this.deps.ladder.policy) {
      throw new FuturesError(
        'the owner has not published the maintenance tiers (TRADE_FUTURES_LADDER_POLICY); no position opens until they do',
        'trade.ladder_unset',
        503,
      );
    }
  }

  /**
   * What an account's cash in one settle asset backs right now, read from the ledger: its free balance, the pots of its
   * open positions and the holds of its live futures orders. `committed` is what those positions require (their
   * initial margin) plus what the orders hold. `haircutBps` is the owner's cut, or null while it is unset, and then
   * `credit` and `buyingPower` are null too: nothing here guesses a haircut.
   */
  async collateralFigures(
    userId: string,
    asset: string,
    db: Sql | TransactionSql = this.sql,
  ): Promise<{
    free: Amount;
    posted: Amount;
    committed: Amount;
    haircutBps: number | null;
    credit: Amount | null;
    buyingPower: Amount | null;
  }> {
    let haircutBps: number | null;
    try {
      haircutBps = requireOwnerHaircutBps(readOwnerHaircutBps());
    } catch {
      haircutBps = null;
    }
    // One read of every account the user has, so the figures are one consistent ledger state: two reads could see the
    // same cash twice, in free before a hold posts and in the hold after. The rows are read after it, so a move between
    // the two reads can only leave cash out of `posted` or count a margin twice in `committed`, never the other way.
    const snapshot = await this.ledger.balances('user', userId);
    const amountOf = (kind: string, purpose: string): Amount => {
      const row = snapshot.find((b) => b.account.assetId === asset && b.account.kind === kind && (b.account.purpose ?? '') === purpose);
      return row && row.amount > 0n ? row.amount : 0n;
    };
    const positions = await db<{ id: string; margin_initial: string }[]>`
      SELECT id, margin_initial FROM trade.positions
       WHERE user_id = ${userId} AND margin_asset = ${asset} AND status IN ('open', 'closing')
    `;
    const orders = await db<OrderRow[]>`
      SELECT * FROM trade.futures_orders
       WHERE user_id = ${userId} AND hold_asset = ${asset} AND status IN ('pending', 'held', 'submitting', 'open', 'submit_unknown')
    `;
    const accountOf = (ref: { kind: string; purpose?: string }) => amountOf(ref.kind, ref.purpose ?? '');
    const free = accountOf(userAvailable(userId, asset));
    const potRows = positions.map((row) => accountOf(positionCollateralAccount(userId, asset, row.id)));
    const heldRows = orders.map((row) => accountOf(futuresOrderMarginAccount(userId, asset, row.id)));
    let initial = 0n;
    for (const row of positions) initial += parseAmount(String(row.margin_initial));
    let pots = 0n;
    for (const pot of potRows) pots += pot;
    let held = 0n;
    let promised = 0n;
    orders.forEach((row, n) => {
      const inLedger = heldRows[n]!;
      held += inLedger;
      // What the order commits comes from its row: the hold its terms lock less what its fills applied, paid and
      // released. A pending order counts the whole hold it is about to post (its cash is still in free), and an order
      // whose hold posted after the ledger read still counts, so a second open checked meanwhile sees it.
      const fromRow = holdOf(row) - parseAmount(row.applied_amount) - parseAmount(row.fee_charged) - parseAmount(row.released_amount);
      promised += fromRow > inLedger ? fromRow : inLedger;
    });
    const posted = (free + pots + held) as Amount;
    const committed = (initial + promised) as Amount;
    const credit = haircutBps === null ? null : collateralCredit(posted, haircutBps);
    const buyingPower = credit === null ? null : ((credit > committed ? credit - committed : 0n) as Amount);
    return { free, posted, committed, haircutBps, credit, buyingPower };
  }

  /**
   * The account's collateral figures for a credit check. A read that fails refuses `trade.collateral_unreadable` (503):
   * it says nothing about the owner's haircut, and the request may be retried. A blank haircut refuses
   * `trade.haircut_unset`.
   */
  private async collateralForCredit(
    userId: string,
    asset: string,
    db: Sql | TransactionSql = this.sql,
  ): Promise<Awaited<ReturnType<PositionService['collateralFigures']>> & { haircutBps: number }> {
    let figures: Awaited<ReturnType<PositionService['collateralFigures']>>;
    try {
      figures = await this.collateralFigures(userId, asset, db);
    } catch (err) {
      if (err instanceof FuturesError) throw err;
      throw new FuturesError('collateral could not be read — refusing with no margin hold', COLLATERAL_UNREADABLE, 503);
    }
    if (figures.haircutBps === null) {
      throw new FuturesError('TRADE_COLLATERAL_HAIRCUT_BPS is unset — refuse rather than invent a haircut', HAIRCUT_UNSET, 400);
    }
    return { ...figures, haircutBps: figures.haircutBps };
  }

  /**
   * Serialises the credit checks of one account's cash in one asset that write their requirement after they check
   * (a leverage change writes the position's new initial margin when its transaction commits). Held until `db`'s
   * transaction ends, so a check that waits on it reads that requirement. An opening order's check only passes through
   * the lock: its row exists before its check, so a leverage change that takes the lock after it already counts it.
   */
  private async lockCollateral(db: TransactionSql, userId: string, asset: string): Promise<void> {
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`trade.collateral:${userId}:${asset}`}, 0))`;
  }

  /**
   * One rule for every credit check: the account's posted cash (free, position pots and order holds, from one ledger
   * read), cut by the owner's haircut, covers everything committed (positions' initial margin and what live orders
   * commit) plus `additional`, this request's new requirement. The figures come from the ledger, never from
   * `margin_current`: that column is a mirror and can drift from what the ledger holds.
   */
  private assertHaircutCredit(
    figures: { posted: Amount; committed: Amount; haircutBps: number },
    additional: Amount,
    message?: string,
  ): void {
    const decision = decideOpenCredit({
      postedCash: figures.posted,
      initialMargin: (figures.committed + additional) as Amount,
      haircutBps: figures.haircutBps,
    });
    if (!decision.ok) throw new FuturesError(message ?? decision.reason, HAIRCUT_CREDIT_SHORT, 400);
  }

  /**
   * An opening order's hold answers to the owner's haircut like an at-mark open did. A split order's children not yet
   * written are passed as `additionalHold`; a written row already counts its own. Nothing is held on a refusal.
   */
  private async assertMatchedCollateralCredit(input: { userId: string; asset: string; additionalHold?: Amount }): Promise<void> {
    // Wait out a leverage change that is writing its new margin, then read: the lock is taken and let go at once, so no
    // connection is held while the ledger is read.
    await this.sql.begin((tx) => this.lockCollateral(tx, input.userId, input.asset));
    const figures = await this.collateralForCredit(input.userId, input.asset);
    this.assertHaircutCredit(
      figures,
      (input.additionalHold ?? 0n) as Amount,
      'posted collateral, after the haircut, is below the margin already committed plus this order’s hold — nothing was held',
    );
  }

  /**
   * Commit the semantic request before touching the external ledger. A retry of
   * the exact request resumes; a different request cannot inherit its sequence.
   */
  private async claimMarginAdjustment(
    input: { userId: string; symbol: string; positionId?: string },
    adjustmentId: string,
    request: string,
  ): Promise<Position | null> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);
      const rows = input.positionId
        ? await tx<PositionRow[]>`
            SELECT p.*, m.symbol, m.contract_size FROM trade.positions p
            JOIN trade.markets m ON m.id = p.market_id
            WHERE p.id = ${input.positionId} AND p.user_id = ${input.userId}
            LIMIT 1 FOR UPDATE OF p
          `
        : await tx<PositionRow[]>`
            SELECT p.*, m.symbol, m.contract_size FROM trade.positions p
            JOIN trade.markets m ON m.id = p.market_id
            WHERE p.user_id = ${input.userId} AND m.symbol = ${input.symbol} AND p.status = 'open'
            FOR UPDATE OF p
          `;
      if (rows.length === 0) throw new FuturesError('position not found', 'trade.position_not_found', 404);
      if (rows.length > 1)
        throw new FuturesError(`more than one open position on ${input.symbol} — pass position id`, 'trade.position_ambiguous', 400);
      const row = rows[0]!;
      if (row.symbol !== input.symbol)
        throw new FuturesError(`position is on ${row.symbol}, not ${input.symbol}`, 'trade.symbol_mismatch', 400);
      const [existing] = await tx<
        { request_fingerprint: string; status: 'pending' | 'completed'; result: Position | null }[]
      >`SELECT request_fingerprint, status, result FROM trade.position_margin_adjustments
          WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId}`;
      if (existing) {
        if (existing.request_fingerprint !== request) {
          throw new FuturesError('clientAdjustmentId was already used for a different request', 'trade.idempotency_conflict', 409);
        }
        return existing.status === 'completed' ? existing.result : null;
      }
      if (row.status !== 'open') throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
      if (row.margin_mode !== 'isolated')
        throw new FuturesError('live margin adjustment is isolated-only', 'trade.cross_margin_unsupported', 400);
      if (row.margin_adjust_request !== null) {
        throw new FuturesError('a previous margin adjustment must finish before a different request', MARGIN_ADJUSTMENT_IN_PROGRESS, 409);
      }
      const sequence = Number(row.margin_adjust_seq) + 1;
      await tx`INSERT INTO trade.position_margin_adjustments
        (position_id, client_adjustment_id, request_fingerprint, sequence)
        VALUES (${row.id}, ${adjustmentId}, ${request}, ${sequence})`;
      await tx`UPDATE trade.positions SET margin_adjust_request = ${adjustmentId}, updated_at = now() WHERE id = ${row.id}`;
      return null;
    });
  }

  private async abandonMarginAdjustment(
    input: { userId: string; symbol: string; positionId?: string },
    adjustmentId: string,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (input.positionId) {
        await tx`DELETE FROM trade.position_margin_adjustments
          WHERE position_id = ${input.positionId} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
        await tx`UPDATE trade.positions SET margin_adjust_request = NULL, updated_at = now()
          WHERE id = ${input.positionId} AND user_id = ${input.userId} AND margin_adjust_request = ${adjustmentId}`;
      } else {
        await tx`DELETE FROM trade.position_margin_adjustments a USING trade.positions p, trade.markets m
          WHERE a.position_id = p.id AND m.id = p.market_id AND p.user_id = ${input.userId}
            AND m.symbol = ${input.symbol} AND a.client_adjustment_id = ${adjustmentId} AND a.status = 'pending'`;
        await tx`UPDATE trade.positions p SET margin_adjust_request = NULL, updated_at = now()
          FROM trade.markets m WHERE m.id = p.market_id AND p.user_id = ${input.userId}
            AND m.symbol = ${input.symbol} AND p.status = 'open' AND p.margin_adjust_request = ${adjustmentId}`;
      }
    });
  }

  private async completedMarginAdjustment(
    tx: TransactionSql,
    positionId: string,
    adjustmentId: string,
    request: string,
  ): Promise<Position | null> {
    const [record] = await tx<{ request_fingerprint: string; status: 'pending' | 'completed'; result: Position | null }[]>`
      SELECT request_fingerprint, status, result FROM trade.position_margin_adjustments
      WHERE position_id = ${positionId} AND client_adjustment_id = ${adjustmentId}
      FOR UPDATE
    `;
    if (!record || record.request_fingerprint !== request) {
      throw new FuturesError('margin adjustment intent is missing or changed', 'trade.idempotency_conflict', 409);
    }
    return record.status === 'completed' ? record.result : null;
  }

  /**
   * LIQUIDATION SERIALISATION — a trader may not move the money a liquidation is moving.
   *
   * Call it INSIDE the transaction, AFTER the position row is locked (`FOR UPDATE OF p`).
   * That order is the whole point: the liquidation tick's `begin` and `apply` take the same
   * row lock before they touch `trade.liquidation_rungs`, so for one position exactly one of
   * "the trader's mutation" and "a rung becoming live" wins. Either this mutation commits
   * first (and `begin` then sees a changed row and plans nothing), or the rung is already
   * live here and the mutation refuses. Every writer takes the position row FIRST and reads
   * (never locks) the rung table, so there is no lock-order cycle.
   *
   * WHY THE RULE EXISTS. A rung books its loss against the position's collateral pot. A
   * withdrawal, a leverage change that releases margin or a voluntary close that lands
   * between the plan and the post shrinks that pot, and the ledger then refuses the loss; the
   * closing-rung amendment makes the INSURANCE FUND pay for money the trader just took out.
   * Refusing the outflow at the source removes that fraud path (see
   * `docs/adr/2026-10-14-liquidation-shortfall-insurance-leg.md`).
   *
   *   · A LIVE rung (planned/posted): `close`, `reduceIsolatedMargin` and `setLeverage` are
   *     refused with 409 `trade.liquidation_in_progress`. `addIsolatedMargin` is refused only
   *     while the live rung is a CLOSING one: a partial rung applies a DELTA to the row, so
   *     margin added meanwhile survives it; a closing rung would strand it in the pot.
   *   · A PARKED position (latest rung abandoned, or an old-style `liquidation_attempts` claim
   *     on a still-open position): `close`, `reduceIsolatedMargin` and `setLeverage` are
   *     refused with 409 `trade.position_under_review`. The row is not reconciled with a loss
   *     that is already booked, so any outflow would compound the difference. Adding margin is
   *     the only thing allowed (it cannot hurt the books); the operator resolves the park per
   *     the runbook, section 2.
   *   · A PLANNED ADL PAIR (adl-pairing.ts): every operation is refused with 409
   *     `trade.liquidation_in_progress`, adding margin included. The pair fixed both legs at
   *     plan time, so a top-up meanwhile would sit in a position the pair then closes.
   *     Funding skips such a position too (position-loaders.ts), for the same reason.
   *
   * FUNDING IS NOT BLOCKED by a rung. A payee is owed; the rung's amendment path absorbs the race.
   */
  private async assertLiquidationHold(
    tx: TransactionSql,
    positionId: string,
    operation: 'close' | 'reduce_margin' | 'set_leverage' | 'add_margin',
  ): Promise<void> {
    // A matched fill that is still being recorded has posted into this position's pot without its row yet, so
    // no change may run until its row has caught up. The fill itself is retried until it does.
    const [pendingFill] = await tx<{ n: number }[]>`
      SELECT 1 AS n FROM trade.futures_order_fills WHERE position_id = ${positionId} AND state = 'pending' LIMIT 1
    `;
    if (pendingFill) {
      throw new FuturesError(
        'a matched fill on this position is still being recorded — retry in a moment',
        'trade.futures_fill_in_progress',
        409,
      );
    }
    const [hold] = await tx<
      { live_kind: 'partial' | 'closing' | null; latest_state: string | null; claimed: boolean; adl_planned: boolean }[]
    >`
      SELECT
        (SELECT r.kind FROM trade.liquidation_rungs r
          WHERE r.position_id = ${positionId} AND r.state IN ('planned', 'posted') LIMIT 1) AS live_kind,
        EXISTS (SELECT 1 FROM trade.futures_adl_pairs q
          WHERE q.state = 'planned' AND (q.bankrupt_position_id = ${positionId} OR q.candidate_position_id = ${positionId})) AS adl_planned,
        (SELECT r.state FROM trade.liquidation_rungs r
          WHERE r.position_id = ${positionId} ORDER BY r.created_at DESC, r.rung_id DESC LIMIT 1) AS latest_state,
        EXISTS (SELECT 1 FROM trade.liquidation_attempts a WHERE a.liquidation_id = ${defaultLiquidationId(positionId)}) AS claimed
    `;
    if (!hold) return;
    // A planned ADL pair fixed its legs from the margin at plan time; a top-up posted meanwhile would sit in a
    // position the pair then closes, with nothing to release it. So a planned pair refuses every change, top-ups included.
    if (hold.adl_planned) {
      throw new FuturesError('an ADL reduction of this position is in progress — retry in a moment', LIQUIDATION_IN_PROGRESS, 409, {
        addMarginAllowed: false,
      });
    }
    if (hold.live_kind !== null && !(operation === 'add_margin' && hold.live_kind === 'partial')) {
      throw new FuturesError(
        `a liquidation of this position is in progress (${hold.live_kind} rung) — retry in a moment`,
        LIQUIDATION_IN_PROGRESS,
        409,
        { rung: hold.live_kind, addMarginAllowed: hold.live_kind === 'partial' },
      );
    }
    if (operation !== 'add_margin' && (hold.latest_state === 'abandoned' || hold.claimed)) {
      throw new FuturesError(
        'this position is under review after a liquidation that could not be reconciled — only adding margin is allowed until support resolves it',
        POSITION_UNDER_REVIEW,
        409,
      );
    }
    // A resting reduce-only order was bounded by the bankruptcy price of the margin at placement. Taking margin out
    // moves that price toward entry, so a fill before the sweep could land past it and draw on the insurance fund for
    // money the trader took out. The orders go first; adding margin moves the price away and is always allowed.
    if (operation === 'reduce_margin' || operation === 'set_leverage') {
      const [resting] = await tx<{ n: number }[]>`
        SELECT 1 AS n FROM trade.futures_orders
         WHERE position_id = ${positionId} AND reduce_only
           AND (status IN ('pending', 'held', 'submitting', 'open', 'submit_unknown')
                OR (status = 'cancelled' AND COALESCE(engine_filled_qty, qty) > filled_qty))
         LIMIT 1
      `;
      if (resting) {
        throw new FuturesError(
          'this position has reduce-only orders that may still fill — cancel them before taking margin out or changing leverage',
          FUTURES_REDUCE_ORDERS_RESTING,
          409,
        );
      }
    }
  }

  /**
   * A MARGIN ADJUSTMENT THAT HAS POSTED BUT NOT FINALIZED BLOCKS A CLOSE.
   *
   * `margin_adjust_request` is set while a leverage change or an isolated margin add or reduce is between its
   * ledger post and its row update. A crash in that gap leaves the collateral pot at the new amount and the row
   * at the old one, so a close would release the row's amount from a pot that holds a different one (and a
   * partial close would take the same ledger sequence the adjustment used). Resuming the same adjustment
   * finishes it; the close is refused until then.
   */
  private assertNoPendingMarginAdjustment(row: PositionRow): void {
    if (row.margin_adjust_request === null || row.margin_adjust_request === undefined) return;
    throw new FuturesError(
      'a margin adjustment on this position has not finished — repeat it with the same clientAdjustmentId, then close',
      MARGIN_ADJUSTMENT_IN_PROGRESS,
      409,
    );
  }

  /**
   * Would this isolated margin leave the position liquidatable at this mark?
   *
   * With a published ladder policy: the ladder's own rung (depth-tiered maintenance), so the
   * gate and the liquidation tick cannot disagree. Without one: equity <= 0 only (the old
   * `planLiquidation` gate; no maintenance number is invented).
   */
  private async wouldBeLiquidatable(row: PositionRow, margin: Amount, markPrice: Amount, gateId: string): Promise<boolean> {
    const position = {
      positionId: row.id,
      userId: row.user_id,
      side: row.side,
      size: parseAmount(row.size),
      entryPrice: parseAmount(row.entry_price),
      margin,
      marginAsset: row.margin_asset,
    };
    const ladder = this.deps.ladder;
    if (ladder?.policy) {
      const depthNotional = await ladder.depth
        .depthNotional({ marketId: row.market_id, side: row.side, symbol: row.symbol })
        .catch(() => null);
      if (depthNotional == null || depthNotional <= 0n) {
        throw new FuturesError(
          `no readable ${row.side === 'long' ? 'bid' : 'ask'} depth to rate this position against — refusing to release margin blind`,
          'trade.depth_unknown',
          503,
        );
      }
      try {
        return planLadderRung({ position, markPrice, depthNotional, policy: ladder.policy }).action === 'liquidate';
      } catch (err) {
        if (err instanceof FuturesLadderError) throw new FuturesError(err.message, err.code, 503);
        throw err;
      }
    }
    return planLiquidation({ liquidationId: gateId, position, markPrice: formatAmount(markPrice) }).liquidate;
  }

  /**
   * Ask the mark port for a labelled price usable for valuation, or name why not.
   *
   * Two darkness outcomes (never a zero mark):
   *   · no quote at all → `trade.mark_missing`
   *   · a quote the valuation gate rejects (stale, non-positive, future-dated)
   *     → `trade.mark_unusable`
   *
   * `open()` throws on either. `close()` freezes to `closing` instead — see
   * `docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`. A quote good
   * enough to value but not to PAY on is a later gate (`requirePayoutGrade`).
   *
   * ── `authorisesSize` IS NOT A HINT, IT IS THE STAKE ─────────────────────────
   *
   * The size, in base units, of the position this mark is about to price. A
   * depth-backed source uses it to require that the book standing behind the
   * best level is deep enough to stand behind THAT MUCH MONEY, instead of
   * clearing a fixed 100-unit floor that had no relationship to the payout at
   * all — the defect measured at 190,000 USDT
   * (`mark-from-depth.ts`, "AN ABSOLUTE FLOOR CANNOT GATE AN UNBOUNDED PAYOUT").
   *
   * IT IS A REQUIRED PARAMETER WITH NO DEFAULT. Every caller states the stake or
   * states `null`, because a defaulted `null` here is exactly the size-blind
   * behaviour being removed, arrived at by forgetting rather than by deciding.
   * On the close path it comes off the row held under `FOR UPDATE`; it is never
   * anything a request body can reach.
   */
  private async tryMarkForMarking(
    marketId: string,
    symbol: string,
    at: Date,
    authorisesSize: Amount | null,
  ): Promise<{ ok: true; mark: FuturesQuotedMark } | { ok: false; reason: ClosingReason; detail: string }> {
    const request: MarkRequest = { marketId, symbol, at, ...(authorisesSize != null ? { authorisesSize } : {}) };
    /**
     * Money paths require a LABELLED quote. An unlabelled `markPrice` string
     * must not be stamped `quality: 'mid'` (Denon handoff §6) — that invents a
     * liquidation/payout quality and disarms staleness. Missing `quote()` is
     * darkness, not a mid.
     */
    if (!this.deps.marks.quote) {
      return {
        ok: false,
        reason: 'trade.mark_missing',
        detail: `${marketId}: mark source has no labelled quote() — refuse inventing quality from bare markPrice`,
      };
    }
    const quoted = await this.deps.marks.quote(request);

    if (!quoted) {
      return { ok: false, reason: 'trade.mark_missing', detail: markMissing(marketId).reason! };
    }
    const check = acceptableForMarking(quoted, at, this.markPolicy);
    if (!check.ok) {
      return {
        ok: false,
        reason: check.code === 'trade.mark_missing' ? 'trade.mark_missing' : 'trade.mark_unusable',
        detail: check.reason ?? 'mark unusable',
      };
    }
    return { ok: true, mark: quoted };
  }

  /**
   * Open path: darkness refuses, and so does last-trade (DIRECTION MVP-1).
   * Close path uses `tryMarkForMarking` + freeze — losing exits may still mark
   * on `last`; entry may not.
   */
  private async markFor(marketId: string, symbol: string, at: Date, authorisesSize: Amount | null): Promise<FuturesQuotedMark> {
    const got = await this.tryMarkForMarking(marketId, symbol, at, authorisesSize);
    if (!got.ok) {
      throw new FuturesError(
        got.reason === 'trade.mark_missing' ? got.detail : `Refusing to value this position — ${got.detail}`,
        got.reason,
        503,
      );
    }
    const entry = acceptableForEntry(got.mark, at, this.markPolicy);
    if (!entry.ok) {
      throw new FuturesError(
        entry.code === 'trade.mark_missing' ? (entry.reason ?? 'mark missing') : `Refusing to value this position — ${entry.reason}`,
        entry.code ?? 'trade.mark_unusable',
        503,
      );
    }
    return got.mark;
  }

  /**
   * A mark good enough to SHOW is not automatically good enough to PAY ON.
   *
   * `prices.ts`'s asymmetry, pointed the other way: a warning on a questionable
   * mark costs a notification, a payout on one costs real money that leaves the
   * platform. So a close that realises PROFIT must clear the same bar a
   * liquidation does — quality, the tighter staleness limit, the deviation
   * breaker — and `last` therefore cannot fund a payout.
   *
   * A losing or flat close is deliberately NOT held to that bar once a usable
   * marking-grade quote exists — it returns the trader their own margin and
   * pays out nothing. When NO usable mark exists at all, this method is not
   * reached: `close()` freezes the row to `closing` first
   * (`docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`). An older
   * comment here claimed the losing-close exemption alone prevented trapping;
   * that was false while `markFor` threw before this gate — do not restore
   * that lie.
   *
   * ── `previous` is the half of this that used to be missing ──────────────────
   *
   * This method passed a literal `null` here, and `null` is the branch
   * `acceptableForLiquidation` uses to SKIP the deviation breaker. Every other
   * clause was live and that one was dead, so a feed that jumped 100x cleared
   * this gate and the house paid 4,950,000 USDT on it — measured, not
   * hypothesised (`position-service.test.ts`). The basis now comes from the
   * position row the caller cannot write, read inside the same lock as the
   * close that is about to use it.
   */
  private requirePayoutGrade(mark: FuturesQuotedMark, previous: PreviousMark, at: Date): void {
    const check = acceptableForLiquidation(mark, breakerBasis(previous), at, this.markPolicy);
    if (!check.ok) {
      throw new FuturesError(`Refusing to pay realised profit on this mark — ${check.reason}`, check.code ?? 'trade.mark_unusable', 503);
    }
  }

  /**
   * Active positions: `open` and `closing`. A frozen exit must remain visible
   * and must never render as a normal open (ADR 2026-08-07 done bar 7).
   */
  /**
   * Place a futures order through svc-matching (slice 6). Refused unless the switch is on, the band is named and
   * the market is a futures market. See `matched-orders.ts`.
   */
  /** `context.region` is the request's edge region, read only by the derivatives gate (see `open`). */
  async placeMatchedOrder(principal: Principal, input: PlaceMatchedOrderInput, context: { readonly region?: string | null } = {}) {
    return this.matched.place(principal, input, context);
  }

  /** The reduce-only order a fired conditional order places for its trader (`MatchedFuturesOrders.placeOnInstruction`). */
  async placeMatchedOnInstruction(input: PlaceMatchedOrderInput, instructionId: string) {
    return this.matched.placeOnInstruction(input, instructionId);
  }

  /** An opening order above the max-order, placed as children of at most the cap (`MatchedFuturesOrders.placeSplit`). */
  async placeMatchedSplit(principal: Principal, input: PlaceMatchedOrderInput, context: { readonly region?: string | null } = {}) {
    return this.matched.placeSplit(principal, input, context);
  }

  /** The caller's own matched futures orders (`MatchedFuturesOrders.listForUser`). */
  async listMatchedOrders(
    userId: string,
    input: { readonly scope: 'open' | 'all'; readonly limit: number; readonly symbol?: string | null },
  ) {
    return this.matched.listForUser(userId, input);
  }

  /** Cancel a matched futures order the caller owns, and release the part of its hold no fill used. */
  async cancelMatchedOrder(principal: Principal, orderId: string) {
    return this.matched.cancel(principal, orderId);
  }

  /** Settle matched fills that arrived while a position was busy (see `MatchedFuturesOrders.settleFillOrWait`). */
  async retryWaitingMatchedFills(limit: number) {
    return this.matched.retryWaitingFills(limit);
  }

  /** The port the liquidation tick works a liquidation through the book with (futures ADR slice 7). */
  get matchedLiquidation() {
    return this.matched.liquidationPort;
  }

  /** Cancel resting matched orders whose limit has left the price band around the current mark (futures ADR section 1). */
  async cancelMatchedOrdersOutsideBand() {
    return this.matched.cancelOutsideBand();
  }

  /** The matched-order settlement, for the matching consumers. Fills and releases run whether or not the switch is on. */
  get matchedFills(): {
    settle(fill: MatchedFillEvent): Promise<void>;
    releaseCancelled(orderId: string, remainingQty: string): Promise<boolean>;
    ownsFill(fill: { makerOrderId: string; takerOrderId: string }): Promise<boolean>;
  } {
    return {
      settle: async (fill) => {
        await this.matched.settleFillOrWait(fill);
      },
      releaseCancelled: (orderId, remainingQty) => this.matched.releaseEngineCancellation(orderId, remainingQty),
      ownsFill: (fill) => this.matched.ownsFill(fill),
    };
  }

  /** The private positions update for one row, by id. Used after a matched fill commits. */
  private async publishPositionById(positionId: string): Promise<void> {
    const [row] = await this.sql<PositionRow[]>`
      SELECT p.*, m.symbol, m.contract_size
      FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id
      WHERE p.id = ${positionId}
    `;
    if (row) await this.publishPositionUpdated(row);
  }

  async listOpen(userId: string, symbol?: string, clientOpenId?: string): Promise<Position[]> {
    const openId = clientOpenId === undefined ? null : clientOpenId;
    const rows = symbol
      ? await this.sql<PositionRow[]>`
          SELECT p.*, m.symbol, m.contract_size
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.user_id = ${userId}
            AND p.status IN ('open', 'closing')
            AND m.symbol = ${symbol}
            AND (${openId}::text IS NULL OR p.client_open_id = ${openId})
          ORDER BY p.opened_at DESC
        `
      : await this.sql<PositionRow[]>`
          SELECT p.*, m.symbol, m.contract_size
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.user_id = ${userId}
            AND p.status IN ('open', 'closing')
            AND (${openId}::text IS NULL OR p.client_open_id = ${openId})
          ORDER BY p.opened_at DESC
        `;
    const figures = await this.matchedFigures(rows);
    return Promise.all(rows.map((row) => this.presentListed(row, figures.get(row.id))));
  }

  /**
   * Settled history: `closed` and `liquidated`. Empty [] when none — never
   * invents a mark. Open/closing rows stay on listOpen. Optional since is SQL
   * on COALESCE(closed_at, opened_at). Limit is required — missing / non-int /
   * out of 1..500 refuses (never invent 100). Owner/query may pass 100.
   */
  async listClosed(userId: string, input: { symbol?: string; limit: number; sinceMs?: number }): Promise<Position[]> {
    const limit = publishedListClosedLimit(input?.limit);
    const sinceDate = input.sinceMs !== undefined ? new Date(input.sinceMs) : undefined;
    const symbol = input.symbol?.trim() || undefined;
    const rows =
      symbol && sinceDate
        ? await this.sql<PositionRow[]>`
            SELECT p.*, m.symbol, m.contract_size
            FROM trade.positions p
            JOIN trade.markets m ON m.id = p.market_id
            WHERE p.user_id = ${userId}
              AND p.status IN ('closed', 'liquidated')
              AND m.symbol = ${symbol}
              AND COALESCE(p.closed_at, p.opened_at) >= ${sinceDate}
            ORDER BY COALESCE(p.closed_at, p.opened_at) DESC
            LIMIT ${limit}
          `
        : symbol
          ? await this.sql<PositionRow[]>`
              SELECT p.*, m.symbol, m.contract_size
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.user_id = ${userId}
                AND p.status IN ('closed', 'liquidated')
                AND m.symbol = ${symbol}
              ORDER BY COALESCE(p.closed_at, p.opened_at) DESC
              LIMIT ${limit}
            `
          : sinceDate
            ? await this.sql<PositionRow[]>`
                SELECT p.*, m.symbol, m.contract_size
                FROM trade.positions p
                JOIN trade.markets m ON m.id = p.market_id
                WHERE p.user_id = ${userId}
                  AND p.status IN ('closed', 'liquidated')
                  AND COALESCE(p.closed_at, p.opened_at) >= ${sinceDate}
                ORDER BY COALESCE(p.closed_at, p.opened_at) DESC
                LIMIT ${limit}
              `
            : await this.sql<PositionRow[]>`
                SELECT p.*, m.symbol, m.contract_size
                FROM trade.positions p
                JOIN trade.markets m ON m.id = p.market_id
                WHERE p.user_id = ${userId}
                  AND p.status IN ('closed', 'liquidated')
                ORDER BY COALESCE(p.closed_at, p.opened_at) DESC
                LIMIT ${limit}
              `;
    const figures = await this.matchedFigures(rows);
    return Promise.all(rows.map((row) => this.presentListed(row, figures.get(row.id))));
  }

  /**
   * What a position's fills through the book say about it (migrations 0096 and 0099).
   *
   * FEES. Every applied fill on the position, opening or reducing, paid its fee into house fees; the position reports
   * their sum. A position with no fill through the book (an older at-mark row) reports none, with the reason.
   *
   * A CLOSED POSITION realised its result fill by fill: the sum of its applied reduce fills, each the amount that was
   * paid, owed or booked. The row's accepted mark is only the last reduce's price, so it would report the last fill
   * alone. The sums are used only when the reduce fills close exactly what the opening fills opened. A position whose
   * fills do not cover its whole history reports its result as unknown, since neither the sum nor the row's last figure
   * is the whole of it: one opened through the book but also shrunk some other way (auto-deleveraging, or an at-mark
   * close while the book was off), and one with reduce fills but no opening fill (opened at the mark before the book).
   * A position with no fill through the book keeps the row's own figures. Liquidated rows keep theirs: a liquidation
   * hands part to ADL.
   */
  private async matchedFigures(rows: readonly PositionRow[]): Promise<Map<string, PresentExtras>> {
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return new Map();
    const sums = await this.sql<
      { position_id: string; realized: string | null; closed: string | null; opened: string | null; fees: string }[]
    >`
      SELECT position_id::text AS position_id,
             (CASE WHEN count(*) FILTER (WHERE kind = 'reduce') = count(realized_pnl) FILTER (WHERE kind = 'reduce')
                   THEN sum(realized_pnl) FILTER (WHERE kind = 'reduce') END)::text AS realized,
             (sum(qty) FILTER (WHERE kind = 'reduce'))::text AS closed,
             (sum(qty) FILTER (WHERE kind = 'open'))::text AS opened,
             sum(fee)::text AS fees
      FROM trade.futures_order_fills
      WHERE state = 'applied' AND position_id IN ${this.sql(ids)}
      GROUP BY position_id
    `;
    const byId = new Map(sums.map((row) => [row.position_id, row]));
    const out = new Map<string, PresentExtras>();
    for (const row of rows) {
      const sum = byId.get(row.id);
      if (!sum) {
        out.set(row.id, { fees: null });
        continue;
      }
      const extras: { fees: string; realizedPnl?: string | null; closedSize?: string } = { fees: formatAmount(parseAmount(sum.fees)) };
      // A fill with no recorded result leaves the sum unknown, never zero (the table refuses one, migration 0096).
      if (row.status === 'closed' && sum.closed != null) {
        if (sum.opened != null && parseAmount(sum.closed) === parseAmount(sum.opened)) {
          extras.realizedPnl = sum.realized == null ? null : formatAmount(parseAmount(sum.realized));
          extras.closedSize = formatAmount(parseAmount(sum.closed));
        } else {
          // Its fills do not cover its whole history: opened at the mark before orders went through the book (no
          // opening fill, and it may have been partly closed at the mark too), or shrunk by auto-deleveraging, which
          // leaves no fill row. The reduce fills are part of its result and so is what happened outside them, and the
          // row's own figure is only its last remainder. Unknown, never partial. The size closed through the book is
          // what its fills record.
          extras.realizedPnl = null;
          extras.closedSize = formatAmount(parseAmount(sum.closed));
        }
      }
      out.set(row.id, extras);
    }
    return out;
  }

  /**
   * One position owned by this user. Closed rows are returned as closed — not
   * hidden, and not revalued. Missing / not theirs is 404 (same answer).
   */
  async get(userId: string, positionId: string): Promise<Position> {
    const id = positionId.trim();
    if (!id) {
      throw new FuturesError('position id is required', 'trade.bad_request', 400);
    }
    const [row] = await this.sql<PositionRow[]>`
      SELECT p.*, m.symbol, m.contract_size
      FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id
      WHERE p.id = ${id} AND p.user_id = ${userId}
      LIMIT 1
    `;
    if (!row) throw new FuturesError('position not found', 'trade.position_not_found', 404);
    const figures = await this.matchedFigures([row]);
    return this.presentListed(row, figures.get(row.id));
  }

  /**
   * `context.region` is the edge region of the request. It is read only by the derivatives gate to pick the
   * jurisdiction text. It is deliberately not on `input`: `input` is the business payload that a replayed open is
   * compared against, and a retry from another region must still find the original open.
   */
  async open(input: OpenPositionInput, principal?: Principal, context: { readonly region?: string | null } = {}): Promise<Position> {
    /**
     * WHILE MATCHED MODE IS ON, NO AT-MARK OPEN AND NO AT-MARK REDUCE.
     *
     * A matched fill opens its row under a slot id and inserts it when the first fill lands. An at-mark open that
     * inserted an open row for the same (user, market, side) in between would make that insert violate the unique
     * open index after the ledger had already posted the fill's margin. So while matching is on, new at-mark opens
     * refuse. A reduce-only open here is an at-mark close (`closeQuantity`), retired with the rest of the at-mark
     * close path (slice 6b): a reduce goes through a reduce-only matched order, priced in the book.
     */
    if (this.matched.matchingEnabled) {
      if (input.reduceOnly === true) this.refuseCloseAtMark();
      throw new FuturesError(
        'opening at the mark is retired while futures orders go through the matching engine — place a matched order',
        'trade.futures_open_at_mark_retired',
        409,
      );
    }
    if (input.reduceOnly === true) return this.reduceOnlyOpen(input);
    /**
     * NO POT, NO NEW POSITIONS.
     *
     * Refused before the market lookup and long before any margin is locked. A
     * deployment that has not named a profit source cannot honour a winning
     * position, so letting someone open one would be selling a promise the
     * platform has not funded. Losing and flat CLOSES of positions opened while
     * a pot was configured stay available — see `close()`.
     */
    if (this.deps.profitSource == null) {
      throw new FuturesError(`Futures is not open on this deployment — ${PROFIT_SOURCE_UNCONFIGURED}`, 'trade.futures_unconfigured', 403);
    }

    /**
     * IDEMPOTENT OPEN KEY (required) — refuse before mark/ledger.
     * Same clientOpenId → same lock key → ledger no-ops on retry.
     * Parity with spot clientOrderId — omit no longer mints randomUUID (double margin).
     */
    const clientOpenId = input.clientOpenId?.trim() ?? '';
    if (clientOpenId.length === 0 || clientOpenId.length > 64) {
      throw new FuturesError(
        'clientOpenId is required (1–64 chars) — omit would double-lock margin on retry',
        'trade.client_open_id_required',
        400,
      );
    }

    const market = await this.sql<
      {
        id: string;
        symbol: string;
        kind: string;
        status: string;
        base_asset: string;
        quote_asset: string;
        lot_size: string | null;
        futures_contract_style: 'perpetual' | 'dated' | null;
        futures_expiry_at: Date | null;
        futures_settlement_fixing: string | null;
      }[]
    >`
      SELECT id, symbol, kind, status, base_asset, quote_asset, lot_size,
             futures_contract_style, futures_expiry_at, futures_settlement_fixing
      FROM trade.markets
      WHERE symbol = ${input.symbol}
      LIMIT 1
    `;
    const m = market[0];
    if (!m) throw new FuturesError(`unknown market ${input.symbol}`, 'trade.market_not_found', 404);
    const positionId = positionIdFor(input.userId, m.id, clientOpenId);
    const businessId = `position:${positionId}`;
    const original = await this.deps.accountAdmission?.original(input.userId, businessId);
    if (original) {
      const evidence = original.payload as Record<string, unknown>;
      if (canonicalPayload(evidence.request) !== canonicalPayload(businessPayload(input)))
        throw new TradingControlError('operation.conflict');
      if (!principal || principal.userId !== input.userId || !this.deps.accountAdmission)
        throw new TradingControlError('auth.credential_denied');
      await this.deps.accountAdmission.admit(principal, 'order.place', businessId, evidence);
      return this.executeAdmittedPosition(input, evidence);
    }
    // RC-identity-01: a new position locks customer margin, so it needs a proved email.
    // Before any margin lock; reduce-only and close never come here.
    await assertEmailProved(this.deps.emailProof, input.userId);

    /**
     * D-account-07 — the identity level before open. Reduce-only returned above, so a closing action is never held
     * up by it. The tier is the caller's own principal claim, null when none was passed. It runs after the
     * admitted-open replay: an open that was admitted and locked margin before a crash finishes on retry even if a new
     * rules version was published meanwhile, so its margin is never left locked.
     */
    if (this.deps.assertDerivativesAccess) {
      await this.deps.assertDerivativesAccess({
        userId: input.userId,
        tier: principal?.tier ?? null,
        region: context.region ?? null,
      });
    }

    this.refuseNewPosition();

    if (m.kind !== 'futures') {
      throw new FuturesError(`market ${input.symbol} is ${m.kind}, not futures`, 'trade.not_futures_market', 400);
    }
    if (m.status !== 'active') {
      throw new FuturesError(`market ${input.symbol} is ${m.status}`, 'trade.market_not_tradable', 400);
    }
    try {
      assertDatedFuturesTradable(
        {
          kind: 'futures',
          symbol: m.symbol,
          futuresContractStyle: m.futures_contract_style,
          futuresExpiryAt: m.futures_expiry_at,
          futuresSettlementFixing: m.futures_settlement_fixing,
        },
        { now: new Date() },
      );
    } catch (err) {
      if (err instanceof TradeError) {
        throw new FuturesError(err.message, err.code, err.code === 'trade.dated_futures_expired' ? 403 : 400);
      }
      throw err;
    }

    /**
     * LEVERAGE IS REFUSED BEFORE ANYTHING IS READ, LOCKED OR WRITTEN.
     *
     * First, because it is the cheapest refusal available and needs no mark, no
     * ledger post and no row. Second, and the reason it is here rather than
     * further down: `positions.leverage` is `numeric(8, 2)`, so a leverage of
     * `1000000` used to reach the INSERT and raise Postgres `22003`. The
     * compensating `futuresMarginRelease` fired and no money was stranded, but
     * the caller got a **500** for a request that was simply out of range, and a
     * 500 is the platform saying it broke when in fact it was asked for
     * something it does not offer. Validating here makes it a named 400 that
     * never locked anything, so there is nothing to compensate.
     *
     * The cap is DIRECTION §1 10× unless the host tightened it.
     */
    const leverageCheck = checkLeverage(input.leverage, this.requireLeverageCap());
    if (!leverageCheck.ok) {
      throw new FuturesError(leverageCheck.reason ?? 'leverage refused', leverageCheck.code ?? 'trade.leverage_invalid', 400);
    }

    /**
     * THE SIZE MUST ALSO BE A SIZE. Non-positive size reached `initialMargin`,
     * which threw a bare `Error` and surfaced as a 500 for the same reason
     * leverage did. It is also the denominator of the depth requirement below.
     */
    if (input.size <= 0n) {
      throw new FuturesError(`size must be greater than zero, got ${formatAmount(input.size)}`, 'trade.size_invalid', 400);
    }

    /**
     * THE ENTRY PRICE IS READ, NOT RECEIVED. It sizes the margin lock and it is
     * the basis of every later PnL, so it is a price that moves money.
     *
     * AND IT IS READ AGAINST THIS POSITION'S SIZE. The book behind the mark must
     * be deep enough for the position the mark is about to open, not merely
     * non-dust — `mark-from-depth.ts` argues the relationship. There is no
     * stored row to read the size from yet, and using the caller's is safe in
     * the only direction that matters: the requirement rises with it, and the
     * same number is written verbatim into the row four statements below. A
     * caller who understates it to slip past the gate opens the smaller position
     * they claimed, which is not an attack, it is a smaller trade.
     */
    const at = this.now();
    const mark = await this.markFor(m.id, m.symbol, at, input.size);
    const entryPrice = mark.price;

    // Second door. Named modes refuse here too: the row is what liquidation
    // later reads to decide whose money is at stake. Isolated-only storage stays.
    const modeCheck = checkMarginModeForFuturesOpen(input.marginMode);
    if (!modeCheck.ok) {
      throw new FuturesError(modeCheck.reason, modeCheck.code, 400);
    }
    const collateralCheck = checkCollateralClassForMargin(input.collateralClass);
    if (!collateralCheck.ok) {
      throw new FuturesError(collateralCheck.reason, collateralCheck.code, 400);
    }

    const leverage = input.leverage;
    const marginMode = input.marginMode ?? 'isolated';
    const margin = initialMargin({
      size: input.size,
      entryPrice,
      leverage,
    });
    this.assertHaircutCredit(await this.collateralForCredit(input.userId, m.quote_asset), margin);
    if (!principal || principal.userId !== input.userId) throw new TradingControlError('auth.credential_denied');
    if (!this.deps.accountAdmission) throw new TradingControlError('authority.unavailable');
    // Owner pre-trade limits (#4725), before the margin lock. A retry of an
    // already-admitted open returned above and is never newly refused.
    const limitRefusal = await checkOpenAdmission({
      sql: this.sql,
      userId: input.userId,
      marketId: m.id,
      quoteAsset: m.quote_asset,
      side: input.side,
      size: input.size,
      entryPrice,
      positionMode: (input as { positionMode?: unknown }).positionMode,
      markFor: async (marketId, symbol) => (await this.markFor(marketId, symbol, at, null)).price,
    });
    if (limitRefusal)
      throw new FuturesError(
        limitRefusal.message,
        limitRefusal.code,
        limitRefusal.code.endsWith('_unset') ? 400 : PRETRADE_LIMIT_HTTP_STATUS,
      );
    // The open-interest limits an opening order through the book answers to (D-margin-05), wherever they are wired.
    // The room counts live opening orders as well: orders placed while matching was on may still rest after it is off.
    if (this.openInterestLimits) {
      const room = await this.openInterestRoom({
        userId: input.userId,
        marketId: m.id,
        symbol: m.symbol,
        lotSize: m.lot_size == null ? null : parseAmount(m.lot_size),
      });
      const over = openInterestRefusal(room, input.size, m.base_asset);
      if (over) throw new FuturesError(over.message, over.code, over.status);
    }
    const evidence = businessPayload({
      request: input,
      market: { id: m.id, symbol: m.symbol, quote_asset: m.quote_asset },
      positionId,
      entryPrice,
      leverage,
      marginMode,
      margin,
      at,
    });
    await this.deps.accountAdmission.admit(principal, 'order.place', businessId, evidence);
    return this.executeAdmittedPosition(input, evidence);
  }

  private async executeAdmittedPosition(input: OpenPositionInput, evidence: Record<string, unknown>): Promise<Position> {
    const m = evidence.market as { id: string; symbol: string; quote_asset: string };
    const positionId = String(evidence.positionId);
    const entryPrice = parseAmount(String(evidence.entryPrice));
    const leverage = parseAmount(String(evidence.leverage));
    const marginMode = String(evidence.marginMode);
    const margin = parseAmount(String(evidence.margin));
    const at = new Date(String(evidence.at));
    const [existing] = await this.sql<PositionRow[]>`SELECT p.*, m.symbol, m.contract_size FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id WHERE p.id = ${positionId} AND p.user_id = ${input.userId}`;
    if (existing) return this.presentListed(existing);
    /**
     * A ROLLED-BACK OPEN STAYS ROLLED BACK.
     *
     * The margin lock is keyed on the position id alone, and so is its release. After a failed row insert the
     * release has been posted; re-posting the lock for the same open would be deduped by the ledger as already
     * done, and the row would then be written with no margin held. The rollback is recorded before the release,
     * so a retry finds it, finishes the release (idempotent) and refuses. A new open uses a new clientOpenId.
     */
    const [rolledBack] = await this.sql<{ outcome: { code?: string } | null }[]>`
      SELECT outcome FROM trade.futures_open_requests
      WHERE user_id = ${input.userId} AND market_id = ${m.id} AND client_open_id = ${input.clientOpenId}
        AND reduce_only = false AND outcome IS NOT NULL
    `;
    if (rolledBack?.outcome?.code === OPEN_ROLLED_BACK) {
      await this.releaseFailedOpenMargin(input.userId, positionId, m.quote_asset, margin);
      throw new FuturesError('this open was rolled back; submit it again with a new clientOpenId', OPEN_ROLLED_BACK, 409);
    }
    // Money first — never a position row without a ledger claim.
    await this.ledger.post(
      recipes.futuresMarginLock({
        positionId,
        userId: input.userId,
        assetId: m.quote_asset,
        amount: margin,
      }),
    );

    try {
      /**
       * THE BREAKER IS ARMED FROM BIRTH.
       *
       * `accepted_mark` is seeded with the entry mark, because the entry mark is
       * a price this platform read and acted on: it sized the margin lock. So a
       * position's very first close already has something to be measured
       * against, and the legitimately-unarmed `first_valuation` case narrows to
       * rows that predate `0007_position_accepted_mark.sql`.
       *
       * Seeding it here is safe in the direction that matters. An attacker who
       * pumps the feed BEFORE opening buys in at the pumped price and has
       * nothing to realise; the only way to profit from a jump is to make it
       * after entry, and that is precisely what this number now catches.
       */
      await this.sql`
        INSERT INTO trade.positions (
          id, user_id, market_id, side, status, margin_mode,
          size, entry_price, leverage, margin_initial, margin_current, margin_asset, funding_paid,
          accepted_mark, accepted_mark_at, client_open_id
        ) VALUES (
          ${positionId},
          ${input.userId},
          ${m.id},
          ${input.side},
          'open',
          ${marginMode},
          ${formatAmount(input.size)},
          ${formatAmount(entryPrice)},
          ${formatAmount(leverage)},
          ${formatAmount(margin)},
          ${formatAmount(margin)},
          ${m.quote_asset},
          '0',
          ${formatAmount(entryPrice)},
          ${at},
          ${input.clientOpenId}
        )
      `;
    } catch (err) {
      /**
       * RETRY PATH. Same clientOpenId already wrote this row (or a concurrent
       * open with the same key won the race). Do not release the lock we just
       * no-op'd on — the original position still owns it. Re-read and return.
       * Other failures still release (unique open on a *different* id, etc.).
       */
      {
        const existing = await this.sql<PositionRow[]>`
          SELECT p.*, m.symbol, m.contract_size
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.id = ${positionId}
          LIMIT 1
        `;
        if (existing[0]) {
          return this.presentListed(existing[0]);
        }
      }
      // Roll margin back if the row failed (unique open, etc.). Recorded first, so a crash before the release
      // is finished by the retry instead of re-opening an unfunded position.
      await this.sql`
        INSERT INTO trade.futures_open_requests (user_id, market_id, client_open_id, reduce_only, outcome)
        VALUES (${input.userId}, ${m.id}, ${input.clientOpenId}, false,
                ${this.sql.json({ refused: true, code: OPEN_ROLLED_BACK, message: 'open rolled back' } as never)})
        ON CONFLICT (user_id, market_id, client_open_id) DO UPDATE SET outcome = EXCLUDED.outcome
        WHERE trade.futures_open_requests.outcome IS NULL AND trade.futures_open_requests.reduce_only = false
      `;
      await this.releaseFailedOpenMargin(input.userId, positionId, m.quote_asset, margin);
      throw err;
    }

    const [row] = await this.sql<PositionRow[]>`
      SELECT p.*, m.symbol, m.contract_size
      FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id
      WHERE p.id = ${positionId}
    `;
    await this.sql`
      INSERT INTO trade.futures_open_requests (user_id, market_id, client_open_id, reduce_only)
      VALUES (${input.userId}, ${m.id}, ${input.clientOpenId}, false)
      ON CONFLICT (user_id, market_id, client_open_id) DO NOTHING
    `;
    await this.publishPositionUpdated(row!);
    return this.presentListed(row!);
  }

  private async releaseFailedOpenMargin(userId: string, positionId: string, assetId: string, amount: Amount): Promise<void> {
    await this.ledger.post(
      recipes.futuresMarginRelease({
        positionId,
        userId,
        assetId,
        amount,
        sequence: 1,
      }),
    );
  }

  /** Owned recovery hook, independent of live credentials; no public receipt is accepted. */
  async recoverAdmittedPosition(userId: string, positionId: string): Promise<Position | null> {
    if (!this.deps.accountAdmission) throw new TradingControlError('authority.unavailable');
    const original = await this.deps.accountAdmission.resolve(userId, `position:${positionId}`);
    if (!original) return null;
    const evidence = original.payload as Record<string, unknown>;
    const wire = evidence.request as Record<string, unknown>;
    if (wire.userId !== userId || evidence.positionId !== positionId) throw new TradingControlError('operation.conflict');
    const input = {
      ...wire,
      size: parseAmount(String(wire.size)),
      leverage: parseAmount(String(wire.leverage)),
    } as unknown as OpenPositionInput;
    return this.executeAdmittedPosition(input, evidence);
  }

  /**
   * Live isolated re-leverage within the explicit owner/listing cap.
   *
   * Extra IM is `futuresMarginAdd`; excess is `futuresMarginRelease`. Open lock
   * keys once per position, so a second `futuresMarginLock` would no-op.
   * Close residual release already uses sequence 1 — adjusts start at 2.
   *
   * Refuses without posting when the new IM would leave equity ≤ 0 at the
   * current mark (D3 maintenance unset — equity only) or when the extra lock
   * cannot be funded. Does not invent funding, a liq-price, or a profit source.
   */
  async setLeverage(input: SetLeverageInput, principal?: Principal): Promise<Position> {
    const leverageCheck = checkLeverage(input.leverage, this.requireLeverageCap());
    if (!leverageCheck.ok) {
      throw new FuturesError(leverageCheck.reason ?? 'leverage refused', leverageCheck.code ?? 'trade.leverage_invalid', 400);
    }

    const symbol = input.symbol.trim();
    if (!symbol) {
      throw new FuturesError('symbol is required', 'trade.bad_request', 400);
    }

    const request = `leverage:${formatAmount(input.leverage)}`;
    const adjustmentId = input.clientAdjustmentId?.trim() || request;
    const claimed = { ...input, symbol };
    const completed = await this.claimMarginAdjustment(claimed, adjustmentId, request);
    if (completed) return completed;
    let ledgerAttempted = false;
    try {
      const row = await this.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);

        const locked = input.positionId
          ? await tx<PositionRow[]>`
              SELECT p.*, m.symbol, m.contract_size
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.id = ${input.positionId} AND p.user_id = ${input.userId}
              LIMIT 1
              FOR UPDATE OF p
            `
          : await tx<PositionRow[]>`
              SELECT p.*, m.symbol, m.contract_size
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.user_id = ${input.userId}
                AND m.symbol = ${symbol}
                AND p.status = 'open'
              FOR UPDATE OF p
            `;

        if (input.positionId) {
          if (!locked[0]) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        } else if (locked.length === 0) {
          throw new FuturesError(`no open position on ${symbol}`, 'trade.position_not_found', 404);
        } else if (locked.length > 1) {
          throw new FuturesError(`more than one open position on ${symbol} — pass position id`, 'trade.position_ambiguous', 400);
        }

        const row = locked[0]!;
        if (row.symbol !== symbol) {
          throw new FuturesError(`position is on ${row.symbol}, not ${symbol}`, 'trade.symbol_mismatch', 400);
        }
        if (row.status !== 'open') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }
        if (row.margin_mode !== 'isolated') {
          throw new FuturesError('live re-leverage is isolated-only — margin mode is set at open', 'trade.cross_margin_unsupported', 400);
        }
        const replay = await this.completedMarginAdjustment(tx, row.id, adjustmentId, request);
        if (replay) return replay;
        await this.assertLiquidationHold(tx, row.id, 'set_leverage');

        if (row.leverage == null) {
          throw new FuturesError('leverage was not recorded on this position', 'leverage_not_recorded', 400);
        }
        const currentLeverage = parseAmount(row.leverage);
        if (currentLeverage === input.leverage) {
          // The claim stored this adjustment at sequence + 1. Nothing posts, but the counter still moves past it,
          // so the next real adjustment cannot be given a sequence a completed row already holds.
          await tx`UPDATE trade.positions
            SET margin_adjust_seq = GREATEST(margin_adjust_seq, ${Number(row.margin_adjust_seq) + 1}),
                margin_adjust_request = NULL, updated_at = now()
            WHERE id = ${row.id} AND margin_adjust_request = ${adjustmentId}`;
          const result = presentPosition(row);
          await tx`UPDATE trade.position_margin_adjustments
            SET status = 'completed', result = ${tx.json(result)}, completed_at = now()
            WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
          return row;
        }

        const size = parseAmount(row.size);
        const entryPrice = parseAmount(row.entry_price);
        const currentMargin = parseAmount(row.margin_current ?? row.margin_initial);
        const target = initialMargin({ size, entryPrice, leverage: input.leverage });

        /**
         * THE LIQUIDATION GATE GUARDS AN OUTFLOW ONLY. Raising leverage releases margin (target below what
         * the position holds) and must leave something the ladder would not liquidate. Lowering leverage
         * ADDS margin: it can only improve the position, so it is never refused by this gate, by a dark
         * mark, or by an unreadable book (`trade.depth_unknown`). The mark is not even read for an inflow.
         */
        if (target < currentMargin) {
          const at = this.now();
          const mark = await this.markFor(row.market_id, row.symbol, at, size);
          if (await this.wouldBeLiquidatable(row, target, mark.price, `re-leverage-gate:${row.id}`)) {
            throw new FuturesError(
              `refusing leverage ${formatAmount(input.leverage)}x — new isolated margin would already be in liquidation at the current mark`,
              LEVERAGE_WOULD_LIQUIDATE,
              400,
            );
          }
        }

        if (input.leverage > currentLeverage) {
          if (!principal || principal.userId !== input.userId) throw new TradingControlError('auth.credential_denied');
          if (!this.deps.accountAdmission) throw new TradingControlError('authority.unavailable');
          await this.deps.accountAdmission.admit(
            principal,
            'order.increase',
            `position.leverage:${row.id}:${adjustmentId}`,
            businessPayload({
              positionId: row.id,
              adjustmentId,
              size,
              entryPrice,
              currentMargin,
              target,
              leverage: input.leverage,
              assetId: row.margin_asset,
            }),
          );
        }

        const delta = target - currentMargin;
        const prevSeq = Number(row.margin_adjust_seq);
        const seq = (Number.isFinite(prevSeq) && prevSeq >= 1 ? prevSeq : 1) + 1;

        if (delta > 0n) {
          this.refuseIfFuturesExposureOff();
          // Held until this transaction writes the new initial margin, so an opening order's check waits and counts it.
          await this.lockCollateral(tx, input.userId, row.margin_asset);
          const figures = await this.collateralForCredit(input.userId, row.margin_asset, tx);
          if (figures.free < delta) {
            throw new FuturesError(
              `need ${formatAmount(delta)} ${row.margin_asset} extra isolated margin, have ${formatAmount(figures.free)}`,
              LEVERAGE_INSUFFICIENT_MARGIN,
              400,
            );
          }
          this.assertHaircutCredit(figures, delta);
          ledgerAttempted = true;
          await this.ledger.post(
            recipes.futuresMarginAdd({
              positionId: row.id,
              userId: input.userId,
              assetId: row.margin_asset,
              amount: delta,
              sequence: seq,
            }),
          );
        } else if (delta < 0n) {
          ledgerAttempted = true;
          await this.ledger.post(
            recipes.futuresMarginRelease({
              positionId: row.id,
              userId: input.userId,
              assetId: row.margin_asset,
              amount: -delta,
              sequence: seq,
            }),
          );
        }
        if (ledgerAttempted) await this.afterMarginLedgerPost?.(request);

        const [updated] = await tx<PositionRow[]>`
          UPDATE trade.positions p
          SET leverage = ${formatAmount(input.leverage)},
              margin_initial = ${formatAmount(target)},
              margin_current = ${formatAmount(target)},
              margin_adjust_seq = ${seq},
              margin_adjust_request = NULL,
              updated_at = now()
          FROM trade.markets m
          WHERE p.id = ${row.id}
            AND p.user_id = ${input.userId}
            AND p.status = 'open'
            AND m.id = p.market_id
          RETURNING p.*, m.symbol, m.contract_size
        `;
        if (!updated) {
          throw new FuturesError('position changed underneath this leverage update', 'trade.position_not_open', 409);
        }
        const result = presentPosition(updated);
        await tx`UPDATE trade.position_margin_adjustments
          SET status = 'completed', result = ${tx.json(result)}, completed_at = now()
          WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
        return updated;
      });

      if (!('user_id' in row)) return row;
      await this.publishPositionUpdated(row);
      return presentPosition(row);
    } catch (err) {
      if (!ledgerAttempted) await this.abandonMarginAdjustment(claimed, adjustmentId);
      if (isLockTimeout(err)) {
        throw new FuturesError(
          'another mutation of this position is already in flight — retry in a moment',
          'trade.close_in_progress',
          409,
        );
      }
      throw err;
    }
  }

  /**
   * Isolated extra collateral — `futuresMarginAdd` only. Does not change
   * leverage or IM, and does not flip margin mode. Add-only: amount must be > 0.
   */
  async addIsolatedMargin(input: AddIsolatedMarginInput): Promise<Position> {
    const collateralCheck = checkCollateralClassForMargin(input.collateralClass);
    if (!collateralCheck.ok) {
      throw new FuturesError(collateralCheck.reason, collateralCheck.code, 400);
    }
    if (input.amount <= 0n) {
      throw new FuturesError('isolated margin add must be a positive decimal amount', 'trade.bad_request', 400);
    }

    const symbol = input.symbol.trim();
    if (!symbol) {
      throw new FuturesError('symbol is required', 'trade.bad_request', 400);
    }

    const request = `add:${formatAmount(input.amount)}`;
    const adjustmentId = input.clientAdjustmentId?.trim() || request;
    const claimed = { ...input, symbol };
    const completed = await this.claimMarginAdjustment(claimed, adjustmentId, request);
    if (completed) return completed;
    let ledgerAttempted = false;
    try {
      const row = await this.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);

        const locked = input.positionId
          ? await tx<PositionRow[]>`
              SELECT p.*, m.symbol, m.contract_size
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.id = ${input.positionId} AND p.user_id = ${input.userId}
              LIMIT 1
              FOR UPDATE OF p
            `
          : await tx<PositionRow[]>`
              SELECT p.*, m.symbol, m.contract_size
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.user_id = ${input.userId}
                AND m.symbol = ${symbol}
                AND p.status = 'open'
              FOR UPDATE OF p
            `;

        if (input.positionId) {
          if (!locked[0]) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        } else if (locked.length === 0) {
          throw new FuturesError(`no open position on ${symbol}`, 'trade.position_not_found', 404);
        } else if (locked.length > 1) {
          throw new FuturesError(`more than one open position on ${symbol} — pass position id`, 'trade.position_ambiguous', 400);
        }

        const row = locked[0]!;
        if (row.symbol !== symbol) {
          throw new FuturesError(`position is on ${row.symbol}, not ${symbol}`, 'trade.symbol_mismatch', 400);
        }
        if (row.status !== 'open') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }
        if (row.margin_mode !== 'isolated') {
          throw new FuturesError('live margin add is isolated-only — margin mode is set at open', 'trade.cross_margin_unsupported', 400);
        }
        const replay = await this.completedMarginAdjustment(tx, row.id, adjustmentId, request);
        if (replay) return replay;
        await this.assertLiquidationHold(tx, row.id, 'add_margin');

        const currentMargin = parseAmount(row.margin_current ?? row.margin_initial);
        const nextMargin = currentMargin + input.amount;
        const prevSeq = Number(row.margin_adjust_seq);
        const seq = (Number.isFinite(prevSeq) && prevSeq >= 1 ? prevSeq : 1) + 1;

        const available = await this.ledger.balance(userAvailable(input.userId, row.margin_asset));
        if (available.amount < input.amount) {
          throw new FuturesError(
            `need ${formatAmount(input.amount)} ${row.margin_asset} extra isolated margin, have ${formatAmount(available.amount)}`,
            LEVERAGE_INSUFFICIENT_MARGIN,
            400,
          );
        }

        ledgerAttempted = true;
        await this.ledger.post(
          recipes.futuresMarginAdd({
            positionId: row.id,
            userId: input.userId,
            assetId: row.margin_asset,
            amount: input.amount,
            sequence: seq,
          }),
        );
        await this.afterMarginLedgerPost?.(request);

        const [updated] = await tx<PositionRow[]>`
          UPDATE trade.positions p
          SET margin_current = ${formatAmount(nextMargin)},
              margin_adjust_seq = ${seq},
              margin_adjust_request = NULL,
              updated_at = now()
          FROM trade.markets m
          WHERE p.id = ${row.id}
            AND p.user_id = ${input.userId}
            AND p.status = 'open'
            AND m.id = p.market_id
          RETURNING p.*, m.symbol, m.contract_size
        `;
        if (!updated) {
          throw new FuturesError('position changed underneath this margin add', 'trade.position_not_open', 409);
        }
        const result = presentPosition(updated);
        await tx`UPDATE trade.position_margin_adjustments
          SET status = 'completed', result = ${tx.json(result)}, completed_at = now()
          WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
        return updated;
      });

      if (!('user_id' in row)) return row;
      await this.publishPositionUpdated(row);
      return presentPosition(row);
    } catch (err) {
      if (!ledgerAttempted) await this.abandonMarginAdjustment(claimed, adjustmentId);
      if (isLockTimeout(err)) {
        throw new FuturesError(
          'another mutation of this position is already in flight — retry in a moment',
          'trade.close_in_progress',
          409,
        );
      }
      throw err;
    }
  }

  /**
   * Isolated excess collateral out — `futuresMarginRelease` only. Does not
   * change leverage or IM. Cannot pull below `margin_initial`. Refuses without
   * posting when the remaining isolated margin would already be in liquidation
   * at the current mark.
   */
  async reduceIsolatedMargin(input: ReduceIsolatedMarginInput): Promise<Position> {
    if (input.amount <= 0n) {
      throw new FuturesError('isolated margin reduce must be a positive decimal amount', 'trade.bad_request', 400);
    }

    const symbol = input.symbol.trim();
    if (!symbol) {
      throw new FuturesError('symbol is required', 'trade.bad_request', 400);
    }

    const request = `release:${formatAmount(input.amount)}`;
    const adjustmentId = input.clientAdjustmentId?.trim() || request;
    const claimed = { ...input, symbol };
    const completed = await this.claimMarginAdjustment(claimed, adjustmentId, request);
    if (completed) return completed;
    let ledgerAttempted = false;
    try {
      const row = await this.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);

        const locked = input.positionId
          ? await tx<PositionRow[]>`
              SELECT p.*, m.symbol, m.contract_size
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.id = ${input.positionId} AND p.user_id = ${input.userId}
              LIMIT 1
              FOR UPDATE OF p
            `
          : await tx<PositionRow[]>`
              SELECT p.*, m.symbol, m.contract_size
              FROM trade.positions p
              JOIN trade.markets m ON m.id = p.market_id
              WHERE p.user_id = ${input.userId}
                AND m.symbol = ${symbol}
                AND p.status = 'open'
              FOR UPDATE OF p
            `;

        if (input.positionId) {
          if (!locked[0]) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        } else if (locked.length === 0) {
          throw new FuturesError(`no open position on ${symbol}`, 'trade.position_not_found', 404);
        } else if (locked.length > 1) {
          throw new FuturesError(`more than one open position on ${symbol} — pass position id`, 'trade.position_ambiguous', 400);
        }

        const row = locked[0]!;
        if (row.symbol !== symbol) {
          throw new FuturesError(`position is on ${row.symbol}, not ${symbol}`, 'trade.symbol_mismatch', 400);
        }
        if (row.status !== 'open') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }
        if (row.margin_mode !== 'isolated') {
          throw new FuturesError('live margin reduce is isolated-only — margin mode is set at open', 'trade.cross_margin_unsupported', 400);
        }
        const replay = await this.completedMarginAdjustment(tx, row.id, adjustmentId, request);
        if (replay) return replay;
        await this.assertLiquidationHold(tx, row.id, 'reduce_margin');

        const currentMargin = parseAmount(row.margin_current ?? row.margin_initial);
        const initial = parseAmount(row.margin_initial);
        const nextMargin = currentMargin - input.amount;
        if (nextMargin < initial) {
          throw new FuturesError(
            `refusing to pull isolated margin below initial ${formatAmount(initial)} ${row.margin_asset}`,
            MARGIN_BELOW_INITIAL,
            400,
          );
        }

        const at = this.now();
        const mark = await this.markFor(row.market_id, row.symbol, at, parseAmount(row.size));
        if (await this.wouldBeLiquidatable(row, nextMargin, mark.price, `margin-reduce-gate:${row.id}`)) {
          throw new FuturesError(
            `refusing isolated margin reduce — remaining collateral would already be in liquidation at the current mark`,
            MARGIN_WOULD_LIQUIDATE,
            400,
          );
        }

        const prevSeq = Number(row.margin_adjust_seq);
        const seq = (Number.isFinite(prevSeq) && prevSeq >= 1 ? prevSeq : 1) + 1;

        ledgerAttempted = true;
        await this.ledger.post(
          recipes.futuresMarginRelease({
            positionId: row.id,
            userId: input.userId,
            assetId: row.margin_asset,
            amount: input.amount,
            sequence: seq,
          }),
        );
        await this.afterMarginLedgerPost?.(request);

        const [updated] = await tx<PositionRow[]>`
          UPDATE trade.positions p
          SET margin_current = ${formatAmount(nextMargin)},
              margin_adjust_seq = ${seq},
              margin_adjust_request = NULL,
              updated_at = now()
          FROM trade.markets m
          WHERE p.id = ${row.id}
            AND p.user_id = ${input.userId}
            AND p.status = 'open'
            AND m.id = p.market_id
          RETURNING p.*, m.symbol, m.contract_size
        `;
        if (!updated) {
          throw new FuturesError('position changed underneath this margin reduce', 'trade.position_not_open', 409);
        }
        const result = presentPosition(updated);
        await tx`UPDATE trade.position_margin_adjustments
          SET status = 'completed', result = ${tx.json(result)}, completed_at = now()
          WHERE position_id = ${row.id} AND client_adjustment_id = ${adjustmentId} AND status = 'pending'`;
        return updated;
      });

      if (!('user_id' in row)) return row;
      await this.publishPositionUpdated(row);
      return presentPosition(row);
    } catch (err) {
      if (!ledgerAttempted) await this.abandonMarginAdjustment(claimed, adjustmentId);
      if (isLockTimeout(err)) {
        throw new FuturesError(
          'another mutation of this position is already in flight — retry in a moment',
          'trade.close_in_progress',
          409,
        );
      }
      throw err;
    }
  }

  /**
   * Close an open position at the CURRENT MARK — read from the mark port, never
   * supplied by the trader being paid.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WHY THIS IS A TRANSACTION AND NOT A SEQUENCE OF STATEMENTS
   * ───────────────────────────────────────────────────────────────────────────
   *
   * It used to be: `SELECT … status='open'` → read the mark → check the bound →
   * `ledger.post` × N → `UPDATE … status='closed'`. Every one of those steps was
   * correct on its own and the whole was a money drain, because there was no
   * lock, no transaction, and the idempotency key was minted per ATTEMPT:
   *
   *     closeId: `close:${row.id}:${randomUUID()}`
   *
   * `futuresRealizeProfit` keys on `futures.profit:${profitId}`, so a fresh UUID
   * per attempt meant the ledger had no way to recognise a duplicate and every
   * concurrent DELETE was a genuinely new payout. `futuresMarginRelease` keys on
   * `positionId:sequence`, so the margin release WAS deduped — which is why only
   * the profit multiplied, and why counting successful responses would have
   * shown nothing wrong.
   *
   * Eight concurrent closes of one position paid 5000 of honest PnL eight times.
   * The payout bound did not save it: each attempt read the pot's balance before
   * any of them had drained it, so the ceiling landed on the pot's whole balance
   * instead of on the honest PnL. That is the ADR's sentence failing again in a
   * new costume — *a price that moves money is never supplied by the party it
   * pays* — because the party being paid still chose the amount, this time
   * through N rather than through `exitPrice`.
   *
   * The window needs a yield between reading the row and writing it, and
   * production always has one: `markFor()` is an HTTP round trip.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * TWO MECHANISMS, AND BOTH ARE LOAD-BEARING
   * ───────────────────────────────────────────────────────────────────────────
   *
   * **`SELECT … FOR UPDATE` inside a transaction that spans the posts and the
   * status write.** Concurrent closes of one position serialise on the row: the
   * first commits, the rest are released, re-read the row they were waiting on,
   * find it `closed` and refuse — before they post anything. This works across
   * replicas, which an in-process mutex would not, and the lock is on ONE row so
   * closes of other positions are unaffected.
   *
   * **An idempotency key derived from the position, not from the attempt.**
   * `closeId` is now `close:${row.id}` — stable. A lock only orders attempts
   * that overlap in time, and the sequential form of this bug does not: put the
   * row back to `open` by a replay, a restore or an operator's UPDATE and a
   * second close races nothing at all. The stable key is what stops that one,
   * and it is also what covers the gap the transaction cannot close by itself —
   * the ledger is a different system, so a commit that fails after the posts
   * succeeded leaves the row open with the money already moved, and the retry
   * must not pay again. It does not: the ledger returns the original
   * transaction for the SAME body. A retry whose body differs (the live mark or margin moved)
   * is a mismatch: logged in the ledger's `detect` mode, refused 409 in `refuse` mode.
   * Freezing the close plan before the first post is the open item for that flip.
   *
   * Neither mechanism subsumes the other, so reverting either one is caught by
   * `position-close-concurrency.test.ts`.
   *
   * Nothing posts until every refusal has been cleared, and a refusal rolls the
   * transaction back: a close that is going to be refused leaves the books and
   * the row exactly as it found them.
   */
  async close(userId: string, positionId: string): Promise<Position> {
    const outcome = await this.closeAtomically(userId, positionId);
    if (!outcome.extras.replayed) await this.publishPositionUpdated(outcome.row, outcome.extras);
    return this.presentListed(outcome.row, outcome.extras);
  }

  private async closeAtomically(userId: string, positionId: string): Promise<{ row: PositionRow; extras: PresentExtras }> {
    try {
      return await this.sql.begin(async (tx) => {
        // Bounded, so a wedged ledger call cannot pin one pooled connection per
        // queued attempt for as long as it likes. LOCAL — it dies with the
        // transaction and never leaks onto the next borrower of this connection.
        // `unsafe` because SET does not take a bind parameter. The interpolated
        // value is a module constant integer — no caller input reaches this.
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);

        /**
         * `FOR UPDATE OF p` — the POSITION row only. Locking the joined market
         * row as well would serialise every close on that market against every
         * other, which is a throughput bug wearing a correctness costume.
         *
         * Under READ COMMITTED a waiter re-reads the row after the lock frees,
         * so it sees `status = 'closed'` written by the transaction it was
         * queued behind, not the stale `open` it originally matched.
         */
        const [row] = await tx<PositionRow[]>`
          SELECT p.*, m.symbol, m.contract_size
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.id = ${positionId} AND p.user_id = ${userId}
          LIMIT 1
          FOR UPDATE OF p
        `;
        if (!row) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        if (row.status === 'closed') {
          const storedMark =
            row.accepted_mark == null || row.accepted_mark.trim() === '' ? null : formatAmount(parseAmount(row.accepted_mark));
          return {
            row,
            extras: {
              replayed: true,
              markPrice: storedMark,
              markReason: storedMark == null ? 'mark_missing' : null,
            },
          };
        }
        if (row.status !== 'open' && row.status !== 'closing') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }
        if (row.status === 'open' && this.matched.matchingEnabled) this.refuseCloseAtMark();
        // Under the row lock, before the mark read and before anything posts: a trader may not
        // close out from under a live rung or a parked position (see `assertLiquidationHold`).
        await this.assertLiquidationHold(tx, row.id, 'close');
        this.assertNoPendingMarginAdjustment(row);

        /**
         * THE STAKE, TAKEN OFF THE LOCKED ROW.
         *
         * `row.size` — the position as the platform wrote it, read inside the
         * same `FOR UPDATE` as the close it is about to gate. Not the request:
         * the DELETE that reaches this method carries a position id and nothing
         * else, and `docs/adr/2026-08-05-futures-risk-and-mark-law.md` would
         * forbid it if it did. *A price that moves money is never supplied by
         * the party it pays* — and the size that decides which prices are
         * ACCEPTED is part of that price.
         *
         * This is the number the depth requirement is a fraction of. A close of
         * 500 contracts must find a book that can absorb a defined slice of 500
         * contracts, not a book that clears a fixed floor set for a book that
         * might have been pricing anything at all.
         */
        const at = this.now();
        const authorisesSize = parseAmount(row.size);
        const markOrDark = await this.tryMarkForMarking(row.market_id, row.symbol, at, authorisesSize);

        /**
         * EXIT WHEN THE FEED IS DARK.
         *
         * Valuing is something the platform does TO a trader — refuse without a
         * mark. Releasing is something the trader asks for — without a mark the
         * platform may not price the exit, but it also may not keep them in the
         * trade. Freeze: no funding, no liquidation, settle later.
         * ADR: `docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`.
         */
        if (!markOrDark.ok) {
          if (row.status === 'closing') {
            // Idempotent retry while still dark — same row, not an error.
            return { row, extras: { markPrice: null, realizedPnl: null } };
          }
          const [frozen] = await tx<PositionRow[]>`
            UPDATE trade.positions p
            SET status = 'closing',
                closing_reason = ${markOrDark.reason},
                updated_at = now()
            FROM trade.markets m
            WHERE p.id = ${positionId}
              AND p.user_id = ${userId}
              AND p.status = 'open'
              AND m.id = p.market_id
            RETURNING p.*, m.symbol, m.contract_size
          `;
          if (!frozen) {
            throw new FuturesError('position changed underneath this close', 'trade.position_not_open', 409);
          }
          return { row: frozen, extras: { markPrice: null, realizedPnl: null } };
        }

        const mark = markOrDark.mark;

        /**
         * The breaker's basis, read off the row this transaction already holds
         * under `FOR UPDATE`. Not a second query: it has to be the same row, the
         * same lock and the same snapshot as the close it is judging, or two
         * concurrent closes could each be measured against a basis the other one
         * had already moved.
         */
        const previous = readAcceptedMark(row);

        /**
         * CLOSING SETTLES AT FREEZE-TIME `accepted_mark` (Denon handoff 2026-08-09
         * §§3–4; ADR 2026-08-07 property 2).
         *
         * A `closing` row means the trader already asked to leave while the feed
         * was dark. Charging (or paying) the move that happened during our outage
         * is mark-driven loss/gain after exit. The current mark only *triggers*
         * settlement (feed is usable again); the exit price is the last basis we
         * already accepted on this position. Fail closed if that basis is missing
         * (pre-0007 rows) rather than inventing a price from the fresh mark.
         */
        const settlingFromClosing = row.status === 'closing';
        let exitPrice: string;
        if (settlingFromClosing) {
          if (row.accepted_mark == null || row.accepted_mark.trim() === '') {
            throw new FuturesError(
              'closing position has no accepted_mark to settle at — refuse invent from current mark',
              'trade.closing_basis_missing',
              503,
            );
          }
          exitPrice = formatAmount(parseAmount(row.accepted_mark));
        } else {
          exitPrice = formatAmount(mark.price);
        }

        const plan = planClose({
          // STABLE, not per attempt. See the header — this is half the fix.
          closeId: closeIdFor(row.id),
          position: {
            positionId: row.id,
            userId,
            side: row.side,
            size: parseAmount(row.size),
            entryPrice: parseAmount(row.entry_price),
            margin: parseAmount(row.margin_current ?? row.margin_initial),
            marginAsset: row.margin_asset,
          },
          exitPrice,
        });
        if (!plan.close) {
          throw new FuturesError(`cannot close: ${plan.reason}`, 'trade.close_refused', 400);
        }

        if (plan.profit > 0n) {
          // Money is about to leave the platform on the strength of this mark, so it
          // has to be a mark we would seize on — except when settling from
          // `closing` at freeze-time accepted_mark: that basis was already gated
          // when stored, and the current mid-gap mark must not re-price the exit
          // (breaker trap / dark-period charge — Denon §§3–4).
          if (!settlingFromClosing) {
            this.requirePayoutGrade(mark, previous, at);
          }

          /**
           * NO NAMED POT, NO PAYOUT. The deployment never chose an account for
           * realised profit, so there is nothing to pay from and nothing to
           * bound — and paying from an unnamed one is exactly what the ADR
           * forbids. The trader is not trapped: a losing or flat close is
           * untouched by this branch and still returns their margin.
           */
          if (this.deps.profitSource == null) {
            throw new FuturesError(
              `Cannot realise ${formatAmount(plan.profit)} ${row.margin_asset} of profit — ${PROFIT_SOURCE_UNCONFIGURED}`,
              'trade.profit_source_unconfigured',
              403,
            );
          }

          // No payout bound refusal here: `postClosePlan` pays the profit from the
          // clearing pot if it holds it, or records it as owed
          // (docs/adr/2026-10-20-futures-matched-traders.md section 4).
        }

        /**
         * INSURANCE SHORTFALL BOUND (voluntary close). Same law as the
         * liquidation tick: a loss past margin is not cover the house invents.
         * Checked before the first post so a refusal cannot leave margin moved
         * and the position half-closed.
         */
        if (plan.fromInsurance > 0n) {
          const insurance = await checkInsuranceBound({
            assetId: row.margin_asset,
            fromInsurance: plan.fromInsurance,
            balance: (ref) => this.ledger.balance(ref),
          });
          if (!insurance.ok) {
            throw new FuturesError(`Cannot close through insurance shortfall — ${insurance.reason}`, INSURANCE_UNDERFUNDED, 409);
          }
        }

        await this.postClosePlan(tx, { userId, positionId: row.id, assetId: row.margin_asset, posts: plan.recipes });

        /**
         * `accepted_mark` moves here and nowhere else on this path — INSIDE the
         * transaction, after every refusal has been cleared. That is what makes
         * the breaker unratchetable: a close that is refused rolls this write
         * back with the rest of the transaction, so a caller cannot walk the
         * basis upward in sub-breaker steps by making attempts that fail. The
         * basis only ever moves to a mark the platform actually settled on.
         *
         * Settling from `closing` clears `closing_reason` with the status write.
         * `accepted_mark` records the exit we actually settled at (freeze basis
         * when closing; current mark on ordinary open→closed).
         */
        const [closed] = await tx<PositionRow[]>`
          UPDATE trade.positions p
          SET status = 'closed',
              closed_at = now(),
              updated_at = now(),
              closing_reason = NULL,
              accepted_mark = ${exitPrice},
              accepted_mark_at = ${at}
          FROM trade.markets m
          WHERE p.id = ${positionId}
            AND p.user_id = ${userId}
            AND p.status IN ('open', 'closing')
            AND m.id = p.market_id
          RETURNING p.*, m.symbol, m.contract_size
        `;
        /**
         * Unreachable while the lock holds — and asserted rather than assumed,
         * because if it ever became reachable the money would already have moved
         * and the row would still say `open`/`closing`. Throwing rolls the status
         * write back; the ledger posts stand, and the stable close key means the
         * retry that follows settles them once, not twice.
         */
        if (!closed) {
          throw new FuturesError('position changed underneath this close', 'trade.position_not_open', 409);
        }

        return {
          row: closed,
          extras: {
            markPrice: formatAmount(plan.exitPrice),
            realizedPnl: formatAmount(plan.realizedPnl),
          },
        };
      });
    } catch (err) {
      if (isLockTimeout(err)) {
        throw new FuturesError('another close of this position is already in flight — retry in a moment', 'trade.close_in_progress', 409);
      }
      throw err;
    }
  }

  /**
   * WHILE MATCHED MODE IS ON, NO AT-MARK CLOSE (futures ADR slice 6b).
   *
   * With matching on, every position comes from a fill between two traders, and the clearing pot pays a winner only
   * what some other trader lost (ADR section 3). A close at the mark has no counterparty: it would shrink one side
   * of the market and pay from the pot with nobody on the other side, breaking long size = short size. So a close
   * goes through a reduce-only matched order instead. Liquidation rungs and ADL keep their own paths. A row already
   * `closing` (it asked to leave while the feed was dark, before the switch) still settles at its frozen mark.
   */
  private refuseCloseAtMark(): never {
    throw new FuturesError(
      'closing at the mark is retired while futures orders go through the matching engine — place a reduce-only order',
      'trade.futures_close_at_mark_retired',
      409,
    );
  }

  /**
   * Post a close plan: the profit leg first through `payOrOweProfit` (paid from
   * the clearing pot, or owed until it holds it), then every other leg in plan
   * order. Runs under the position row lock, inside the close transaction.
   */
  private async postClosePlan(
    tx: TransactionSql,
    input: { userId: string; positionId: string; assetId: string; posts: readonly PostRequest[] },
  ): Promise<void> {
    const profitLeg = profitLegOf(input.posts);
    if (profitLeg) {
      await payOrOweProfit({
        tx,
        ledger: this.ledger,
        profitId: profitLeg.idempotencyKey.slice('futures.profit:'.length),
        positionId: input.positionId,
        userId: input.userId,
        assetId: input.assetId,
        amount: profitLeg.entries[0]!.amount,
      });
    }
    for (const recipe of input.posts) {
      if (recipe !== profitLeg) await this.ledger.post(recipe);
    }
  }

  /** Fan-out for private WS — honest nulls for mark/PnL until known. */
  private async publishPositionUpdated(
    row: PositionRow,
    extras?: { markPrice?: string | null; realizedPnl?: string | null },
  ): Promise<void> {
    if (!this.bus) return;
    const size = parseAmount(row.size);
    const entry = parseAmount(row.entry_price);
    const SCALE = 10n ** 18n;
    const notional = (size * entry) / SCALE;
    const ts = new Date().toISOString();
    await this.bus.publish(
      'positionUpdated',
      {
        positionId: row.id,
        userId: row.user_id,
        marketId: row.market_id,
        symbol: row.symbol,
        status: row.status,
        side: row.side,
        contracts: formatAmount(size),
        entryPrice: formatAmount(entry),
        markPrice: extras?.markPrice ?? null,
        notional: formatAmount(notional),
        leverage: row.leverage == null ? null : formatAmount(parseAmount(row.leverage)),
        collateral: formatAmount(parseAmount(row.margin_current ?? row.margin_initial)),
        unrealizedPnl: null,
        realizedPnl: extras?.realizedPnl ?? null,
        liquidationPrice: row.liq_price != null ? formatAmount(parseAmount(row.liq_price)) : null,
        marginMode: row.margin_mode,
        fundingPaid: formatAmount(parseAmount(row.funding_paid ?? '0')),
        closingReason: row.status === 'closing' ? (row.closing_reason ?? null) : null,
        ts,
      },
      { idempotencyKey: `trade.position.updated:${row.id}:${row.status}:${ts}` },
    );
  }

  /**
   * Reduce-only open. Shrinks an opposite position by at most its size and
   * never opens or enlarges. The flag is stored on `futures_open_requests`
   * before the decision, including a refusal.
   */
  private async reduceOnlyOpen(input: OpenPositionInput): Promise<Position> {
    const clientOpenId = input.clientOpenId?.trim() ?? '';
    if (clientOpenId.length === 0 || clientOpenId.length > 64) {
      throw new FuturesError(
        'clientOpenId is required (1–64 chars) — omit would double-lock margin on retry',
        'trade.client_open_id_required',
        400,
      );
    }
    const market = await this.sql<{ id: string; symbol: string; kind: string; lot_size: string }[]>`
      SELECT id, symbol, kind, lot_size FROM trade.markets WHERE symbol = ${input.symbol} LIMIT 1
    `;
    const m = market[0];
    if (!m) throw new FuturesError(`unknown market ${input.symbol}`, 'trade.market_not_found', 404);
    if (m.kind !== 'futures') {
      throw new FuturesError(`market ${input.symbol} is ${m.kind}, not futures`, 'trade.not_futures_market', 400);
    }

    const stored = await this.sql<{ reduce_only: boolean; outcome: ReduceOnlyOutcome | null }[]>`
      SELECT reduce_only, outcome FROM trade.futures_open_requests
      WHERE user_id = ${input.userId} AND market_id = ${m.id} AND client_open_id = ${clientOpenId}
    `;
    if (stored[0]?.outcome) return replayReduceOnly(stored[0].outcome);
    if (!stored[0]) {
      await this.sql`
        INSERT INTO trade.futures_open_requests (user_id, market_id, client_open_id, reduce_only)
        VALUES (${input.userId}, ${m.id}, ${clientOpenId}, true)
        ON CONFLICT (user_id, market_id, client_open_id) DO NOTHING
      `;
      const again = await this.sql<{ outcome: ReduceOnlyOutcome | null }[]>`
        SELECT outcome FROM trade.futures_open_requests
        WHERE user_id = ${input.userId} AND market_id = ${m.id} AND client_open_id = ${clientOpenId}
      `;
      if (again[0]?.outcome) return replayReduceOnly(again[0].outcome);
    }

    const refuse = async (code: string, message: string): Promise<never> => {
      const outcome: ReduceOnlyOutcome = { refused: true, code, message };
      await this.sql`
        UPDATE trade.futures_open_requests
        SET outcome = ${this.sql.json(outcome as never)}
        WHERE user_id = ${input.userId} AND market_id = ${m.id} AND client_open_id = ${clientOpenId}
          AND outcome IS NULL
      `;
      throw new FuturesError(message, code, 400);
    };

    if (input.size <= 0n) return refuse('trade.size_invalid', `size must be greater than zero, got ${formatAmount(input.size)}`);

    const opposite = input.side === 'long' ? 'short' : 'long';
    const rows = await this.sql<(PositionRow & { lot_size: string })[]>`
      SELECT p.*, m.symbol, m.contract_size, m.lot_size
      FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id
      WHERE p.user_id = ${input.userId} AND p.market_id = ${m.id} AND p.status = 'open' AND p.side = ${opposite}
      LIMIT 1
    `;
    const target = rows[0];
    if (!target) {
      return refuse('trade.reduce_only_would_increase', 'reduce-only would open or enlarge a position');
    }
    const size = parseAmount(target.size);
    const quantity = input.size > size ? size : input.size;
    const lot = checkCloseQuantity({ quantity, size, lotSize: parseAmount(target.lot_size) });
    if (!lot.ok) return refuse(lot.code, lot.reason);

    const position = await this.closeQuantity(input.userId, target.id, { quantity, clientCloseId: clientOpenId });
    const outcome: ReduceOnlyOutcome = { refused: false, position };
    await this.sql`
      UPDATE trade.futures_open_requests
      SET outcome = ${this.sql.json(outcome as never)}
      WHERE user_id = ${input.userId} AND market_id = ${m.id} AND client_open_id = ${clientOpenId}
    `;
    return position;
  }

  /** Partial or full close keyed by `clientCloseId`. Quantity equal to the size is a full close. */
  async closeQuantity(userId: string, positionId: string, input: { quantity: Amount; clientCloseId: string }): Promise<Position> {
    const clientCloseId = input.clientCloseId.trim();
    if (clientCloseId.length === 0 || clientCloseId.length > 160) {
      throw new FuturesError('clientCloseId is required (1–160 chars)', 'trade.client_close_id_required', 400);
    }
    const outcome = await this.closePartialAtomically(userId, positionId, { quantity: input.quantity, clientCloseId });
    if ('replay' in outcome) return outcome.replay;
    await this.publishPositionUpdated(outcome.row, outcome.extras);
    return presentPosition(outcome.row, outcome.extras);
  }

  private async closePartialAtomically(
    userId: string,
    positionId: string,
    partial: { quantity: Amount; clientCloseId: string },
  ): Promise<{ replay: Position } | { row: PositionRow; extras: { markPrice: string | null; realizedPnl: string | null } }> {
    try {
      return await this.sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = ${CLOSE_LOCK_TIMEOUT_MS}`);
        await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${partial.clientCloseId}))`;
        const prior = await tx<{ result: Position }[]>`
          SELECT result FROM trade.position_close_intents
          WHERE user_id = ${userId} AND client_close_id = ${partial.clientCloseId}
        `;
        if (prior[0]) return { replay: prior[0].result };

        const [row] = await tx<(PositionRow & { lot_size: string | null })[]>`
          SELECT p.*, m.symbol, m.contract_size, m.lot_size
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          WHERE p.id = ${positionId} AND p.user_id = ${userId}
          LIMIT 1
          FOR UPDATE OF p
        `;
        if (!row) throw new FuturesError('position not found', 'trade.position_not_found', 404);
        const again = await tx<{ result: Position }[]>`
          SELECT result FROM trade.position_close_intents
          WHERE user_id = ${userId} AND client_close_id = ${partial.clientCloseId}
        `;
        if (again[0]) return { replay: again[0].result };
        if (row.status !== 'open' && row.status !== 'closing') {
          throw new FuturesError(`position is ${row.status}`, 'trade.position_not_open', 400);
        }
        if (row.status === 'open' && this.matched.matchingEnabled) this.refuseCloseAtMark();
        await this.assertLiquidationHold(tx, row.id, 'close');
        this.assertNoPendingMarginAdjustment(row);

        const size = parseAmount(row.size);
        const lotCheck = checkCloseQuantity({
          quantity: partial.quantity,
          size,
          lotSize: row.lot_size == null ? null : parseAmount(row.lot_size),
        });
        if (!lotCheck.ok) throw new FuturesError(lotCheck.reason, lotCheck.code, 400);

        /**
         * A `closing` row already asked to leave at freeze-time `accepted_mark`
         * (ADR 2026-08-07 property 2). A smaller slice would settle the outage
         * move and overwrite that basis for the remainder. Only the full size
         * is accepted, and it posts nothing until that full close is priced.
         */
        const settlingFromClosing = row.status === 'closing';
        if (settlingFromClosing && partial.quantity !== size) {
          throw new FuturesError(
            'position is waiting to exit at its frozen mark; only a full close is accepted',
            'trade.position_closing_full_only',
            400,
          );
        }

        const at = this.now();
        const markOrDark = await this.tryMarkForMarking(row.market_id, row.symbol, at, partial.quantity);
        if (!markOrDark.ok) {
          throw new FuturesError(markOrDark.detail, markOrDark.reason, 409);
        }
        const previous = readAcceptedMark(row);
        /**
         * The fresh mark only triggers settlement once the feed is usable again.
         * The exit price stays the freeze basis. A blank basis refuses rather
         * than inventing a price from the mark that just came back.
         */
        let exitPrice: string;
        if (settlingFromClosing) {
          if (row.accepted_mark == null || row.accepted_mark.trim() === '') {
            throw new FuturesError(
              'closing position has no accepted_mark to settle at — refuse invent from current mark',
              'trade.closing_basis_missing',
              503,
            );
          }
          exitPrice = formatAmount(parseAmount(row.accepted_mark));
        } else {
          exitPrice = formatAmount(markOrDark.mark.price);
        }
        const margin = parseAmount(row.margin_current ?? row.margin_initial);
        const marginInitial = parseAmount(row.margin_initial);
        const releaseSequence = partial.quantity === size ? 1 : Number(row.margin_adjust_seq) + 1;
        const closeId = partial.quantity === size ? closeIdFor(row.id) : `close:${row.id}:${partial.clientCloseId}`;
        const plan = planProportionalClose({
          closeId,
          positionId: row.id,
          userId,
          side: row.side,
          size,
          closeQty: partial.quantity,
          entryPrice: parseAmount(row.entry_price),
          exitPrice: parseAmount(exitPrice),
          margin,
          marginInitial,
          marginAsset: row.margin_asset,
          releaseSequence,
        });
        if (!plan.close) throw new FuturesError(plan.reason, plan.code, 400);

        if (plan.profit > 0n) {
          // Freeze-time accepted_mark was gated when stored. The mark that
          // unlocked this close must not re-price the payout (Denon §§3–4).
          if (!settlingFromClosing) {
            this.requirePayoutGrade(markOrDark.mark, previous, at);
          }
          if (this.deps.profitSource == null) {
            throw new FuturesError(
              `Cannot realise ${formatAmount(plan.profit)} ${row.margin_asset} of profit — ${PROFIT_SOURCE_UNCONFIGURED}`,
              'trade.profit_source_unconfigured',
              403,
            );
          }
          // No payout bound refusal here: `postClosePlan` pays the profit from the
          // clearing pot if it holds it, or records it as owed
          // (docs/adr/2026-10-20-futures-matched-traders.md section 4).
        }
        if (plan.fromInsurance > 0n) {
          const insurance = await checkInsuranceBound({
            assetId: row.margin_asset,
            fromInsurance: plan.fromInsurance,
            balance: (ref) => this.ledger.balance(ref),
          });
          if (!insurance.ok) {
            throw new FuturesError(`Cannot close through insurance shortfall — ${insurance.reason}`, INSURANCE_UNDERFUNDED, 409);
          }
        }
        await this.postClosePlan(tx, { userId, positionId: row.id, assetId: row.margin_asset, posts: plan.recipes });

        const closedFull = plan.full;
        const [updated] = closedFull
          ? await tx<PositionRow[]>`
              UPDATE trade.positions p
              SET status = 'closed', closed_at = now(), updated_at = now(), closing_reason = NULL,
                  accepted_mark = ${exitPrice}, accepted_mark_at = ${at}
              FROM trade.markets m
              WHERE p.id = ${positionId} AND p.user_id = ${userId} AND p.status IN ('open', 'closing') AND m.id = p.market_id
              RETURNING p.*, m.symbol, m.contract_size
            `
          : await tx<PositionRow[]>`
              UPDATE trade.positions p
              SET size = ${formatAmount(plan.figures.remainQty)},
                  margin_current = ${formatAmount(plan.figures.remainMargin)},
                  margin_initial = ${formatAmount(plan.figures.remainInitial)},
                  margin_adjust_seq = ${releaseSequence},
                  accepted_mark = ${exitPrice},
                  accepted_mark_at = ${at},
                  updated_at = now()
              FROM trade.markets m
              WHERE p.id = ${positionId} AND p.user_id = ${userId} AND p.status IN ('open', 'closing') AND m.id = p.market_id
              RETURNING p.*, m.symbol, m.contract_size
            `;
        if (!updated) throw new FuturesError('position changed underneath this close', 'trade.position_not_open', 409);
        const presented = presentPosition(updated, {
          markPrice: formatAmount(plan.exitPrice),
          realizedPnl: formatAmount(plan.realizedPnl),
        });
        await tx`
          INSERT INTO trade.position_close_intents (user_id, client_close_id, position_id, quantity, result)
          VALUES (
            ${userId},
            ${partial.clientCloseId},
            ${positionId},
            ${formatAmount(partial.quantity)},
            ${tx.json(presented as never)}
          )
        `;
        return {
          row: updated,
          extras: { markPrice: formatAmount(plan.exitPrice), realizedPnl: formatAmount(plan.realizedPnl) },
        };
      });
    } catch (err) {
      if (isLockTimeout(err)) {
        throw new FuturesError('another close of this position is already in flight — retry in a moment', 'trade.close_in_progress', 409);
      }
      throw err;
    }
  }

  /**
   * Close each of the caller's open positions in order. One position's refusal
   * does not roll another back. A replay of `clientBatchId` returns the stored
   * batch and posts nothing.
   */
  async closeAll(userId: string, input: { clientBatchId: string; market?: string }): Promise<CloseAllResult> {
    const clientBatchId = input.clientBatchId.trim();
    if (clientBatchId.length === 0 || clientBatchId.length > 64) {
      throw new FuturesError('clientBatchId is required (1–64 chars)', 'trade.client_batch_id_required', 400);
    }
    const stored = await this.sql<{ result: CloseAllResult }[]>`
      SELECT result FROM trade.position_close_batches
      WHERE user_id = ${userId} AND client_batch_id = ${clientBatchId}
    `;
    if (stored[0]) return stored[0].result;
    // Refused whole, before a batch is stored: a retry once the switch is off is a new close, not a stored refusal.
    if (this.matched.matchingEnabled) this.refuseCloseAtMark();

    const market = input.market?.trim() || undefined;
    const open = await this.listOpen(userId, market);
    const ordered = [...open].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    const results: CloseAllItem[] = [];
    for (const pos of ordered) {
      if (!pos.id) continue;
      const [row] = await this.sql<(PositionRow & { lot_size: string | null })[]>`
        SELECT p.*, m.symbol, m.contract_size, m.lot_size
        FROM trade.positions p
        JOIN trade.markets m ON m.id = p.market_id
        WHERE p.id = ${pos.id} AND p.user_id = ${userId}
        LIMIT 1
      `;
      if (!row || (row.status !== 'open' && row.status !== 'closing')) {
        results.push({ positionId: pos.id, status: 'refused', code: 'trade.position_not_open', reason: 'position is not open' });
        continue;
      }
      const mark = await this.tryMarkForMarking(row.market_id, row.symbol, this.now(), parseAmount(row.size));
      if (!mark.ok) {
        results.push({ positionId: pos.id, status: 'refused', code: mark.reason, reason: mark.detail });
        continue;
      }
      try {
        const closed = await this.closeQuantity(userId, pos.id, {
          quantity: parseAmount(row.size),
          clientCloseId: `${clientBatchId}:${pos.id}`,
        });
        results.push({
          positionId: pos.id,
          status: 'closed',
          realizedPnl: closed.realizedPnl,
          contracts: closed.contracts,
        });
      } catch (err) {
        const code = err instanceof FuturesError ? err.code : 'trade.close_refused';
        const reason = err instanceof Error ? err.message : 'close refused';
        results.push({ positionId: pos.id, status: 'refused', code, reason });
      }
    }
    const body: CloseAllResult = { results };
    await this.sql`
      INSERT INTO trade.position_close_batches (user_id, client_batch_id, market, result)
      VALUES (${userId}, ${clientBatchId}, ${market ?? null}, ${this.sql.json(body as never)})
      ON CONFLICT (user_id, client_batch_id) DO NOTHING
    `;
    const written = await this.sql<{ result: CloseAllResult }[]>`
      SELECT result FROM trade.position_close_batches
      WHERE user_id = ${userId} AND client_batch_id = ${clientBatchId}
    `;
    return written[0]?.result ?? body;
  }

  async marginSummary(userId: string): Promise<MarginSummary> {
    const rows = await this.sql<PositionRow[]>`
      SELECT p.*, m.symbol, m.contract_size
      FROM trade.positions p
      JOIN trade.markets m ON m.id = p.market_id
      WHERE p.user_id = ${userId} AND p.status IN ('open', 'closing')
    `;
    let haircutBps: number | null = null;
    try {
      haircutBps = requireOwnerHaircutBps(readOwnerHaircutBps());
    } catch {
      haircutBps = null;
    }
    const assets = new Set(rows.map((row) => row.margin_asset));
    let available: string | null = null;
    if (assets.size === 1) {
      const asset = [...assets][0]!;
      available = formatAmount((await this.ledger.balance(userAvailable(userId, asset))).amount);
    }
    return summarizeMargin({
      positions: rows.map((row) => ({
        initialMargin: row.margin_initial,
        maintenanceMargin: null,
        collateral: row.margin_current ?? row.margin_initial,
        unrealizedPnl: null,
      })),
      available,
      haircutBps,
    });
  }

  async readAccountMode(userId: string): Promise<AccountModeRead> {
    const rows = await this.sql<{ mode: 'one_way' | 'hedge'; client_mode_id: string }[]>`
      SELECT mode, client_mode_id FROM trade.account_position_modes WHERE user_id = ${userId}
    `;
    const row = rows[0];
    const stored: StoredAccountMode | null = row ? { mode: row.mode, source: 'stored', clientModeId: row.client_mode_id } : null;
    return presentAccountMode(stored);
  }

  async writeAccountMode(userId: string, input: { mode: unknown; clientModeId: string }): Promise<AccountModeRead> {
    const clientModeId = input.clientModeId.trim();
    if (clientModeId.length === 0 || clientModeId.length > 64) {
      throw new FuturesError('clientModeId is required (1–64 chars)', 'trade.client_mode_id_required', 400);
    }
    const currentRows = await this.sql<{ mode: 'one_way' | 'hedge'; client_mode_id: string }[]>`
      SELECT mode, client_mode_id FROM trade.account_position_modes WHERE user_id = ${userId}
    `;
    const openRows = await this.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trade.positions
      WHERE user_id = ${userId} AND status IN ('open', 'closing')
    `;
    const decision = decideModeWrite({
      current: currentRows[0]?.mode ?? null,
      next: input.mode,
      openPositionCount: Number(openRows[0]?.n ?? '0'),
      sameClientKey: currentRows[0]?.client_mode_id === clientModeId,
    });
    if (!decision.ok) throw new FuturesError(decision.reason, decision.code, 400);
    if (decision.changed) {
      await this.sql`
        INSERT INTO trade.account_position_modes (user_id, mode, source, client_mode_id)
        VALUES (${userId}, ${decision.mode}, 'stored', ${clientModeId})
        ON CONFLICT (user_id) DO UPDATE
          SET mode = EXCLUDED.mode, source = 'stored', client_mode_id = EXCLUDED.client_mode_id, updated_at = now()
      `;
    }
    return this.readAccountMode(userId);
  }

  /**
   * List, get, and a close response. Mark comes from `tryMarkForMarking` unless
   * the caller already priced this row (the close that just posted). A missing
   * or unusable mark is null with a reason. Never a zero stand-in.
   */
  private async presentListed(row: PositionRow, extras?: PresentExtras): Promise<Position> {
    let markPrice = extras?.markPrice;
    let markReason = extras?.markReason ?? null;
    if (markPrice === undefined) {
      const got = await this.tryMarkForMarking(row.market_id, row.symbol, this.now(), parseAmount(row.size));
      if (!got.ok) {
        markPrice = null;
        markReason = got.reason === 'trade.mark_missing' ? 'mark_missing' : 'mark_unusable';
      } else {
        markPrice = formatAmount(got.mark.price);
        markReason = null;
      }
    }
    let maintenanceMargin = extras?.maintenanceMargin;
    let maintenanceReason = extras?.maintenanceReason ?? null;
    let liquidationPrice = extras?.liquidationPrice;
    let liquidationReason = extras?.liquidationReason ?? null;
    // A settled row has no maintenance requirement. Do not read depth for it.
    if (row.status === 'closed' || row.status === 'liquidated') {
      maintenanceMargin = null;
      maintenanceReason = 'position_closed';
      liquidationPrice = null;
      liquidationReason = 'position_closed';
    } else if (maintenanceMargin === undefined) {
      if (markPrice == null) {
        maintenanceMargin = null;
        maintenanceReason = markReason;
        liquidationPrice = null;
        liquidationReason = markReason;
      } else {
        const maint = await this.maintenanceAt(row, parseAmount(markPrice));
        maintenanceMargin = maint.amount;
        maintenanceReason = maint.reason;
        liquidationPrice = maint.liquidationPrice;
        liquidationReason = maint.liquidationReason;
      }
    }
    return presentPosition(row, {
      ...extras,
      markPrice,
      markReason,
      maintenanceMargin,
      maintenanceReason,
      ...(liquidationPrice === undefined ? {} : { liquidationPrice, liquidationReason }),
    });
  }

  /**
   * Same `planLadderRung` the liquidation tick plans with. No copied ladder. The liquidation price is read from the
   * same policy and depth (`liquidation-price.ts`), so the two figures describe one ladder.
   */
  private async maintenanceAt(
    row: PositionRow,
    markPrice: Amount,
  ): Promise<{ amount: string | null; reason: string | null; liquidationPrice: string | null; liquidationReason: string | null }> {
    const none = (reason: string) => ({ amount: null, reason, liquidationPrice: null, liquidationReason: reason });
    const ladder = this.deps.ladder;
    if (!ladder?.policy) return none('maintenance_policy_unset');
    let depthNotional: Amount | null;
    try {
      depthNotional = await ladder.depth.depthNotional({ marketId: row.market_id, side: row.side, symbol: row.symbol });
    } catch (err) {
      if (err instanceof FuturesLadderError) return none(err.code);
      return none('depth_unknown');
    }
    if (depthNotional == null || depthNotional <= 0n) return none('depth_unknown');
    try {
      const margin = parseAmount(row.margin_current ?? row.margin_initial);
      const liq = liquidationPriceFor({
        side: row.side,
        size: parseAmount(row.size),
        entryPrice: parseAmount(row.entry_price),
        margin,
        depthNotional,
        policy: ladder.policy,
      });
      const liquidation =
        liq.price === null
          ? { liquidationPrice: null, liquidationReason: liq.reason }
          : { liquidationPrice: formatAmount(liq.price), liquidationReason: null };
      const rung = planLadderRung({
        position: {
          positionId: row.id,
          userId: row.user_id,
          side: row.side,
          size: parseAmount(row.size),
          entryPrice: parseAmount(row.entry_price),
          margin: parseAmount(row.margin_current ?? row.margin_initial),
          marginAsset: row.margin_asset,
        },
        markPrice,
        depthNotional,
        policy: ladder.policy,
      });
      if (rung.action === 'refuse') return { amount: null, reason: rung.reason, ...liquidation };
      return { amount: formatAmount(rung.maintenanceRequired), reason: null, ...liquidation };
    } catch (err) {
      if (err instanceof FuturesLadderError) return none(err.code);
      throw err;
    }
  }
}

type ReduceOnlyOutcome = { refused: true; code: string; message: string } | { refused: false; position: Position };

function replayReduceOnly(outcome: ReduceOnlyOutcome): Position {
  if (outcome.refused) throw new FuturesError(outcome.message, outcome.code, 400);
  return outcome.position;
}

export interface CloseAllItem {
  readonly positionId: string;
  readonly status: 'closed' | 'refused';
  readonly code?: string;
  readonly reason?: string;
  readonly realizedPnl?: string | null;
  readonly contracts?: string | null;
}

export interface CloseAllResult {
  readonly results: readonly CloseAllItem[];
}

function isoOf(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** The customer position view. Exported so the support summary presents a position exactly as the customer's own list does. */
export function presentPosition(row: PositionRow, extras?: PresentExtras): Position {
  // A position closed by reduce fills through the book keeps the size of its last remainder on the row; what it closed
  // in all is the sum of those fills, which is the size a closed position reports.
  const size = extras?.closedSize != null ? parseAmount(extras.closedSize) : parseAmount(row.size);
  const entry = parseAmount(row.entry_price);
  const leverage = row.leverage == null ? null : parseAmount(row.leverage);
  // W4 R6: collateral = residual margin; initialMargin stays the open stake.
  // After funding debits, margin_current drops while margin_initial does not —
  // reporting both as residual lied to every client risk view.
  const marginCurrent = parseAmount(row.margin_current ?? row.margin_initial);
  const marginInitial = parseAmount(row.margin_initial);
  const SCALE = 10n ** 18n;
  const notional = (size * entry) / SCALE;
  const opened = row.opened_at instanceof Date ? row.opened_at : new Date(row.opened_at);
  // A stored price wins; otherwise the ladder's price at today's depth, when the caller read one.
  const liq = row.liq_price != null ? formatAmount(parseAmount(row.liq_price)) : (extras?.liquidationPrice ?? null);

  const markPrice = extras?.markPrice === undefined ? null : extras.markPrice;
  let markReason = extras?.markReason ?? null;
  if (markPrice != null) markReason = null;
  else if (markReason == null) {
    if (row.status === 'closing' && row.closing_reason === 'trade.mark_unusable') markReason = 'mark_unusable';
    else if (row.status === 'closing') markReason = 'mark_missing';
    else if (extras?.markPrice === undefined) markReason = 'mark_not_read';
    else markReason = 'mark_missing';
  }

  const settled = row.status === 'closed' || row.status === 'liquidated';

  let unrealized: Amount | null = null;
  let unrealizedReason: string | null = null;
  if (settled) unrealizedReason = 'position_closed';
  else if (markPrice == null) unrealizedReason = markReason;
  else {
    unrealized = unrealizedPnl(row.side, size, entry, parseAmount(markPrice));
  }

  let percentage: string | null = null;
  let percentageReason: string | null = null;
  if (settled) percentageReason = 'position_closed';
  else if (unrealized == null) percentageReason = unrealizedReason;
  else if (marginInitial <= 0n) percentageReason = 'initial_margin_missing';
  else percentage = formatAmount(positionPercentage(unrealized, marginInitial));

  let maintenanceMargin = extras?.maintenanceMargin === undefined ? null : extras.maintenanceMargin;
  let maintenanceReason = extras?.maintenanceReason ?? null;
  if (settled) {
    maintenanceMargin = null;
    maintenanceReason = 'position_closed';
  } else if (maintenanceMargin != null) maintenanceReason = null;
  else if (maintenanceReason == null) maintenanceReason = markReason;

  let contractSize: string | null = null;
  let contractReason: string | null = null;
  if (row.contract_size == null || row.contract_size.trim() === '') contractReason = 'contract_size_not_recorded';
  else contractSize = formatAmount(parseAmount(row.contract_size));

  const closedAt = isoOf(row.closed_at);
  let closedReason: string | null = null;
  if ((row.status === 'closed' || row.status === 'liquidated') && closedAt == null) closedReason = 'closed_at_not_recorded';

  const updatedAt = isoOf(row.updated_at);
  const updatedReason = updatedAt == null ? 'updated_at_not_recorded' : null;

  let realizedPnl = extras?.realizedPnl === undefined ? null : extras.realizedPnl;
  let realizedReason: string | null = null;
  if (extras?.realizedPnl !== undefined) {
    realizedReason =
      realizedPnl == null ? (row.status === 'closed' || row.status === 'liquidated' ? 'realized_pnl_not_recorded' : 'not_realized') : null;
  } else if (row.status === 'closed') {
    if (row.accepted_mark == null || row.accepted_mark.trim() === '') realizedReason = 'realized_pnl_not_recorded';
    else realizedPnl = formatAmount(unrealizedPnl(row.side, size, entry, parseAmount(row.accepted_mark)));
  } else if (row.status === 'liquidated') {
    // Liquidation writes no exit price and no realised figure. accepted_mark is the tick mark.
    realizedReason = 'realized_pnl_not_recorded';
  } else {
    realizedReason = 'not_realized';
  }

  const fieldReasons: Record<string, string> = {};
  if (markPrice == null && markReason) fieldReasons.markPrice = markReason;
  if (maintenanceMargin == null && maintenanceReason) fieldReasons.maintenanceMargin = maintenanceReason;
  if (liq == null) {
    const liquidationReason = settled ? 'position_closed' : (extras?.liquidationReason ?? maintenanceReason);
    if (liquidationReason) fieldReasons.liquidationPrice = liquidationReason;
  }
  if (unrealized == null && unrealizedReason) fieldReasons.unrealizedPnl = unrealizedReason;
  if (percentage == null && percentageReason) fieldReasons.percentage = percentageReason;
  if (contractSize == null && contractReason) fieldReasons.contractSize = contractReason;
  if (realizedPnl == null && realizedReason) fieldReasons.realizedPnl = realizedReason;
  if (closedAt == null && closedReason) fieldReasons.closedAt = closedReason;
  if (extras?.fees === null) fieldReasons.fees = 'fees_not_recorded';
  if (updatedAt == null && updatedReason) fieldReasons.updatedAt = updatedReason;

  return {
    id: row.id,
    symbol: row.symbol,
    timestamp: opened.getTime(),
    datetime: opened.toISOString(),
    openedAt: opened.toISOString(),
    clientOpenId: row.client_open_id ?? null,
    side: row.side,
    status: row.status,
    closingReason: row.status === 'closing' ? (row.closing_reason ?? null) : null,
    contracts: formatAmount(size),
    contractSize,
    entryPrice: formatAmount(entry),
    markPrice,
    notional: formatAmount(notional),
    leverage: leverage == null ? null : formatAmount(leverage),
    leverageReason: leverage == null ? 'leverage_not_recorded' : null,
    collateral: formatAmount(marginCurrent),
    initialMargin: formatAmount(marginInitial),
    maintenanceMargin,
    unrealizedPnl: unrealized == null ? null : formatAmount(unrealized),
    realizedPnl,
    liquidationPrice: liq,
    marginMode: row.margin_mode,
    percentage,
    closedAt,
    updatedAt,
    ...(extras?.fees !== undefined ? { fees: extras.fees } : {}),
    ...(extras?.replayed === true ? { replayed: true } : {}),
    fieldReasons,
  };
}

/**
 * Stored futures entry is the size-weighted average of opening fills.
 * A reducing fill leaves that price. A caller-supplied price is not stored.
 */
export function storedEntryAfterFill(
  position: { readonly size: Amount; readonly entryPrice: Amount },
  fill: { readonly effect: 'open' | 'reduce'; readonly qty: Amount; readonly price: Amount },
): { size: Amount; entryPrice: Amount } {
  if (fill.qty <= 0n) {
    throw new FuturesError(`fill qty must be greater than zero, got ${formatAmount(fill.qty)}`, 'trade.size_invalid', 400);
  }
  if (fill.effect === 'reduce') {
    if (fill.qty > position.size) {
      throw new FuturesError('a reducing fill is larger than the position', 'trade.size_invalid', 400);
    }
    return { size: (position.size - fill.qty) as Amount, entryPrice: position.entryPrice };
  }
  if (fill.price <= 0n) {
    throw new FuturesError('an opening fill needs a positive price', 'trade.invalid_price', 400);
  }
  const newSize = (position.size + fill.qty) as Amount;
  if (position.size === 0n) return { size: newSize, entryPrice: fill.price };
  const entry = ((position.size * position.entryPrice + fill.qty * fill.price) / newSize) as Amount;
  return { size: newSize, entryPrice: entry };
}

export function entryFromOpeningFills(
  fills: readonly { readonly qty: Amount; readonly price: Amount }[],
  callerPrice?: Amount,
): { size: Amount; entryPrice: Amount } {
  if (callerPrice != null && fills.length === 0) {
    throw new FuturesError('a caller-supplied price is not stored as the entry', 'trade.invalid_price', 400);
  }
  let position: { size: Amount; entryPrice: Amount } = { size: 0n as Amount, entryPrice: 0n as Amount };
  for (const fill of fills) {
    position = storedEntryAfterFill(position, { effect: 'open', qty: fill.qty, price: fill.price });
  }
  return position;
}

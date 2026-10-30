import type { Amount } from '@intafaced/ledger-client';
import type { OrderSide } from '../spot/types.js';

/**
 * ALGO PARENT (D-S-04) — a schedule, not an order.
 *
 * Doctrine load-bearing sentence (`docs/adr/2026-08-04-algo-execution-law.md`):
 * the parent holds no balance, no fill, and no P&L. Everything real happens on
 * a child order that went to the book like any other. Progress is a SUM of
 * child fills, never a number the scheduler computed.
 *
 * There is deliberately no `filledQty`, `avgPrice`, `holdAmount`, `pnl`, or
 * `progressPct` field on the parent. Those would be the fabrication surface.
 */

export type AlgoKind = 'twap' | 'vwap' | 'pov' | 'chase';

export type AlgoStatus = 'active' | 'paused' | 'cancelled' | 'completed' | 'halted';

/**
 * Why the wall schedule was stretched past the original plan from `startedAt`.
 * User pause and tick outage share the same re-space mechanics; the trader is
 * owed the distinction (ADR 2026-08-08).
 */
export type AlgoScheduleStretchReason = 'user_pause' | 'tick_outage';

/** Why a slice did not become a fill — surfaced, never silent. */
export type AlgoMissCode =
  | 'trade.algo_no_liquidity'
  | 'trade.algo_price_band'
  | 'trade.algo_mark_unusable'
  | 'trade.algo_mark_missing'
  | 'trade.algo_insufficient_balance'
  | 'trade.algo_market_closed'
  | 'trade.algo_principal_unavailable'
  | 'trade.algo_child_refused'
  | 'trade.algo_no_volume';

export interface AlgoChildRef {
  readonly sliceIndex: number;
  readonly orderId: string;
  readonly clientOrderId: string;
  /** Schedule qty for this slice — not a fill. */
  readonly qty: Amount;
  readonly placedAt: Date;
  /** POV only: the volume or book size the participation rate was applied to for this slice. */
  readonly basisQty?: Amount | null;
  /** Chase only: the limit price this child rests at. */
  readonly price?: Amount | null;
}

/**
 * What a POV participation rate is applied to: the taker volume traded in the last interval, or the resting
 * quantity on the opposite side of the book (the side the child would take from).
 */
export type PovBasis = 'traded_volume' | 'opposite_liquidity';
export const POV_BASES: readonly PovBasis[] = ['traded_volume', 'opposite_liquidity'];

export interface AlgoMiss {
  readonly sliceIndex: number;
  readonly code: AlgoMissCode;
  readonly reason: string;
  readonly at: Date;
}

/**
 * Impoverished parent. Schedule + children + misses + status. Nothing else.
 */
export interface TwapParent {
  readonly id: string;
  readonly userId: string;
  readonly subAccountId: string | null;
  readonly marketId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly kind: AlgoKind;
  /** Total quantity the schedule intends to emit across all slices. Not a balance. */
  readonly totalQty: Amount;
  readonly durationMs: number;
  readonly sliceIntervalMs: number;
  /**
   * Optional limit band for child limit orders.
   * Buy: child price must be ≤ this. Sell: child price must be ≥ this.
   * Null = market IOC children (still refuse on empty book / bad mark).
   */
  readonly limitPrice: Amount | null;
  readonly status: AlgoStatus;
  readonly createdAt: Date;
  /** Immutable original start. Never re-derived as a due-time basis after stretch. */
  readonly startedAt: Date;
  /**
   * Earliest instant the next slice may be placed.
   * Re-spaced from the actual place/miss/resume/outage event — not from
   * `startedAt + index * interval` (ADR 2026-08-08: the interval is the promise).
   */
  readonly nextDueAt: Date;
  /**
   * Projected wall-clock end of the remaining schedule after last re-space.
   * Updated on create, resume, place, miss, and tick-outage stretch.
   */
  readonly projectedEndsAt: Date;
  /**
   * Last reason the schedule was stretched past wall-clock from `startedAt`.
   * Null until the first pause-resume or tick outage.
   */
  readonly scheduleStretchReason: AlgoScheduleStretchReason | null;
  readonly pausedAt: Date | null;
  readonly haltReason: string | null;
  /**
   * Market lot at create — POV snaps live qty to this. Null on pre-VWAP rows.
   */
  readonly lotSize: Amount | null;
  /**
   * POV only — caller-published bps of observed interval volume.
   * Null on TWAP/VWAP. Never a product default.
   */
  readonly participationBps: number | null;
  /** POV only: what the participation rate is applied to. Null or absent on TWAP/VWAP and on rows from before it. */
  readonly povBasis?: PovBasis | null;
  readonly slicesPlanned: number;
  /** Next slice index to emit (0-based). Resume does not rewind elapsed slices. */
  readonly nextSliceIndex: number;
  readonly children: readonly AlgoChildRef[];
  readonly misses: readonly AlgoMiss[];
  /** TWAP only: the seed that fixed random slice sizes. Null or absent: even sizes. */
  readonly randomSeed?: number | null;
  /**
   * Optional start price. While `triggeredAt` is null the parent places nothing; the first tick whose accepted mark
   * reaches this price starts the schedule from that instant. Null or absent: it starts at create.
   */
  readonly triggerPrice?: Amount | null;
  /** True when the trigger was above the mark at create, so it is reached when the mark rises to it. */
  readonly triggerAbove?: boolean | null;
  readonly triggeredAt?: Date | null;
  /**
   * Chase only: how far, in bps of `chaseStartPrice`, the child may follow the book. Caller-published; a blank
   * distance refuses at create. Null or absent on other kinds.
   */
  readonly chaseMaxDistanceBps?: number | null;
  /** Chase only: the best same-side price read at create. The distance is measured from it. */
  readonly chaseStartPrice?: Amount | null;
}

/** True while a parent with a trigger price has not seen the price reach it. */
export function awaitingTrigger(parent: Pick<TwapParent, 'triggerPrice' | 'triggeredAt'>): boolean {
  return parent.triggerPrice != null && parent.triggeredAt == null;
}

/**
 * User-visible progress. `filledQty` is ONLY the sum of real child fills
 * supplied by the caller — the parent never invents it.
 */
export interface AlgoProgressView {
  readonly parentId: string;
  readonly status: AlgoStatus;
  readonly haltReason: string | null;
  /** Documented stop reason (CB-bots-01); null unless the parent stopped on its own. */
  readonly stopReason: import('./stop-reason.js').AlgoStopReason | null;
  readonly childrenEmitted: number;
  readonly missesRecorded: number;
  readonly slicesPlanned: number;
  readonly nextSliceIndex: number;
  /** Decimal string — sum of child fill qtys. Zero when no fills, never a schedule %. */
  readonly filledQty: string;
  readonly totalQty: string;
  /** Stored next due time while status is active. Null otherwise. Not a price. */
  readonly nextSliceAt: string | null;
  /** Whether the slice loop is alive. Not a balance. */
  readonly scheduler: {
    readonly running: boolean | null;
    readonly reason: 'jobs_disabled' | 'heartbeat_unknown' | 'heartbeat_stale' | 'jobs_interval_unset' | null;
  };
}

export interface CreateTwapInput {
  readonly marketId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly totalQty: Amount;
  readonly durationMs: number;
  readonly sliceIntervalMs: number;
  readonly limitPrice: Amount | null;
  readonly subAccountId: string | null;
  readonly clientAlgoId?: string;
  readonly kind?: AlgoKind;
  /** Observed lookback volumes for VWAP (same length as slice count). */
  readonly volumeProfile?: readonly Amount[];
  /** Required for POV. Integer 1..10000. */
  readonly participationBps?: number;
  /** POV only. Absent means traded volume. */
  readonly povBasis?: PovBasis;
  /** POV with opposite-side liquidity: the opposite side's resting quantity read at create. */
  readonly oppositeBookQty?: Amount;
  /** TWAP only: fixes random slice sizes. */
  readonly randomSeed?: number;
  /** Start price, and whether it lay above the mark at create (the service reads the mark). */
  readonly triggerPrice?: Amount;
  readonly triggerAbove?: boolean;
  /** Chase only. Integer 1..10000; absent refuses. */
  readonly chaseMaxDistanceBps?: number;
  /** Chase only: the best same-side price the service read at create. */
  readonly chaseStartPrice?: Amount;
}

/** Mark feed for algo halt gates — same vocabulary as prices.ts / futures mark-policy. */
export type AlgoMarkQuality = 'mid' | 'last' | 'index';

export interface AlgoQuotedMark {
  readonly marketId: string;
  readonly price: Amount;
  readonly asOf: Date;
  readonly quality: AlgoMarkQuality;
}

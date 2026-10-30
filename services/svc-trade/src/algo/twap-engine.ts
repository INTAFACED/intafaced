import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError, type OrderSide } from '../spot/types.js';
import { acceptableForAlgo, algoMarkMissing, withinPriceBand, type AlgoMarkPolicy, DEFAULT_ALGO_MARK_POLICY } from './mark-gate.js';
import { planTwapSlices } from './schedule.js';
import { planPovSliceQty, planVwapSlices, sliceCount } from './volume-plan.js';
import type {
  AlgoChildRef,
  AlgoMiss,
  AlgoMissCode,
  AlgoQuotedMark,
  AlgoScheduleStretchReason,
  CreateTwapInput,
  TwapParent,
} from './types.js';
import { awaitingTrigger, POV_BASES, type PovBasis } from './types.js';

/**
 * TWAP engine (D-S-04 v1) — schedule that emits child orders.
 *
 * No ledger posts. No parent holds. Children are placed only through the
 * injected `placeChild` port (TradeService.placeOrder in production).
 *
 * Cancel disposition (pinned): cancel in-flight children via `cancelChild`.
 * Status flips to cancelled only after every child cancel succeeds.
 *
 * Pause disposition (pinned): emit no further children; resume does not
 * re-run elapsed slices. Overdue slices re-space from the resume/outage
 * instant (ADR 2026-08-08): never more than one slice per sliceIntervalMs;
 * overdue work extends the schedule rather than bursting.
 */

/** haltReason when cancel partially failed — resume refused until re-cancel. */
export const CANCEL_INCOMPLETE_HALT = 'cancel_incomplete';

/** haltReason when a trigger price was not reached within the engine's longest schedule life — nothing was placed. */
export const TRIGGER_EXPIRED_HALT = 'trigger_expired';

/** haltReason when the book moved past a chase's maximum distance: the child was cancelled once and nothing replaced it. */
export const CHASE_MAX_DISTANCE_HALT = 'chase_max_distance';

/** haltReason when a chase's time ran out with quantity unfilled: the resting child was cancelled. */
export const CHASE_EXPIRED_HALT = 'chase_expired';

/**
 * haltReason when a chase's time ran out while a child that left the book on a cancel the engine could not answer was
 * still short of fills: the engine may have matched it in full, so the chase placed nothing over it, and what it
 * bought is what its fills show.
 */
export const CHASE_CHILD_UNACCOUNTED_HALT = 'chase_child_unaccounted';

/** What the chase reads of its children: the summed fills of all of them and which are still resting. */
export interface ChaseChildState {
  readonly filledQty: Amount;
  readonly openOrderIds: ReadonlySet<string>;
  /**
   * Children closed on a cancel the engine had no live order for, with fills short of their size: the engine may have
   * matched them in full, and the taker's settlement not have written the fills yet. Nothing is placed over them.
   */
  readonly unaccountedOrderIds: ReadonlySet<string>;
}

/** Whether `price` lies past `maxBps` of `start`, on the side a chase on `side` follows (up for a buy). */
export function beyondChaseDistance(side: OrderSide, start: Amount, price: Amount, maxBps: number): boolean {
  const moved = side === 'buy' ? price - start : start - price;
  return moved * 10_000n > start * BigInt(maxBps);
}

/** The furthest price a chase may rest at: `start` moved by `maxBps` in the direction it follows. */
export function chaseFurthestPrice(side: OrderSide, start: Amount, maxBps: number): Amount {
  const span = (start * BigInt(maxBps)) / 10_000n;
  return side === 'buy' ? start + span : start - span;
}

export interface PlaceChildRequest {
  readonly parentId: string;
  readonly sliceIndex: number;
  readonly clientOrderId: string;
  readonly marketId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly qty: Amount;
  readonly limitPrice: Amount | null;
  readonly subAccountId: string | null;
}

export interface PlaceChildResult {
  readonly orderId: string;
}

export interface TwapEnginePorts {
  placeChild(req: PlaceChildRequest): Promise<PlaceChildResult>;
  /** Cancel disposition for in-flight children on parent cancel. */
  cancelChild(orderId: string): Promise<void>;
  /**
   * Best opposing price for band check + liquidity probe.
   * Null / empty = no liquidity (record miss, do not invent fill).
   */
  bestOpposingPrice(marketId: string, side: OrderSide): Promise<Amount | null>;
  /** Mark feed. Null = halt (refuse invent). */
  markFor(marketId: string): Promise<AlgoQuotedMark | null>;
  /**
   * First accepted mark. The store writes it once. Called only after the
   * mark gate accepts. Optional so a test engine that does not record an
   * arrival still ticks.
   */
  recordArrivalMark?(parentId: string, mark: AlgoQuotedMark): Promise<unknown>;
  /**
   * Non-seeded taker volume in [from, to). POV only.
   * Omit or 0 → miss (never invent participation against an empty tape).
   */
  intervalTakerVolume?(marketId: string, from: Date, to: Date): Promise<Amount>;
  /**
   * Resting quantity on the side of the book a child on `side` would take from (asks for a buy). POV with the
   * opposite-side liquidity basis only; with a limit, only the levels the child could reach at it. Omit or 0 → miss (never
   * invent a book).
   */
  oppositeBookQty?(marketId: string, side: OrderSide, limitPrice: Amount | null): Promise<Amount>;
  /**
   * Chase only: summed fills of these child orders and which of them still rest. Omit → a chase halts rather than
   * guess what filled.
   */
  chaseChildState?(orderIds: readonly string[]): Promise<ChaseChildState>;
  /**
   * Chase only: the order this parent placed under `clientOrderId`, if one exists. Lets a chase adopt a child placed
   * just before a crash instead of placing over it. Omit → no adoption.
   */
  chaseChildByClientOrderId?(
    parent: TwapParent,
    clientOrderId: string,
  ): Promise<{ orderId: string; qty: Amount; price: Amount | null; placedAt: Date } | null>;
  now(): Date;
  randomId(): string;
}

export interface TwapEngineOptions {
  markPolicy?: AlgoMarkPolicy;
  /** Max duration (default 24h). */
  maxDurationMs?: number;
  /** Min slice interval (default 1s). */
  minSliceIntervalMs?: number;
  /**
   * Durable schedule hook (SQL store in production). Called after every
   * parent/plan mutation so process restart can resume. Never invents fills.
   */
  onChange?: (parent: TwapParent, plan: readonly Amount[]) => void | Promise<void>;
}

export type SliceTickResult =
  | { readonly kind: 'placed'; readonly child: AlgoChildRef }
  | { readonly kind: 'miss'; readonly miss: AlgoMiss }
  | { readonly kind: 'halted'; readonly reason: string; readonly code: AlgoMissCode }
  | {
      readonly kind: 'idle';
      readonly reason:
        | 'paused'
        | 'cancelled'
        | 'completed'
        | 'halted'
        | 'ahead_of_schedule'
        | 'awaiting_trigger'
        | 'no_book_move'
        | 'superseded'
        | 'adopted'
        | 'child_open'
        | 'awaiting_fills';
    }
  | { readonly kind: 'completed' };

/** Projected end from an event instant + remaining slice count (ADR formula). */
export function projectTwapEndsAt(fromMs: number, remainingSlices: number, sliceIntervalMs: number): Date {
  return new Date(fromMs + remainingSlices * sliceIntervalMs);
}

/** Whether a mark has reached a parent's trigger, on the side the trigger lay at create. */
export function triggerReached(parent: Pick<TwapParent, 'triggerPrice' | 'triggerAbove'>, mark: Amount): boolean {
  if (parent.triggerPrice == null) return true;
  return parent.triggerAbove ? mark >= parent.triggerPrice : mark <= parent.triggerPrice;
}

export class TwapEngine {
  private readonly parents = new Map<string, TwapParent>();
  /** Slice qty plans keyed by parent id. */
  private readonly plans = new Map<string, readonly Amount[]>();
  private readonly markPolicy: AlgoMarkPolicy;
  private readonly maxDurationMs: number;
  private readonly minSliceIntervalMs: number;
  private readonly onChange: ((parent: TwapParent, plan: readonly Amount[]) => void | Promise<void>) | null;
  /** The last save started per parent: each save waits for the one before, so the store keeps the newest state. */
  private readonly saves = new Map<string, Promise<void>>();

  constructor(
    private readonly ports: TwapEnginePorts,
    options: TwapEngineOptions = {},
  ) {
    this.markPolicy = options.markPolicy ?? DEFAULT_ALGO_MARK_POLICY;
    this.maxDurationMs = options.maxDurationMs ?? 86_400_000;
    this.minSliceIntervalMs = options.minSliceIntervalMs ?? 1_000;
    this.onChange = options.onChange ?? null;
  }

  get(parentId: string): TwapParent | undefined {
    return this.parents.get(parentId);
  }

  /** Restore a parent + plan after process restart (from durable store). */
  hydrate(parent: TwapParent, plan: readonly Amount[]): void {
    this.parents.set(parent.id, parent);
    this.plans.set(parent.id, plan);
  }

  planOf(parentId: string): readonly Amount[] | undefined {
    return this.plans.get(parentId);
  }

  listForUser(userId: string): TwapParent[] {
    return [...this.parents.values()].filter((p) => p.userId === userId);
  }

  create(userId: string, input: CreateTwapInput, lotSize: Amount): TwapParent {
    const { parent, plan } = this.prepare(userId, input, lotSize);
    this.hydrate(parent, plan);
    this.emitChange(parent);
    return parent;
  }

  /** Validate and freeze a proposal without publishing an unadmitted strategy. */
  /** The TWAP slice sizes `prepare` would plan for these numbers, under the same schedule bounds. Stores nothing. */
  previewTwapPlan(
    input: { totalQty: Amount; durationMs: number; sliceIntervalMs: number; randomSeed?: number | null },
    lotSize: Amount,
  ): readonly Amount[] {
    this.assertScheduleBounds(input.durationMs, input.sliceIntervalMs);
    return planTwapSlices({ ...input, lotSize, randomSeed: input.randomSeed ?? null }).slices;
  }

  private assertScheduleBounds(durationMs: number, sliceIntervalMs: number): void {
    if (durationMs > this.maxDurationMs) {
      throw new TradeError(`algo duration exceeds max ${this.maxDurationMs}ms`, 'trade.algo_invalid_schedule');
    }
    if (sliceIntervalMs < this.minSliceIntervalMs) {
      throw new TradeError(`algo sliceIntervalMs below min ${this.minSliceIntervalMs}ms`, 'trade.algo_invalid_schedule');
    }
  }

  prepare(userId: string, input: CreateTwapInput, lotSize: Amount): { parent: TwapParent; plan: readonly Amount[] } {
    this.assertScheduleBounds(input.durationMs, input.sliceIntervalMs);

    const clientAlgoId = typeof input.clientAlgoId === 'string' ? input.clientAlgoId.trim() : '';
    if (!clientAlgoId) {
      throw new TradeError('clientAlgoId is required so a retried create cannot start a second parent', 'trade.client_order_id_required');
    }
    if (input.limitPrice !== null && input.limitPrice <= 0n) {
      throw new TradeError('algo limitPrice must be strictly positive when set', 'trade.algo_price_band');
    }

    const kind = input.kind ?? 'twap';
    if (kind !== 'twap' && (input.randomSeed !== undefined || input.triggerPrice !== undefined)) {
      throw new TradeError('random sizes and a trigger price are TWAP options', 'trade.algo_invalid_schedule');
    }
    if (input.povBasis !== undefined && (kind !== 'pov' || !POV_BASES.includes(input.povBasis))) {
      throw new TradeError(
        'a participation basis is a POV option: traded volume or opposite-side liquidity',
        'trade.algo_invalid_schedule',
      );
    }
    if (kind !== 'chase' && (input.chaseMaxDistanceBps !== undefined || input.chaseStartPrice !== undefined)) {
      throw new TradeError('a maximum chase distance is a chase option', 'trade.algo_invalid_schedule');
    }
    if (input.triggerPrice !== undefined && (input.triggerPrice <= 0n || input.triggerAbove === undefined)) {
      throw new TradeError('a trigger price must be strictly positive and read against the mark at create', 'trade.algo_invalid_schedule');
    }
    let slices: readonly Amount[];
    let participationBps: number | null = null;
    let povBasis: PovBasis | null = null;
    let chaseMaxDistanceBps: number | null = null;
    let chaseStartPrice: Amount | null = null;

    if (kind === 'twap') {
      slices = planTwapSlices({
        totalQty: input.totalQty,
        durationMs: input.durationMs,
        sliceIntervalMs: input.sliceIntervalMs,
        lotSize,
        randomSeed: input.randomSeed ?? null,
      }).slices;
    } else if (kind === 'vwap') {
      const profile = input.volumeProfile;
      if (profile == null || profile.length === 0) {
        throw new TradeError(
          'VWAP requires an observed lookback volume profile — refuse rather than invent a curve',
          'trade.algo_volume_immature',
        );
      }
      slices = planVwapSlices({ totalQty: input.totalQty, volumes: profile, lotSize }).slices;
    } else if (kind === 'pov') {
      const bps = input.participationBps;
      if (bps == null || !Number.isInteger(bps) || bps < 1 || bps > 10_000) {
        throw new TradeError(
          'POV participationBps must be an integer 1..10000 — refuse rather than invent a participation rate',
          'trade.algo_invalid_schedule',
        );
      }
      participationBps = bps;
      povBasis = input.povBasis ?? 'traded_volume';
      const n = sliceCount(input.durationMs, input.sliceIntervalMs);
      slices = Array.from({ length: n }, () => 0n);
    } else if (kind === 'chase') {
      const bps = input.chaseMaxDistanceBps;
      if (bps === undefined) {
        throw new TradeError(
          'a chase needs a maximum chase distance — refuse rather than follow the book without a bound',
          'trade.algo_chase_distance_required',
        );
      }
      if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) {
        throw new TradeError('the maximum chase distance must be an integer 1..10000 bps', 'trade.algo_invalid_schedule');
      }
      if (input.limitPrice !== null) {
        throw new TradeError("a chase's bound is its maximum distance, not a limit price", 'trade.algo_invalid_schedule');
      }
      if (input.chaseStartPrice === undefined || input.chaseStartPrice <= 0n) {
        throw new TradeError('a chase starts from the best price on its own side, and none was read', 'trade.algo_mark_missing');
      }
      chaseMaxDistanceBps = bps;
      chaseStartPrice = input.chaseStartPrice;
      // One working order for the whole quantity: re-priced, never sliced.
      slices = [input.totalQty];
    } else {
      throw new TradeError(`algo kind "${String(kind)}" is not available`, 'trade.algo_unsupported_kind');
    }

    const now = this.ports.now();
    const id = `algo-${userId.slice(0, 8)}-${clientAlgoId}`;

    if (this.parents.has(id)) {
      throw new TradeError(`algo id ${id} already exists`, 'trade.algo_duplicate_id');
    }

    const parent: TwapParent = {
      id,
      userId,
      subAccountId: input.subAccountId,
      marketId: input.marketId,
      symbol: input.symbol,
      side: input.side,
      kind,
      totalQty: input.totalQty,
      durationMs: input.durationMs,
      sliceIntervalMs: input.sliceIntervalMs,
      limitPrice: input.limitPrice,
      status: 'active',
      createdAt: now,
      startedAt: now,
      nextDueAt: now,
      projectedEndsAt:
        kind === 'chase'
          ? new Date(now.getTime() + input.durationMs)
          : projectTwapEndsAt(now.getTime(), slices.length, input.sliceIntervalMs),
      scheduleStretchReason: null,
      pausedAt: null,
      haltReason: null,
      lotSize,
      participationBps,
      povBasis,
      slicesPlanned: slices.length,
      nextSliceIndex: 0,
      children: [],
      misses: [],
      randomSeed: input.randomSeed ?? null,
      triggerPrice: input.triggerPrice ?? null,
      triggerAbove: input.triggerAbove ?? null,
      triggeredAt: null,
      chaseMaxDistanceBps,
      chaseStartPrice,
    };

    return { parent, plan: slices };
  }

  pause(userId: string, parentId: string): TwapParent {
    const parent = this.requireOwner(userId, parentId);
    // A partial cancel already parked the schedule: the person asked to stop and a child may still be live, so the only
    // way forward is another cancel. Say that, rather than the bare state refusal.
    if (parent.haltReason === CANCEL_INCOMPLETE_HALT) {
      throw new TradeError(
        'cannot pause after a partial cancel — call cancel again until every child is cancelled',
        'trade.algo_cancel_incomplete',
      );
    }
    if (parent.status !== 'active') {
      throw new TradeError(`cannot pause algo in status ${parent.status}`, 'trade.algo_bad_state');
    }
    return this.replace(parentId, {
      ...parent,
      status: 'paused',
      pausedAt: this.ports.now(),
    });
  }

  resume(userId: string, parentId: string): TwapParent {
    const parent = this.requireOwner(userId, parentId);
    if (parent.status !== 'paused') {
      throw new TradeError(`cannot resume algo in status ${parent.status}`, 'trade.algo_bad_state');
    }
    // W4 C1 adversarial: cancel-fail parks the parent as paused with
    // haltReason cancel_incomplete. Resume must not re-arm placement while
    // open children may still be live — force re-cancel first.
    if (parent.haltReason === CANCEL_INCOMPLETE_HALT) {
      throw new TradeError(
        'cannot resume after a partial cancel — call cancel again until every child is cancelled',
        'trade.algo_cancel_incomplete',
      );
    }
    // Resume does NOT rewind nextSliceIndex — elapsed slices stay elapsed.
    // Re-space from the resume instant (ADR 2026-08-08): overdue work extends
    // the schedule; never catch up as a burst against startedAt.
    const plan = this.plans.get(parentId);
    if (!plan) throw new TradeError(`algo plan missing for ${parentId}`, 'trade.algo_not_found');

    const now = this.ports.now();
    // A chase is one working order with a fixed life: resume lets it follow the book again until that life ends.
    if (parent.kind === 'chase') {
      return this.replace(parentId, { ...parent, status: 'active', pausedAt: null, nextDueAt: now });
    }
    const remaining = plan.length - parent.nextSliceIndex;
    const projectedEndsAt = projectTwapEndsAt(now.getTime(), remaining, parent.sliceIntervalMs);
    // The schedule's span runs from its real start: the trigger instant when it had one. A parent still waiting for
    // its trigger has not started, so a pause cannot have stretched it.
    const spanMs = projectedEndsAt.getTime() - (parent.triggeredAt ?? parent.startedAt).getTime();
    if (!awaitingTrigger(parent) && spanMs > 2 * parent.durationMs) {
      throw new TradeError(
        `resume would more than double original duration (projected end ${projectedEndsAt.toISOString()}, started ${parent.startedAt.toISOString()}, durationMs ${parent.durationMs})`,
        'trade.algo_resume_extends_too_far',
      );
    }

    return this.replace(parentId, {
      ...parent,
      status: 'active',
      pausedAt: null,
      nextDueAt: now,
      projectedEndsAt,
      scheduleStretchReason: awaitingTrigger(parent) ? parent.scheduleStretchReason : 'user_pause',
    });
  }

  /**
   * Cancel: no further children. In-flight children are cancelled (one
   * disposition, every time). Status → cancelled ONLY after every child
   * cancel succeeds; a throw leaves the parent non-cancelled.
   */
  async cancel(userId: string, parentId: string): Promise<TwapParent> {
    const parent = this.requireOwner(userId, parentId);
    if (parent.status === 'cancelled') return parent;
    if (parent.status === 'completed') {
      throw new TradeError('cannot cancel a completed algo', 'trade.algo_bad_state');
    }

    // Collect all child cancels before any status flip. A cancel that does not
    // cancel is worse than a refused cancel — cancelChild must throw when an
    // open child cannot be cancelled (principal missing, venue refuse, …).
    const results = await Promise.allSettled(parent.children.map((child) => this.ports.cancelChild(child.orderId)));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      const first = failures[0]!.reason;
      const message = first instanceof Error ? first.message : String(first);
      // W4 C1: user asked to stop. Partial cancel must NOT leave the parent
      // `active` — the next job tick would place more children under a stop
      // that already failed once. Pause so tick idles; retry cancel later.
      // (Still not `cancelled` until every child cancel succeeds — that half
      // stays sealed from #1193.) haltReason marks cancel-incomplete so resume
      // cannot re-arm placement while children may still be live.
      if (parent.status === 'active' || parent.status === 'paused') {
        const parked: TwapParent = {
          ...parent,
          status: 'paused',
          pausedAt: this.ports.now(),
          haltReason: CANCEL_INCOMPLETE_HALT,
        };
        this.parents.set(parentId, parked);
        // Await durable park. Fire-and-forget onChange would let cancel reject
        // while listActive still shows the parent tradable — or a later save
        // of `cancelled` must never land if children are still live.
        await this.emitChange(parked);
      }
      throw new TradeError(
        `algo cancel refused: ${failures.length} of ${parent.children.length} child cancel(s) failed — parent left paused (re-cancel required; resume refused): ${message}`,
        first instanceof TradeError && first.code === 'trade.algo_principal_unavailable'
          ? 'trade.algo_principal_unavailable'
          : 'trade.algo_child_cancel_failed',
      );
    }

    return this.replace(parentId, {
      ...parent,
      status: 'cancelled',
      haltReason: null,
    });
  }

  /**
   * Emit the next due slice, or record a miss / halt.
   * Call on interval; skips when ahead of schedule or not active.
   */
  async tick(parentId: string): Promise<SliceTickResult> {
    const parent = this.parents.get(parentId);
    if (!parent) throw new TradeError(`algo ${parentId} not found`, 'trade.algo_not_found');

    // A paused chase still has a child resting: its expiry and its distance still end it.
    if (parent.status === 'paused' && parent.kind === 'chase' && parent.haltReason !== CANCEL_INCOMPLETE_HALT) {
      return this.tickChase(parent, false);
    }
    if (parent.status === 'paused') return { kind: 'idle', reason: 'paused' };
    if (parent.status === 'cancelled') return { kind: 'idle', reason: 'cancelled' };
    if (parent.status === 'halted') return { kind: 'idle', reason: 'halted' };
    if (parent.status === 'completed') return { kind: 'idle', reason: 'completed' };
    if (parent.kind === 'chase') return this.tickChase(parent, true);

    const plan = this.plans.get(parentId);
    if (!plan) throw new TradeError(`algo plan missing for ${parentId}`, 'trade.algo_not_found');

    if (parent.nextSliceIndex >= plan.length) {
      this.replace(parentId, { ...parent, status: 'completed' });
      return { kind: 'completed' };
    }

    const now = this.ports.now();
    let working = parent;
    if (awaitingTrigger(parent)) {
      // A trigger never reached does not keep the schedule alive past the longest life a schedule may have.
      if (now.getTime() - parent.createdAt.getTime() > this.maxDurationMs) {
        this.replace(parentId, { ...parent, status: 'halted', haltReason: TRIGGER_EXPIRED_HALT });
        return { kind: 'idle', reason: 'halted' };
      }
      // Nothing is placed until an accepted mark reaches the trigger. A blank or stale mark never starts it.
      const mark = await this.ports.markFor(parent.marketId);
      if (!mark || !acceptableForAlgo(mark, now, this.markPolicy).ok || !triggerReached(parent, mark.price)) {
        return { kind: 'idle', reason: 'awaiting_trigger' };
      }
      // Reached: the schedule starts now, its slices one interval apart from this instant.
      working = this.replace(parentId, {
        ...parent,
        triggeredAt: now,
        nextDueAt: now,
        projectedEndsAt: projectTwapEndsAt(now.getTime(), plan.length - parent.nextSliceIndex, parent.sliceIntervalMs),
      });
    }

    // ADR 2026-08-08: due time is nextDueAt (re-spaced), never startedAt+index*interval.
    if (now.getTime() < working.nextDueAt.getTime()) {
      return { kind: 'idle', reason: 'ahead_of_schedule' };
    }

    // Tick outage: active parent was overdue by more than one interval with no
    // user pause. Record distinguishable stretch, then place at most one slice
    // and re-space from this instant (same spacing rule as resume).
    const overdueBy = now.getTime() - working.nextDueAt.getTime();
    if (overdueBy > working.sliceIntervalMs) {
      const remaining = plan.length - working.nextSliceIndex;
      working = this.replace(parentId, {
        ...working,
        scheduleStretchReason: 'tick_outage' satisfies AlgoScheduleStretchReason,
        projectedEndsAt: projectTwapEndsAt(now.getTime(), remaining, working.sliceIntervalMs),
        // nextDueAt stays ≤ now so this tick may place; re-spaced after event.
      });
    }

    // Mark gate — blank/stale/invalid HALTS (D-S-04 refuse table).
    const mark = await this.ports.markFor(working.marketId);
    if (!mark) {
      const check = algoMarkMissing(working.marketId);
      return this.halt(working, check.reason!, 'trade.algo_mark_missing');
    }
    const markOk = acceptableForAlgo(mark, now, this.markPolicy);
    if (!markOk.ok) {
      const code: AlgoMissCode = markOk.code === 'trade.algo_mark_missing' ? 'trade.algo_mark_missing' : 'trade.algo_mark_unusable';
      return this.halt(working, markOk.reason!, code);
    }
    await this.ports.recordArrivalMark?.(working.id, mark);

    // Liquidity probe — empty book = miss, not invent fill.
    const opposing = await this.ports.bestOpposingPrice(working.marketId, working.side);
    if (opposing === null || opposing <= 0n) {
      return this.recordMiss(working, {
        sliceIndex: working.nextSliceIndex,
        code: 'trade.algo_no_liquidity',
        reason: `${working.symbol}: no opposing liquidity for slice ${working.nextSliceIndex} — recorded miss, no fill invented`,
        at: now,
      });
    }

    if (!withinPriceBand(working.side, opposing, working.limitPrice)) {
      return this.recordMiss(working, {
        sliceIndex: working.nextSliceIndex,
        code: 'trade.algo_price_band',
        reason:
          `${working.symbol}: opposing ${formatAmount(opposing)} outside limit band ` +
          `${working.limitPrice === null ? 'none' : formatAmount(working.limitPrice)} — slice skipped`,
        at: now,
      });
    }

    let qty = plan[working.nextSliceIndex]!;
    let basisQty: Amount | null = null;
    if (working.kind === 'pov') {
      const bps = working.participationBps;
      const lot = working.lotSize;
      if (bps == null || lot == null || lot <= 0n) {
        return this.halt(working, 'POV parent missing participationBps or lotSize — refuse rather than invent', 'trade.algo_child_refused');
      }
      let remaining = working.totalQty;
      for (const c of working.children) remaining -= c.qty;
      if (working.povBasis === 'opposite_liquidity') {
        basisQty = this.ports.oppositeBookQty ? await this.ports.oppositeBookQty(working.marketId, working.side, working.limitPrice) : 0n;
      } else {
        const to = now;
        const from = new Date(now.getTime() - working.sliceIntervalMs);
        basisQty = this.ports.intervalTakerVolume ? await this.ports.intervalTakerVolume(working.marketId, from, to) : 0n;
      }
      qty = planPovSliceQty({ intervalVolume: basisQty, participationBps: bps, remainingQty: remaining, lotSize: lot });
    }

    if (qty <= 0n) {
      const what = working.povBasis === 'opposite_liquidity' ? 'opposite-side book quantity' : 'non-seeded taker volume';
      return this.recordMiss(working, {
        sliceIndex: working.nextSliceIndex,
        code: 'trade.algo_no_volume',
        reason: `${working.symbol}: not enough ${what} for slice ${working.nextSliceIndex} — recorded miss, no fill invented`,
        at: now,
      });
    }
    const clientOrderId = `algo:${working.id}:${working.nextSliceIndex}`;

    try {
      const placed = await this.ports.placeChild({
        parentId: working.id,
        sliceIndex: working.nextSliceIndex,
        clientOrderId,
        marketId: working.marketId,
        symbol: working.symbol,
        side: working.side,
        qty,
        limitPrice: working.limitPrice,
        subAccountId: working.subAccountId,
      });

      const child: AlgoChildRef = {
        sliceIndex: working.nextSliceIndex,
        orderId: placed.orderId,
        clientOrderId,
        qty,
        placedAt: now,
        ...(basisQty !== null ? { basisQty } : {}),
      };

      const next = working.nextSliceIndex + 1;
      const remaining = plan.length - next;
      const updated: TwapParent = {
        ...working,
        nextSliceIndex: next,
        children: [...working.children, child],
        // Spacing from the actual place event — not startedAt.
        nextDueAt: new Date(now.getTime() + working.sliceIntervalMs),
        projectedEndsAt: projectTwapEndsAt(now.getTime() + working.sliceIntervalMs, remaining, working.sliceIntervalMs),
        status: next >= plan.length ? 'completed' : working.status,
      };
      this.parents.set(working.id, updated);
      this.emitChange(updated);
      return { kind: 'placed', child };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof TradeError && err.code === 'trade.algo_insufficient_balance'
          ? 'trade.algo_insufficient_balance'
          : err instanceof TradeError && err.code.startsWith('ledger')
            ? 'trade.algo_insufficient_balance'
            : 'trade.algo_child_refused';

      // Insufficient balance mid-schedule → HALT (refuse table).
      if (code === 'trade.algo_insufficient_balance' || message.toLowerCase().includes('insufficient')) {
        return this.halt(working, `insufficient balance mid-schedule: ${message}`, 'trade.algo_insufficient_balance');
      }

      // No authority to act → HALT, and do NOT consume the slice.
      //
      // A miss means "the market would not take this slice"; the schedule
      // advances because that slice's moment has passed. This is a different
      // thing: the venue cannot act for the caller AT ALL, and every remaining
      // slice will fail the same way. Recording it as a miss burned the entire
      // remaining schedule in `sliceIntervalMs × N` and left the parent
      // `completed` having placed nothing — an order silently destroyed by a
      // deploy, and "completed" is the wrong word for it.
      if (err instanceof TradeError && err.code === 'trade.algo_principal_unavailable') {
        return this.halt(working, message, 'trade.algo_principal_unavailable');
      }

      return this.recordMiss(working, {
        sliceIndex: working.nextSliceIndex,
        code: 'trade.algo_child_refused',
        reason: `child place refused: ${message}`,
        at: now,
      });
    }
  }

  /**
   * One chase step. The chase keeps one limit child at the best price on its own side (the best bid for a buy). When
   * someone else improves that price, it cancels the child and places the unfilled rest at the new best: one re-price
   * per book move. A move past the maximum distance from the start price stops the chase instead: the child is
   * cancelled once and nothing replaces it. A failed cancel never leads to a second order: the parent is parked as
   * cancel-incomplete, the same as a failed parent cancel.
   *
   * A paused chase (`follow` false) still ends at its expiry or its distance, cancelling its resting child, but does not
   * re-price. Every await re-reads the live parent: a cancel, pause or second tick that landed meanwhile wins, and a
   * child placed under it is recorded on the live parent and cancelled if that parent no longer runs.
   */
  private async tickChase(parent: TwapParent, follow: boolean): Promise<SliceTickResult> {
    const now = this.ports.now();
    const start = parent.chaseStartPrice ?? null;
    const bps = parent.chaseMaxDistanceBps ?? null;
    const lot = parent.lotSize;
    const readChildren = this.ports.chaseChildState;
    if (start === null || bps === null || lot === null || lot <= 0n || !readChildren) {
      return this.halt(
        parent,
        'chase parent missing its distance, start price, lot or child reader — refuse rather than guess',
        'trade.algo_child_refused',
      );
    }
    const superseded = (): SliceTickResult => ({
      kind: 'idle',
      reason: this.parents.get(parent.id)?.status === 'paused' ? 'paused' : 'superseded',
    });
    const ids = parent.children.map((c) => c.orderId);
    let state: ChaseChildState =
      ids.length > 0 ? await readChildren(ids) : { filledQty: 0n, openOrderIds: new Set<string>(), unaccountedOrderIds: new Set<string>() };
    if (this.parents.get(parent.id) !== parent) return superseded();
    if (parent.totalQty - state.filledQty <= 0n) {
      this.replace(parent.id, { ...parent, status: 'completed' });
      return { kind: 'completed' };
    }
    const open = parent.children.filter((c) => state.openOrderIds.has(c.orderId));
    const last = parent.children.length > 0 ? parent.children[parent.children.length - 1]! : null;
    const lastOpen = last !== null && state.openOrderIds.has(last.orderId);

    if (now.getTime() - parent.startedAt.getTime() >= parent.durationMs) {
      return this.stopChase(parent, open, state.unaccountedOrderIds.size > 0 ? CHASE_CHILD_UNACCOUNTED_HALT : CHASE_EXPIRED_HALT);
    }

    // The best price on the chase's own side is the best opposing price of the other side.
    const best = await this.ports.bestOpposingPrice(parent.marketId, parent.side === 'buy' ? 'sell' : 'buy');
    if (this.parents.get(parent.id) !== parent) return superseded();
    if (best === null || best <= 0n) return { kind: 'idle', reason: follow ? 'no_book_move' : 'paused' };
    if (beyondChaseDistance(parent.side, start, best, bps)) {
      return this.stopChase(parent, open, CHASE_MAX_DISTANCE_HALT);
    }
    if (!follow) return { kind: 'idle', reason: 'paused' };
    if (lastOpen && last.price != null) {
      const improved = parent.side === 'buy' ? best > last.price : best < last.price;
      if (!improved) return { kind: 'idle', reason: 'no_book_move' };
    }

    const sliceIndex = parent.children.length;
    const clientOrderId = `algo:${parent.id}:${sliceIndex}`;
    // A crash after the last child was placed but before it was saved left that order in the book under the next client
    // id. Adopt it rather than place over it: the next tick re-prices it like any other child.
    const orphan = this.ports.chaseChildByClientOrderId ? await this.ports.chaseChildByClientOrderId(parent, clientOrderId) : null;
    if (this.parents.get(parent.id) !== parent) return superseded();
    if (orphan) {
      const adopted: AlgoChildRef = {
        sliceIndex,
        orderId: orphan.orderId,
        clientOrderId,
        qty: orphan.qty,
        placedAt: orphan.placedAt,
        price: orphan.price,
      };
      const updated: TwapParent = { ...parent, nextSliceIndex: sliceIndex + 1, children: [...parent.children, adopted], nextDueAt: now };
      this.parents.set(parent.id, updated);
      await this.emitChange(updated);
      return { kind: 'idle', reason: 'adopted' };
    }

    for (const child of open) {
      const parked = await this.cancelChaseChild(parent, child);
      if (parked) return parked;
    }
    if (open.length > 0) {
      if (this.parents.get(parent.id) !== parent) return superseded();
      // The cancelled children's fills are final now; the new child carries only what is left.
      state = await readChildren(ids);
      if (this.parents.get(parent.id) !== parent) return superseded();
      // Never two working orders: a child that still reads open after its cancel is waited out, not placed over.
      if (state.openOrderIds.size > 0) return { kind: 'idle', reason: 'child_open' };
    }
    // A child the engine may have matched in full is not placed over until its fills land (or the chase's time ends).
    // A child whose match is known stays open until then (the cancel waits for its fill), and is waited out above.
    if (state.unaccountedOrderIds.size > 0) return { kind: 'idle', reason: 'awaiting_fills' };
    const rest = parent.totalQty - state.filledQty;
    const qty = rest - (rest % lot);
    if (qty <= 0n) {
      this.replace(parent.id, { ...parent, status: 'completed' });
      return { kind: 'completed' };
    }

    let placed: { orderId: string };
    try {
      placed = await this.ports.placeChild({
        parentId: parent.id,
        sliceIndex,
        clientOrderId,
        marketId: parent.marketId,
        symbol: parent.symbol,
        side: parent.side,
        qty,
        limitPrice: best,
        subAccountId: parent.subAccountId,
      });
    } catch (err) {
      const live = this.parents.get(parent.id);
      if (live !== parent) return superseded();
      const message = err instanceof Error ? err.message : String(err);
      const insufficient =
        (err instanceof TradeError && (err.code === 'trade.algo_insufficient_balance' || err.code.startsWith('ledger'))) ||
        message.toLowerCase().includes('insufficient');
      if (insufficient) return this.halt(parent, `insufficient balance for the chase child: ${message}`, 'trade.algo_insufficient_balance');
      if (err instanceof TradeError && err.code === 'trade.algo_principal_unavailable') {
        return this.halt(parent, message, 'trade.algo_principal_unavailable');
      }
      // The old child is already cancelled; a refused new one stops the chase rather than retrying every tick.
      return this.halt(parent, `chase child refused: ${message}`, 'trade.algo_child_refused');
    }
    const child: AlgoChildRef = { sliceIndex, orderId: placed.orderId, clientOrderId, qty, placedAt: now, price: best };
    // The child is recorded on whatever the parent is now, so it is never untracked; the save is awaited so a crash
    // after this line cannot lose it (and a crash before it is adopted on the next tick).
    const live = this.parents.get(parent.id) ?? parent;
    const recorded: TwapParent = {
      ...live,
      nextSliceIndex: Math.max(live.nextSliceIndex, sliceIndex + 1),
      children: live.children.some((c) => c.orderId === child.orderId) ? live.children : [...live.children, child],
      nextDueAt: now,
    };
    this.parents.set(parent.id, recorded);
    await this.emitChange(recorded);
    if (live === parent || recorded.status === 'active') return { kind: 'placed', child };
    // A cancel or pause landed while the child was being placed: it must not keep working for a stopped chase.
    const parked = await this.cancelChaseChild(recorded, child);
    return parked ?? superseded();
  }

  /** Cancel a chase's resting child. A failure parks the parent as cancel-incomplete and returns the result to report. */
  private async cancelChaseChild(parent: TwapParent, child: AlgoChildRef): Promise<SliceTickResult | null> {
    try {
      await this.ports.cancelChild(child.orderId);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Park whatever the parent is now: a cancel that landed meanwhile must not be overwritten by a stale copy.
      const live = this.parents.get(parent.id) ?? parent;
      const parked: TwapParent = { ...live, status: 'paused', pausedAt: this.ports.now(), haltReason: CANCEL_INCOMPLETE_HALT };
      this.parents.set(parent.id, parked);
      await this.emitChange(parked);
      return { kind: 'halted', reason: `chase child cancel failed: ${message}`, code: 'trade.algo_child_refused' };
    }
  }

  /** End a chase on its own: cancel each resting child once, then halt with `reason`. */
  private async stopChase(parent: TwapParent, open: readonly AlgoChildRef[], reason: string): Promise<SliceTickResult> {
    for (const child of open) {
      const parked = await this.cancelChaseChild(parent, child);
      if (parked) return parked;
    }
    const live = this.parents.get(parent.id);
    // A cancel by the person that landed meanwhile stands; the chase does not overwrite it with its own stop.
    if (live !== parent && live?.status === 'cancelled') return { kind: 'idle', reason: 'cancelled' };
    this.replace(parent.id, { ...(live ?? parent), status: 'halted', haltReason: reason });
    return { kind: 'idle', reason: 'halted' };
  }

  /**
   * Drive all active parents once (job host).
   * One parent throw must not starve the rest of the sweep (W4 C2).
   */
  async tickAll(): Promise<void> {
    for (const [id, parent] of this.parents) {
      const pausedChase = parent.status === 'paused' && parent.kind === 'chase' && parent.haltReason !== CANCEL_INCOMPLETE_HALT;
      if (parent.status !== 'active' && !pausedChase) continue;
      try {
        await this.tick(id);
      } catch {
        // Per-parent isolation: log is the job host's onError if the whole
        // tickAllAlgos throws; here we keep siblings moving.
      }
    }
  }

  private halt(parent: TwapParent, reason: string, code: AlgoMissCode): SliceTickResult {
    const now = this.ports.now();
    const miss: AlgoMiss = {
      sliceIndex: parent.nextSliceIndex,
      code,
      reason,
      at: now,
    };
    this.replace(parent.id, {
      ...parent,
      status: 'halted',
      haltReason: reason,
      misses: [...parent.misses, miss],
      // Do not advance nextSliceIndex on halt — slice was not completed.
    });
    return { kind: 'halted', reason, code };
  }

  private recordMiss(parent: TwapParent, miss: AlgoMiss): SliceTickResult {
    const plan = this.plans.get(parent.id)!;
    const next = parent.nextSliceIndex + 1;
    const remaining = plan.length - next;
    const now = miss.at;
    const updated: TwapParent = {
      ...parent,
      nextSliceIndex: next,
      misses: [...parent.misses, miss],
      // Miss still consumes the slot; re-space so overdue misses do not burst.
      nextDueAt: new Date(now.getTime() + parent.sliceIntervalMs),
      projectedEndsAt: projectTwapEndsAt(now.getTime() + parent.sliceIntervalMs, remaining, parent.sliceIntervalMs),
      status: next >= plan.length ? 'completed' : parent.status,
    };
    this.parents.set(parent.id, updated);
    this.emitChange(updated);
    return { kind: 'miss', miss };
  }

  private requireOwner(userId: string, parentId: string): TwapParent {
    const parent = this.parents.get(parentId);
    if (!parent) throw new TradeError(`algo ${parentId} not found`, 'trade.algo_not_found');
    if (parent.userId !== userId) throw new TradeError('not the algo owner', 'trade.not_owner');
    return parent;
  }

  private replace(id: string, parent: TwapParent): TwapParent {
    this.parents.set(id, parent);
    void this.emitChange(parent);
    return parent;
  }

  private emitChange(parent: TwapParent): Promise<void> {
    const onChange = this.onChange;
    if (!onChange) return Promise.resolve();
    const plan = this.plans.get(parent.id) ?? [];
    // Saves of one parent run in order: two state changes on one tick must not land newest-first in the store.
    const write = (this.saves.get(parent.id) ?? Promise.resolve())
      .then(() => onChange(parent, plan))
      .catch(() => {
        // Persistence failures must not invent progress; next tick retries save.
      });
    this.saves.set(parent.id, write);
    void write.then(() => {
      if (this.saves.get(parent.id) === write) this.saves.delete(parent.id);
    });
    return write;
  }
}

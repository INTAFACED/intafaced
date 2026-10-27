import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { CopyError } from './errors.js';
import { drawdownDecision, mirrorOccupiesConcurrencySlot } from './follow-limits-extra.js';
import { canonicalizeCopyFillId } from './fee-share.js';
import { followRelationshipState, parseCopyRelationshipState } from './copy-lifecycle.js';
import { copyReserveKey, type CopyCursor, type CopyFollow } from './follows.js';
import { parseAlgoPlaceGrant } from '../algo/durable-principal.js';
import { dropFollowSessionKey, overlayFollowSessionKey, persistFollowSessionKey } from './session-key.js';

/** postgres.js surfaces PG SQLSTATE on `err.code`. */
export function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Unique `(follower_id, leader_id)` is the durable already-following gate.
 * Concurrent follows can both pass the list check; the index must not leak a
 * raw 23505 onto the wire (same honesty as fill-sequence-conflict).
 */
export function rethrowCopyFollowUnique(err: unknown): never {
  if (isPgUniqueViolation(err)) {
    throw new CopyError('Already following this leader', 'trade.copy_already_following');
  }
  throw err;
}

/**
 * Unique fill_id on fee-share claim. A 23505 with no re-read row must not
 * 500 the door — map to the same refuse as a second leader. Not a ledger
 * throw: wrapping those as CopyError would unclaim after a sweep.
 */
export function rethrowCopyFeeShareUnique(err: unknown): never {
  if (isPgUniqueViolation(err)) {
    throw new CopyError('Fill already settled for another leader — refuse fee-share', 'trade.copy_settle_refused');
  }
  throw err;
}

/**
 * Typed product refuses fire before ledger recipes. Unclaim a CopyError
 * only when **this call INSERTed** the pending row (pre-post) **and
 * reserveEarnings has not run**. Fill-not-found / wrong owner / killed /
 * not-mirrored / pre-follow / blank / expired must not burn the once-key
 * on first insert. After reserve, never DELETE unique fill_id — even if
 * stamp 0-row throws CopyError (cap is already consumed). Retry of leftover
 * pending that then CopyErrors must **keep** unique fill_id — DELETE would
 * let follow B pay. A ledger or crash throw may have swept or paid — keep
 * unique fill_id.
 */
export function isCopyFeeSharePrePostUnclaim(err: unknown): boolean {
  return err instanceof CopyError;
}

/** DELETE unique fill_id only on pre-reserve CopyError from this call's INSERT. */
export function shouldUnclaimCopyFeeShareClaim(insertedThisCall: boolean, err: unknown, reservedThisCall = false): boolean {
  return insertedThisCall && !reservedThisCall && isCopyFeeSharePrePostUnclaim(err);
}

/** `runFeeShareSettleOnce` body — skip reserve / unclaim when leftover or post-reserve. */
export type FeeShareSettleOnceContext = { readonly insertedThisCall: boolean; reservedThisCall: boolean };

/**
 * Durable copy-follow store (trade.copy residual — same pattern as #1010 TWAP).
 *
 * Process Maps lose follows/exposure on restart. This store keeps the envelope
 * + open exposure so a restarted process resumes the same parent state.
 * §8 rates stay refuse-closed in CopyService — this never invents them.
 *
 * Cap-critical counters use atomic reserve/add primitives so concurrent
 * settleFeeShare / planMirrorForFollow cannot over-pay or over-expose (#1191).
 *
 * Mirrored leader fills are claimed by (followId, fillId). A redelivered
 * observation must return the prior plan and never bump exposure again —
 * same business-key shape as fee-share settle / ledger fill keys. Mirror claims
 * serialise on `exp:${followId}` so they compose with addExposureIfUnderCap.
 *
 * Fee-share settle is claimed once per fillId (any follow). Unique fill_id
 * INSERT commits **before** ledger recipes (`copy-fee:${fillId}` sweep,
 * `copy-leader-share:${fillId}:${leaderId}` payout). Crash after post cannot
 * pay a second leader: the row is already there, unique-violation refuses.
 * Same-follow **pending** (`settled=false`, no skip) retries `run` — crash
 * after INSERT or a post-throw must not poison follow A. Terminal rows
 * (settled or cap/zero skip) never re-run. Other follow unique-refuses.
 * Unclaim CopyError only when this call INSERTed (`insertedThisCall`) and
 * `reservedThisCall` is still false. After reserveEarnings, never DELETE —
 * stamp 0-row CopyError keeps the row. Leftover pending retry that then
 * CopyErrors keeps the row. Any other throw from `run` may have posted —
 * keep the unique fill_id.
 * Ledger keys alone are not enough: payout keys include leaderId, so two
 * leaders would both post from one house pot. Pending retry must not
 * re-reserve a fill that already occupied cap (`cappedLeaderShare` on the
 * pending row). Reserve+stamp is one store step so leftover stamp-0 cannot
 * mean both never-reserved and reserved-stamp-lost (`copy-fee:${fillId}` /
 * `copy-leader-share:${fillId}:${leaderId}`).
 */

export interface CopyPeriodStats {
  readonly earningsPaid: Amount;
  readonly roundTrips: number;
}

/** Result of atomically claiming leader fee-share headroom under the period cap. */
export type ReserveEarningsResult = {
  readonly reserved: Amount;
  readonly newPaid: Amount;
  readonly roundTrips: number;
};

export type AddExposureResult = { readonly ok: true; readonly newExposure: Amount } | { readonly ok: false; readonly current: Amount };

/**
 * Prior mirror plan stored under a claimed leader fillId.
 * Enough to re-present the plan on redelivery without re-running envelope math.
 */
export interface StoredMirrorPlan {
  readonly fillId: string;
  readonly followId: string;
  readonly followerId: string;
  readonly leaderId: string;
  readonly marketId: string;
  readonly side: 'buy' | 'sell';
  readonly qty: Amount;
  readonly notional: Amount;
  readonly nextExposure: Amount;
}

/**
 * Result of claiming a leader fill for mirror under one follow.
 *
 * - `duplicate` — fillId already claimed; exposure untouched; return prior plan.
 * - `claimed` — first time; exposure advanced; plan persisted.
 * - `cap_exceeded` — would breach maxAggregate; nothing recorded.
 * - `drawdown_stop` — peak minus the current result is at the cap; nothing recorded.
 */
export type ClaimMirrorFillResult =
  | { readonly status: 'duplicate'; readonly plan: StoredMirrorPlan }
  | { readonly status: 'claimed'; readonly plan: StoredMirrorPlan }
  | { readonly status: 'cap_exceeded'; readonly current: Amount }
  | { readonly status: 'drawdown_stop'; readonly peak: Amount };

/**
 * Prior fee-share settle under a claimed (follow, fill). Enough to re-present
 * on redelivery without re-running reserve / ledger.
 */
export interface StoredSettledFeeShare {
  readonly fillId: string;
  readonly followId: string;
  readonly leaderId: string;
  readonly followerId: string;
  readonly assetId: string;
  readonly protocolFee: Amount;
  readonly appliedShareBps: number;
  readonly grossLeaderShare: Amount;
  readonly cappedLeaderShare: Amount;
  readonly skippedReason: null | 'cap_reached' | 'zero_share';
  readonly settled: boolean;
}

export type RunFeeShareSettleOnceResult =
  | { readonly status: 'duplicate'; readonly record: StoredSettledFeeShare }
  | { readonly status: 'claimed'; readonly record: StoredSettledFeeShare };

/**
 * Crash leftover / post-throw keep-claim: zeros, `settled=false`, no skip.
 * Cap/zero skips also use `settled=false` but they already finished `run`.
 */
export function isPendingFeeShareClaim(record: StoredSettledFeeShare): boolean {
  return record.settled === false && record.skippedReason === null;
}

/**
 * Durable reserved amount on a leftover pending row. Stamp-0 means reserve
 * never committed (crash-before-reserve, or stamp failed and rolled back).
 * After reserve+stamp in one step, a committed reserve cannot stay stamp-0.
 */
export function stampedPendingFeeShareReserve(record: StoredSettledFeeShare | null | undefined): Amount {
  return record && isPendingFeeShareClaim(record) ? record.cappedLeaderShare : 0n;
}

export type ExistingFeeShareClaimResolution =
  { readonly action: 'duplicate'; readonly record: StoredSettledFeeShare } | { readonly action: 'retry' };

/**
 * Other follow on this fill_id unique-refuses (no second pay). Same-follow
 * pending retries `run`. Terminal same-follow is a duplicate.
 */
export function resolveExistingFeeShareClaim(followId: string, existing: StoredSettledFeeShare): ExistingFeeShareClaimResolution {
  if (existing.followId !== followId) {
    throw new CopyError('Fill already settled for another leader — refuse fee-share', 'trade.copy_settle_refused');
  }
  if (isPendingFeeShareClaim(existing)) return { action: 'retry' };
  return { action: 'duplicate', record: existing };
}

/** Prior follower place under a claimed (follow, leader fill). */
export interface StoredPlacedMirror {
  readonly followId: string;
  readonly fillId: string;
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly price: Amount;
}

export type RunPlaceMirrorOnceResult =
  | { readonly status: 'duplicate'; readonly record: StoredPlacedMirror }
  | { readonly status: 'claimed'; readonly record: StoredPlacedMirror };

export interface CopyFollowStore {
  /**
   * Linearize every action for one follow across processes.
   *
   * Kill/unfollow acknowledgements wait for an already-started mirror/settle;
   * after acknowledgement, no later action can pass a stale follow snapshot.
   */
  runFollowExclusive<T>(followId: string, run: (lockedStore: CopyFollowStore) => Promise<T>): Promise<T>;
  saveFollow(follow: CopyFollow, exposure?: Amount): Promise<void>;
  getFollow(followId: string): Promise<CopyFollow | null>;
  deleteFollow(followId: string): Promise<void>;
  /** All follows (hydrate / ops). Product desk uses listFollowsByFollower. */
  listFollows(): Promise<CopyFollow[]>;
  /** Follows the copy driver may place for: ACTIVE, unexpired, with an unrevoked session key and a place grant. */
  listCopyingFollows(now: Date): Promise<CopyFollow[]>;
  /**
   * Move the follow's copy cursor. `forward` never moves it back (a slower sweep cannot undo a later one); `reset`
   * sets it outright, when copying is turned on. Only this writes the cursor: saving a follow leaves it alone.
   */
  setCopyCursor(followId: string, cursor: CopyCursor, mode: 'forward' | 'reset'): Promise<void>;
  /** Caller-scoped list — never loads another follower's envelope. Desk passes a published limit; uniqueness omits it. */
  listFollowsByFollower(followerId: string, limit?: number): Promise<CopyFollow[]>;
  /** ACTIVE follows of one leader. The count only — no follower identity. */
  countActiveFollowsByLeader(leaderId: string): Promise<number>;
  /**
   * The unused part of one follower's held reserves in one asset: each reserve less its follow's open exposure (which
   * the ledger's available balance already leaves out). Released reserves and stopping, detached or expired follows do
   * not count.
   */
  sumUnusedReserves(followerId: string, asset: string): Promise<Amount>;
  /** Serialises reserve checks for one follower and asset until the surrounding transaction ends. */
  lockReserves(followerId: string, asset: string): Promise<void>;
  getExposure(followId: string): Promise<Amount>;
  setExposure(followId: string, amount: Amount): Promise<void>;
  /**
   * Atomically add `delta` to exposure when `current + delta <= maxAggregate`.
   * Concurrent mirrors cannot both clear a near-cap check.
   */
  addExposureIfUnderCap(followId: string, delta: Amount, maxAggregate: Amount): Promise<AddExposureResult>;
  getPeriodStats(pairKey: string): Promise<CopyPeriodStats>;
  setPeriodStats(pairKey: string, stats: CopyPeriodStats): Promise<void>;
  /**
   * Atomically claim up to `amount` of remaining cap headroom and +1 round-trip.
   * `reserved = min(amount, max(cap - paid, 0))`. Always increments round-trips
   * (including when reserved is 0) so decay still advances on cap skips.
   */
  reserveEarnings(pairKey: string, amount: Amount, cap: Amount): Promise<ReserveEarningsResult>;
  /**
   * Stamp the reserved amount on a pending unique fill_id **before** ledger
   * post. Leftover retry skip-reserves and re-posts this amount — never
   * `grossLeaderShare`, never a live cap/zero skip over a paid fill.
   * 0-row UPDATE throws — CopyService must not post an unstamped reserve.
   */
  savePendingFeeShareReserve(followId: string, fillId: string, reserved: Amount): Promise<void>;
  /**
   * Reserve cap headroom and stamp the pending unique fill_id in **one**
   * step. Leftover pending with a committed reserve then has
   * `cappedLeaderShare > 0` (retry must not call reserveEarnings again).
   * Stamp 0-row / throw rolls the reserve back — refuse to keep a consumed
   * slot the row cannot record. Same CopyError as savePendingFeeShareReserve.
   */
  reserveAndStampPendingFeeShare(
    pairKey: string,
    amount: Amount,
    cap: Amount,
    followId: string,
    fillId: string,
  ): Promise<ReserveEarningsResult>;
  /**
   * Roll back a prior reserve. Settle does not call this when unique fill_id
   * is kept (post-throw) — releasing would let a later fill occupy the same
   * cap while leftover retry skip-reserves and pays again.
   */
  releaseEarnings(pairKey: string, amount: Amount): Promise<void>;
  /** Drop a pair's churn counters — used when the follow itself goes away. */
  clearPeriodStats(pairKey: string): Promise<void>;
  /**
   * Look up a previously claimed mirror for (follow, leader fill).
   * Null when this fill has never been mirrored under this follow.
   */
  getMirroredFill(followId: string, fillId: string): Promise<StoredMirrorPlan | null>;
  /**
   * Atomically claim a leader fillId for this follow and apply notional to
   * exposure when under cap. Same fillId twice → prior plan, no second bump.
   *
   * Serialises on followId (same exclusive domain as addExposureIfUnderCap)
   * so concurrent first-claims cannot both advance.
   */
  claimMirrorFill(input: {
    followId: string;
    fillId: string;
    maxAggregate: Amount;
    plan: Omit<StoredMirrorPlan, 'nextExposure'>;
    /**
     * When set, the peak result is raised under the same transaction as the
     * plan insert. A stop writes nothing.
     */
    drawdown?: { readonly current: Amount; readonly cap: Amount };
  }): Promise<ClaimMirrorFillResult>;
  /**
   * Placed mirrors of this follow whose order is not terminal.
   * A missing row or unreadable status counts as open. Another follow's
   * orders are not included.
   */
  countOpenMirrors(followId: string): Promise<number>;
  /**
   * Look up a previously claimed fee-share settle for (follow, fill).
   * Null when this fill has never been settled under this follow.
   */
  getSettledFeeShare(followId: string, fillId: string): Promise<StoredSettledFeeShare | null>;
  /**
   * Run fee-share settle body at most once per fillId (all follows).
   * Claims the unique fill_id row **before** `run` (ledger sweep + rewardPay).
   * Same-follow pending retries `run`. Terminal same-follow redelivery
   * returns the prior record without re-running. A different follow on the
   * same fill throws `trade.copy_settle_refused` (even while pending).
   * `run` throws: unclaim CopyError only when this call INSERTed and
   * reserve has not run; leftover / post-reserve keeps the row (second
   * leader unique-violates).
   */
  runFeeShareSettleOnce(
    followId: string,
    fillId: string,
    run: (ctx: FeeShareSettleOnceContext) => Promise<StoredSettledFeeShare>,
  ): Promise<RunFeeShareSettleOnceResult>;
  /**
   * Run follower place at most once per (followId, fillId).
   * Redelivery returns the prior order and does not call placeOrder again.
   */
  runPlaceMirrorOnce(followId: string, fillId: string, run: () => Promise<StoredPlacedMirror>): Promise<RunPlaceMirrorOnceResult>;
  /** The copy already placed for this leader fill under this follow, or null. */
  getPlacedMirror(followId: string, fillId: string): Promise<StoredPlacedMirror | null>;
}

/**
 * Per-key async mutex — serialises reserve/add/claim critical sections on Memory.
 * Promise-chain: each caller awaits the previous, then holds until done.
 */
function createExclusiveQueue() {
  const tails = new Map<string, Promise<void>>();
  return async function exclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(
      key,
      prev.then(
        () => gate,
        () => gate,
      ),
    );
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function mirrorKey(followId: string, fillId: string): string {
  return `${followId}\0${fillId}`;
}

function settleKey(followId: string, fillId: string): string {
  return `${followId}\0${fillId}`;
}

/**
 * Unique fill_id claim written *before* ledger recipes. Zeros / blank asset
 * until `run` completes; crash leftover still unique-violates a second leader.
 */
function pendingFeeShareClaim(followId: string, fillId: string, leaderId: string, followerId: string): StoredSettledFeeShare {
  return {
    fillId,
    followId,
    leaderId,
    followerId,
    assetId: '',
    protocolFee: 0n,
    appliedShareBps: 0,
    grossLeaderShare: 0n,
    cappedLeaderShare: 0n,
    skippedReason: null,
    settled: false,
  };
}

/** A stopped or detached follow places no new copies, so its reserve is released. */
function reserveEnds(follow: CopyFollow): boolean {
  const state = followRelationshipState(follow);
  return state === 'STOPPING' || state === 'DETACHED';
}

/** In-memory store — default for unit tests and single-process dev. */
export class MemoryCopyFollowStore implements CopyFollowStore {
  private readonly follows = new Map<string, CopyFollow>();
  /** Reserve rows of removed follows: the record stays, released. */
  readonly releasedReserves = new Map<string, NonNullable<CopyFollow['reserve']>>();
  private readonly exposure = new Map<string, Amount>();
  private readonly period = new Map<string, CopyPeriodStats>();
  /** Keyed `${followId}\0${fillId}` — one plan per leader fill under a follow. */
  private readonly mirrored = new Map<string, StoredMirrorPlan>();
  /** Keyed `${followId}\0${fillId}` — one fee-share settle per follower fill. */
  private readonly settled = new Map<string, StoredSettledFeeShare>();
  /** Keyed fillId — one fill shares with at most one leader, including after unfollow. */
  private readonly settledByFill = new Map<string, StoredSettledFeeShare>();
  /** Keyed `${followId}\0${fillId}` — one follower place per leader fill. */
  private readonly placed = new Map<string, StoredPlacedMirror>();
  /** Order id → status. Missing and null both count as open. */
  private readonly orderState = new Map<string, string | null>();
  private readonly exclusive = createExclusiveQueue();

  async runFollowExclusive<T>(followId: string, run: (lockedStore: CopyFollowStore) => Promise<T>): Promise<T> {
    return this.exclusive(`follow:${followId}`, () => run(this));
  }

  async saveFollow(follow: CopyFollow, exposure: Amount = 0n): Promise<void> {
    for (const existing of this.follows.values()) {
      if (existing.followerId === follow.followerId && existing.leaderId === follow.leaderId && existing.followId !== follow.followId) {
        throw new CopyError('Already following this leader', 'trade.copy_already_following');
      }
    }
    // The reserve is held once and only ever released, the same as the SQL row.
    const held = this.follows.get(follow.followId)?.reserve ?? follow.reserve;
    const reserve = held && held.releasedAt === null && reserveEnds(follow) ? { ...held, releasedAt: new Date() } : held;
    const copyCursor = this.follows.get(follow.followId)?.copyCursor;
    const { copyCursor: _ignored, ...saved } = follow;
    this.follows.set(follow.followId, { ...saved, ...(reserve ? { reserve } : {}), ...(copyCursor ? { copyCursor } : {}) });
    persistFollowSessionKey(follow);
    if (!this.exposure.has(follow.followId)) {
      this.exposure.set(follow.followId, exposure);
    }
  }

  async getFollow(followId: string): Promise<CopyFollow | null> {
    const follow = this.follows.get(followId);
    return follow ? overlayFollowSessionKey(follow) : null;
  }

  async deleteFollow(followId: string): Promise<void> {
    const reserve = this.follows.get(followId)?.reserve;
    if (reserve) this.releasedReserves.set(copyReserveKey(followId), { ...reserve, releasedAt: reserve.releasedAt ?? new Date() });
    this.follows.delete(followId);
    dropFollowSessionKey(followId);
    this.exposure.delete(followId);
    // Drop claimed mirrors for this envelope. A re-follow gets a new followId
    // and must not inherit old fill claims (fresh session budget).
    for (const key of [...this.mirrored.keys()]) {
      if (key.startsWith(`${followId}\0`)) {
        this.mirrored.delete(key);
      }
    }
    for (const key of [...this.settled.keys()]) {
      if (key.startsWith(`${followId}\0`)) {
        this.settled.delete(key);
      }
    }
    // Keep settledByFill — a fill already shared must not pay a new follow.
    for (const key of [...this.placed.keys()]) {
      if (key.startsWith(`${followId}\0`)) {
        this.placed.delete(key);
      }
    }
  }

  async listFollows(): Promise<CopyFollow[]> {
    return [...this.follows.values()].map(overlayFollowSessionKey);
  }

  async listCopyingFollows(now: Date): Promise<CopyFollow[]> {
    return (await this.listFollows()).filter((f) => isCopying(f, now));
  }

  async setCopyCursor(followId: string, cursor: CopyCursor, mode: 'forward' | 'reset'): Promise<void> {
    const follow = this.follows.get(followId);
    if (!follow) return;
    if (mode === 'forward' && follow.copyCursor && compareCopyCursor(cursor, follow.copyCursor) <= 0) return;
    this.follows.set(followId, { ...follow, copyCursor: cursor });
  }

  async listFollowsByFollower(followerId: string, limit?: number): Promise<CopyFollow[]> {
    const rows = [...this.follows.values()].filter((f) => f.followerId === followerId).map(overlayFollowSessionKey);
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  async sumUnusedReserves(followerId: string, asset: string): Promise<Amount> {
    const now = Date.now();
    let total = 0n;
    for (const follow of this.follows.values()) {
      const r = follow.reserve;
      if (follow.followerId !== followerId || r?.asset !== asset || r.releasedAt !== null) continue;
      if (reserveEnds(follow) || follow.envelope.expiresAt.getTime() <= now) continue;
      const unused = r.amount - (this.exposure.get(follow.followId) ?? 0n);
      if (unused > 0n) total += unused;
    }
    return total;
  }

  async lockReserves(): Promise<void> {
    // One process, no concurrent writers in tests.
  }

  async countActiveFollowsByLeader(leaderId: string): Promise<number> {
    let n = 0;
    for (const follow of this.follows.values()) {
      if (follow.leaderId === leaderId && followRelationshipState(follow) === 'ACTIVE') n += 1;
    }
    return n;
  }

  async getExposure(followId: string): Promise<Amount> {
    return this.exposure.get(followId) ?? 0n;
  }

  async setExposure(followId: string, amount: Amount): Promise<void> {
    this.exposure.set(followId, amount);
  }

  async addExposureIfUnderCap(followId: string, delta: Amount, maxAggregate: Amount): Promise<AddExposureResult> {
    return this.exclusive(`exp:${followId}`, () => {
      const current = this.exposure.get(followId) ?? 0n;
      if (delta < 0n) {
        return { ok: false as const, current };
      }
      const next = current + delta;
      if (next > maxAggregate) {
        return { ok: false as const, current };
      }
      this.exposure.set(followId, next);
      return { ok: true as const, newExposure: next };
    });
  }

  async getPeriodStats(pairKey: string): Promise<CopyPeriodStats> {
    return this.period.get(pairKey) ?? { earningsPaid: 0n, roundTrips: 0 };
  }

  async setPeriodStats(pairKey: string, stats: CopyPeriodStats): Promise<void> {
    this.period.set(pairKey, stats);
  }

  async reserveEarnings(pairKey: string, amount: Amount, cap: Amount): Promise<ReserveEarningsResult> {
    return this.exclusive(`per:${pairKey}`, () => {
      const cur = this.period.get(pairKey) ?? { earningsPaid: 0n, roundTrips: 0 };
      const remaining = cap > cur.earningsPaid ? cap - cur.earningsPaid : 0n;
      const want = amount > 0n ? amount : 0n;
      const reserved = want <= remaining ? want : remaining;
      const newPaid = cur.earningsPaid + reserved;
      const roundTrips = cur.roundTrips + 1;
      this.period.set(pairKey, { earningsPaid: newPaid, roundTrips });
      return { reserved, newPaid, roundTrips };
    });
  }

  async savePendingFeeShareReserve(followId: string, fillId: string, reserved: Amount): Promise<void> {
    if (reserved <= 0n) return;
    const id = canonicalizeCopyFillId(fillId);
    const key = settleKey(followId, id);
    const cur = this.settled.get(key);
    if (!cur || !isPendingFeeShareClaim(cur)) {
      throw new CopyError(
        'Pending fee-share reserve stamp matched 0 rows — refuse rather than post unstamped',
        'trade.copy_settle_refused',
      );
    }
    const next = { ...cur, cappedLeaderShare: reserved };
    this.settled.set(key, next);
    this.settledByFill.set(id, next);
  }

  async reserveAndStampPendingFeeShare(
    pairKey: string,
    amount: Amount,
    cap: Amount,
    followId: string,
    fillId: string,
  ): Promise<ReserveEarningsResult> {
    const id = canonicalizeCopyFillId(fillId);
    const cur = this.settled.get(settleKey(followId, id));
    if (cur && isPendingFeeShareClaim(cur) && cur.cappedLeaderShare > 0n) {
      const stats = this.period.get(pairKey) ?? { earningsPaid: 0n, roundTrips: 0 };
      return { reserved: cur.cappedLeaderShare, newPaid: stats.earningsPaid, roundTrips: stats.roundTrips };
    }
    const reserved = await this.reserveEarnings(pairKey, amount, cap);
    try {
      if (reserved.reserved > 0n) {
        await this.savePendingFeeShareReserve(followId, fillId, reserved.reserved);
      }
      return reserved;
    } catch (err) {
      await this.releaseEarnings(pairKey, reserved.reserved);
      throw err;
    }
  }

  async releaseEarnings(pairKey: string, amount: Amount): Promise<void> {
    if (amount <= 0n) return;
    await this.exclusive(`per:${pairKey}`, () => {
      const cur = this.period.get(pairKey) ?? { earningsPaid: 0n, roundTrips: 0 };
      const nextPaid = cur.earningsPaid > amount ? cur.earningsPaid - amount : 0n;
      this.period.set(pairKey, { earningsPaid: nextPaid, roundTrips: cur.roundTrips });
    });
  }

  async clearPeriodStats(pairKey: string): Promise<void> {
    this.period.delete(pairKey);
  }

  async getMirroredFill(followId: string, fillId: string): Promise<StoredMirrorPlan | null> {
    return this.mirrored.get(mirrorKey(followId, canonicalizeCopyFillId(fillId))) ?? null;
  }

  async claimMirrorFill(input: {
    followId: string;
    fillId: string;
    maxAggregate: Amount;
    plan: Omit<StoredMirrorPlan, 'nextExposure'>;
    drawdown?: { readonly current: Amount; readonly cap: Amount };
  }): Promise<ClaimMirrorFillResult> {
    // Same exclusive domain as addExposureIfUnderCap (`exp:${followId}`).
    const fillId = canonicalizeCopyFillId(input.fillId);
    return this.exclusive(`exp:${input.followId}`, () => {
      const key = mirrorKey(input.followId, fillId);
      const existing = this.mirrored.get(key);
      if (existing) {
        return { status: 'duplicate' as const, plan: existing };
      }

      const current = this.exposure.get(input.followId) ?? 0n;
      if (input.plan.notional < 0n) {
        return { status: 'cap_exceeded' as const, current };
      }
      const nextExposure = current + input.plan.notional;
      if (nextExposure > input.maxAggregate) {
        return { status: 'cap_exceeded' as const, current };
      }

      const follow = this.follows.get(input.followId);
      let nextPeak: Amount | null = null;
      if (input.drawdown && follow) {
        const decision = drawdownDecision(follow.peakResult ?? null, input.drawdown.current, input.drawdown.cap);
        if (decision.stop) {
          return { status: 'drawdown_stop' as const, peak: follow.peakResult ?? decision.peak };
        }
        nextPeak = decision.peak;
      }

      const plan: StoredMirrorPlan = { ...input.plan, fillId, nextExposure };
      this.exposure.set(input.followId, nextExposure);
      this.mirrored.set(key, plan);
      if (follow && nextPeak !== null) {
        this.follows.set(input.followId, { ...follow, peakResult: nextPeak });
      }
      return { status: 'claimed' as const, plan };
    });
  }

  noteMirrorOrderState(orderId: string, status: string | null): void {
    this.orderState.set(orderId, status);
  }

  async countOpenMirrors(followId: string): Promise<number> {
    let open = 0;
    for (const [key, placed] of this.placed) {
      if (!key.startsWith(`${followId}\0`)) continue;
      const status = this.orderState.has(placed.orderId) ? this.orderState.get(placed.orderId) : undefined;
      if (mirrorOccupiesConcurrencySlot(status)) open += 1;
    }
    return open;
  }

  async getSettledFeeShare(followId: string, fillId: string): Promise<StoredSettledFeeShare | null> {
    return this.settled.get(settleKey(followId, canonicalizeCopyFillId(fillId))) ?? null;
  }

  async runFeeShareSettleOnce(
    followId: string,
    fillId: string,
    run: (ctx: FeeShareSettleOnceContext) => Promise<StoredSettledFeeShare>,
  ): Promise<RunFeeShareSettleOnceResult> {
    // Exclusive on fillId so two follows cannot both pass a null lookup
    // and both reserve / pay two leaders from one house fee. Claim the
    // fill *before* `run` so a second follow sees the once-key even while
    // ledger recipes are in flight (SQL unique fill_id is the durable form).
    const id = canonicalizeCopyFillId(fillId);
    return this.exclusive(`settle-fill:${id}`, async () => {
      let insertedThisCall = false;
      const existing = this.settledByFill.get(id);
      if (existing) {
        const resolved = resolveExistingFeeShareClaim(followId, existing);
        if (resolved.action === 'duplicate') {
          return { status: 'duplicate' as const, record: resolved.record };
        }
      } else {
        const follow = this.follows.get(followId);
        const claim = pendingFeeShareClaim(followId, id, follow?.leaderId ?? '', follow?.followerId ?? '');
        this.settled.set(settleKey(followId, id), claim);
        this.settledByFill.set(id, claim);
        insertedThisCall = true;
      }
      const ctx: FeeShareSettleOnceContext = { insertedThisCall, reservedThisCall: false };
      try {
        const record = await run(ctx);
        this.settled.set(settleKey(followId, id), record);
        this.settledByFill.set(id, record);
        return { status: 'claimed' as const, record };
      } catch (err) {
        if (shouldUnclaimCopyFeeShareClaim(ctx.insertedThisCall, err, ctx.reservedThisCall)) {
          this.settled.delete(settleKey(followId, id));
          const cur = this.settledByFill.get(id);
          if (cur?.followId === followId) this.settledByFill.delete(id);
        }
        throw err;
      }
    });
  }

  async runPlaceMirrorOnce(followId: string, fillId: string, run: () => Promise<StoredPlacedMirror>): Promise<RunPlaceMirrorOnceResult> {
    const id = canonicalizeCopyFillId(fillId);
    return this.exclusive(`place:${followId}`, async () => {
      const key = mirrorKey(followId, id);
      const existing = this.placed.get(key);
      if (existing) {
        return { status: 'duplicate' as const, record: existing };
      }
      const record = await run();
      this.placed.set(key, record);
      return { status: 'claimed' as const, record };
    });
  }

  async getPlacedMirror(followId: string, fillId: string): Promise<StoredPlacedMirror | null> {
    return this.placed.get(mirrorKey(followId, canonicalizeCopyFillId(fillId))) ?? null;
  }
}

/** Orders two cursors by time, then fill id (a null id is the moment itself, before any fill at that time). */
export function compareCopyCursor(a: CopyCursor, b: CopyCursor): number {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) return byTime;
  const x = a.fillId ?? '';
  const y = b.fillId ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether the copy driver may place for this follow now. */
export function isCopying(follow: CopyFollow, now: Date): boolean {
  return (
    follow.placeGrant !== undefined &&
    Boolean(follow.sessionKeyHash) &&
    follow.sessionKeyRevoked !== true &&
    followRelationshipState(follow) === 'ACTIVE' &&
    follow.envelope.expiresAt.getTime() > now.getTime() &&
    follow.copyCursor !== undefined
  );
}

type FollowRow = {
  follow_id: string;
  follower_id: string;
  leader_id: string;
  region: string;
  permitted_markets: unknown;
  max_notional_per_order: string;
  max_aggregate_exposure: string;
  max_loss: string | null;
  max_slippage_bps: number | string | null;
  max_concurrent: number | string | null;
  max_drawdown: string | null;
  peak_result: string | null;
  expires_at: Date;
  fee_share_killed: boolean;
  relationship_state?: string | null;
  exposure: string;
  created_at: Date;
  fixed_order_size?: string | null;
  place_grant?: unknown;
  session_key_hash?: string | null;
  session_key_prefix?: string | null;
  session_key_revoked?: boolean | null;
  copy_cursor_at?: Date | string | null;
  copy_cursor_fill?: string | null;
  reserve?: { asset: string; amount: string; heldAt: string | Date; releasedAt: string | Date | null } | null;
};

type MirroredFillRow = {
  fill_id: string;
  follow_id: string;
  follower_id: string;
  leader_id: string;
  market_id: string;
  side: string;
  qty: string;
  notional: string;
  next_exposure: string;
};

/**
 * Rows written before the `::text::jsonb` fix hold the list as a JSON string
 * (`'["BTC/USDT"]'`). Parse those instead of reading them as empty, or the next
 * load-and-save in copy-service would overwrite the follower's real markets.
 */
export function marketsFromJson(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.map((m) => String(m));
}

function rowToFollow(row: FollowRow): CopyFollow {
  return {
    followId: row.follow_id,
    followerId: row.follower_id,
    leaderId: row.leader_id,
    region: row.region,
    envelope: {
      permittedMarkets: marketsFromJson(row.permitted_markets),
      maxNotionalPerOrder: parseAmount(String(row.max_notional_per_order)),
      maxAggregateExposure: parseAmount(String(row.max_aggregate_exposure)),
      expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
      ...(row.max_loss ? { maxLoss: parseAmount(String(row.max_loss)) } : {}),
      ...(row.max_slippage_bps != null && row.max_slippage_bps !== '' ? { maxSlippageBps: Number(row.max_slippage_bps) } : {}),
      ...(row.max_concurrent != null && row.max_concurrent !== '' ? { maxConcurrent: Number(row.max_concurrent) } : {}),
      ...(row.max_drawdown ? { maxDrawdown: parseAmount(String(row.max_drawdown)) } : {}),
      ...(row.fixed_order_size ? { fixedOrderSize: parseAmount(String(row.fixed_order_size)) } : {}),
    },
    ...(row.reserve
      ? {
          reserve: {
            asset: row.reserve.asset,
            amount: parseAmount(String(row.reserve.amount)),
            heldAt: new Date(row.reserve.heldAt),
            releasedAt: row.reserve.releasedAt === null ? null : new Date(row.reserve.releasedAt),
          },
        }
      : {}),
    ...(parseAlgoPlaceGrant(row.place_grant) ? { placeGrant: parseAlgoPlaceGrant(row.place_grant)! } : {}),
    ...(row.session_key_hash
      ? {
          sessionKeyHash: row.session_key_hash,
          sessionKeyPrefix: row.session_key_prefix ?? null,
          sessionKeyRevoked: row.session_key_revoked === true,
        }
      : {}),
    ...(row.copy_cursor_at ? { copyCursor: { at: new Date(row.copy_cursor_at), fillId: row.copy_cursor_fill ?? null } } : {}),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    feeShareKilled: row.fee_share_killed,
    relationshipState: parseCopyRelationshipState(row.relationship_state),
    ...(row.peak_result != null && row.peak_result !== '' ? { peakResult: parseAmount(String(row.peak_result)) } : {}),
  };
}

function followFromRow(row: FollowRow): CopyFollow {
  return overlayFollowSessionKey(rowToFollow(row));
}

function rowToMirrored(row: MirroredFillRow): StoredMirrorPlan {
  const side = row.side === 'sell' ? 'sell' : 'buy';
  return {
    fillId: row.fill_id,
    followId: row.follow_id,
    followerId: row.follower_id,
    leaderId: row.leader_id,
    marketId: row.market_id,
    side,
    qty: parseAmount(String(row.qty)),
    notional: parseAmount(String(row.notional)),
    nextExposure: parseAmount(String(row.next_exposure)),
  };
}

/**
 * SQL store.
 *
 * Mirrored fills live in `trade.copy_mirrored_fills` (PK follow_id + fill_id).
 * Migration: drizzle/0021_copy_mirrored_fills.sql. Unit tests use Memory.
 */
export class SqlCopyFollowStore implements CopyFollowStore {
  constructor(
    private readonly sql: Sql,
    private readonly lockedFollowId?: string,
  ) {}

  /**
   * Pool sql has `.begin`. postgres `reserve()` returns tagged sql + `.release`
   * only — calling `.begin` on a reserved client throws after unique INSERT.
   * Exclusive already holds the session (advisory lock); issue BEGIN/COMMIT
   * as SQL on that connection.
   */
  private async withSessionTxn<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
    const begin = (this.sql as { begin?: Sql['begin'] }).begin;
    if (typeof begin === 'function') {
      return (await begin(async (tx) => run(tx as unknown as Sql))) as T;
    }
    try {
      await this.sql.unsafe('BEGIN');
      const result = await run(this.sql);
      await this.sql.unsafe('COMMIT');
      return result;
    } catch (err) {
      try {
        await this.sql.unsafe('ROLLBACK');
      } catch {
        // runFollowExclusive still releases the reserved session
      }
      throw err;
    }
  }

  private async withAdvisoryLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    // Session locks must be acquired and released on the SAME physical
    // connection. `sql.reserve()` pins one; issuing lock/unlock through the pool
    // can unlock a different session and silently leave the first lock behind.
    // A store built on an already-reserved connection (runFollowExclusive) has
    // no pool to reserve from. Take the second lock on that same session.
    if (typeof this.sql.reserve !== 'function') {
      await this.sql`SELECT pg_advisory_lock(hashtext(${key}))`;
      try {
        return await run();
      } finally {
        await this.sql`SELECT pg_advisory_unlock(hashtext(${key}))`;
      }
    }
    const connection = await this.sql.reserve();
    let locked = false;
    try {
      await connection`SELECT pg_advisory_lock(hashtext(${key}))`;
      locked = true;
      return await run();
    } finally {
      try {
        if (locked) {
          await connection`SELECT pg_advisory_unlock(hashtext(${key}))`;
        }
      } finally {
        connection.release();
      }
    }
  }

  async runFollowExclusive<T>(followId: string, run: (lockedStore: CopyFollowStore) => Promise<T>): Promise<T> {
    const connection = await this.sql.reserve();
    const lockKey = `copy-follow:${followId}`;
    let locked = false;
    try {
      await connection`SELECT pg_advisory_lock(hashtext(${lockKey}))`;
      locked = true;
      // Every guarded query uses the same pinned connection. Holding a session
      // lock on one pool connection while querying through another can exhaust
      // the pool when many follows settle concurrently.
      return await run(new SqlCopyFollowStore(connection, followId));
    } finally {
      try {
        if (locked) {
          await connection`SELECT pg_advisory_unlock(hashtext(${lockKey}))`;
        }
      } finally {
        connection.release();
      }
    }
  }

  async saveFollow(follow: CopyFollow, exposure: Amount = 0n): Promise<void> {
    const markets = JSON.stringify([...follow.envelope.permittedMarkets]);
    let inserted = false;
    try {
      const [row] = await this.sql<Array<{ inserted: boolean }>>`
      INSERT INTO copy_follows (
        follow_id, follower_id, leader_id, region, permitted_markets,
        max_notional_per_order, max_aggregate_exposure, max_loss,
        max_slippage_bps, max_concurrent, max_drawdown, expires_at,
        fee_share_killed, relationship_state, exposure, created_at, updated_at, fixed_order_size, place_grant,
        session_key_hash, session_key_prefix, session_key_revoked
      ) VALUES (
        ${follow.followId},
        ${follow.followerId},
        ${follow.leaderId},
        ${follow.region},
        ${markets}::text::jsonb,
        ${formatAmount(follow.envelope.maxNotionalPerOrder)},
        ${formatAmount(follow.envelope.maxAggregateExposure)},
        ${follow.envelope.maxLoss !== undefined ? formatAmount(follow.envelope.maxLoss) : null},
        ${follow.envelope.maxSlippageBps ?? null},
        ${follow.envelope.maxConcurrent ?? null},
        ${follow.envelope.maxDrawdown !== undefined ? formatAmount(follow.envelope.maxDrawdown) : null},
        ${follow.envelope.expiresAt},
        ${follow.feeShareKilled},
        ${followRelationshipState(follow)},
        ${formatAmount(exposure)},
        ${follow.createdAt},
        now(),
        ${follow.envelope.fixedOrderSize !== undefined ? formatAmount(follow.envelope.fixedOrderSize) : null},
        ${follow.placeGrant ? this.sql.json(follow.placeGrant as never) : null},
        ${follow.sessionKeyHash ?? null},
        ${follow.sessionKeyPrefix ?? null},
        ${follow.sessionKeyRevoked === true}
      )
      ON CONFLICT (follow_id) DO UPDATE SET
        fee_share_killed = EXCLUDED.fee_share_killed,
        relationship_state = EXCLUDED.relationship_state,
        permitted_markets = EXCLUDED.permitted_markets,
        max_notional_per_order = EXCLUDED.max_notional_per_order,
        max_aggregate_exposure = EXCLUDED.max_aggregate_exposure,
        max_loss = EXCLUDED.max_loss,
        max_slippage_bps = EXCLUDED.max_slippage_bps,
        max_concurrent = EXCLUDED.max_concurrent,
        max_drawdown = EXCLUDED.max_drawdown,
        expires_at = EXCLUDED.expires_at,
        region = EXCLUDED.region,
        fixed_order_size = EXCLUDED.fixed_order_size,
        place_grant = EXCLUDED.place_grant,
        session_key_hash = EXCLUDED.session_key_hash,
        session_key_prefix = EXCLUDED.session_key_prefix,
        session_key_revoked = EXCLUDED.session_key_revoked,
        updated_at = now()
      RETURNING (xmax = 0) AS inserted
    `;
      inserted = row?.inserted === true;
    } catch (err) {
      rethrowCopyFollowUnique(err);
    }
    await this.writeReserve(follow, inserted);
    persistFollowSessionKey(follow);
  }

  /**
   * The reserve row rides on the follow write: held once by its business key, released when the follow stops or
   * detaches. A new follow row with a released reserve (the same follow id followed again after a removal) holds it
   * again; an update of an existing follow never does.
   */
  private async writeReserve(follow: CopyFollow, newFollowRow: boolean): Promise<void> {
    if (follow.reserve) {
      await this.sql`
        INSERT INTO copy_follow_reserves (reserve_key, follow_id, follower_id, asset, amount, held_at)
        VALUES (${copyReserveKey(follow.followId)}, ${follow.followId}, ${follow.followerId}, ${follow.reserve.asset},
                ${formatAmount(follow.reserve.amount)}, ${follow.reserve.heldAt})
        ON CONFLICT (reserve_key) DO UPDATE SET
          asset = EXCLUDED.asset, amount = EXCLUDED.amount, held_at = EXCLUDED.held_at, released_at = NULL
        WHERE copy_follow_reserves.released_at IS NOT NULL AND ${newFollowRow}
      `;
    }
    if (reserveEnds(follow)) await this.releaseReserve(follow.followId);
  }

  private async releaseReserve(followId: string): Promise<void> {
    await this.sql`
      UPDATE copy_follow_reserves SET released_at = now()
       WHERE follow_id = ${followId} AND released_at IS NULL
    `;
  }

  /** The columns every follow read selects after follow_id, follower_id, leader_id, region, permitted_markets. */
  private followColumns() {
    return this.sql`max_notional_per_order::text, max_aggregate_exposure::text,
      max_loss::text, max_slippage_bps, max_concurrent, max_drawdown::text,
      peak_result::text, expires_at, fee_share_killed, relationship_state,
      exposure::text, created_at, fixed_order_size::text, place_grant,
      session_key_hash, session_key_prefix, session_key_revoked, copy_cursor_at, copy_cursor_fill,
      (SELECT json_build_object('asset', r.asset, 'amount', r.amount::text, 'heldAt', r.held_at, 'releasedAt', r.released_at)
         FROM copy_follow_reserves r WHERE r.follow_id = copy_follows.follow_id) AS reserve`;
  }

  async sumUnusedReserves(followerId: string, asset: string): Promise<Amount> {
    const [row] = await this.sql<Array<{ total: string | null }>>`
      SELECT sum(greatest(r.amount - f.exposure, 0))::text AS total
        FROM copy_follow_reserves r
        JOIN copy_follows f ON f.follow_id = r.follow_id
       WHERE r.follower_id = ${followerId} AND r.asset = ${asset} AND r.released_at IS NULL
         AND coalesce(f.relationship_state, 'ACTIVE') NOT IN ('STOPPING', 'DETACHED')
         AND f.expires_at > now()
    `;
    return row?.total ? parseAmount(row.total) : 0n;
  }

  async lockReserves(followerId: string, asset: string): Promise<void> {
    await this.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`copy.reserve:${followerId}:${asset}`}, 0))`;
  }

  async getFollow(followId: string): Promise<CopyFollow | null> {
    const rows = await this.sql<FollowRow[]>`
      SELECT follow_id, follower_id, leader_id, region, permitted_markets,
             ${this.followColumns()}
        FROM copy_follows
       WHERE follow_id = ${followId}
       LIMIT 1
    `;
    const row = rows[0];
    return row ? followFromRow(row) : null;
  }

  async deleteFollow(followId: string): Promise<void> {
    // Keep copy_settled_fee_shares — unique fill_id must survive unfollow
    // so a re-follow cannot share the same fill with a second leader.
    await this.sql`DELETE FROM copy_mirrored_fills WHERE follow_id = ${followId}`;
    await this.sql`DELETE FROM copy_placed_mirrors WHERE follow_id = ${followId}`;
    await this.sql`DELETE FROM copy_follows WHERE follow_id = ${followId}`;
    // After the follow row: a crash between the two leaves a reserve with no follow, which sumUnusedReserves skips.
    await this.releaseReserve(followId);
    dropFollowSessionKey(followId);
  }

  async listFollows(): Promise<CopyFollow[]> {
    const rows = await this.sql<FollowRow[]>`
      SELECT follow_id, follower_id, leader_id, region, permitted_markets,
             ${this.followColumns()}
        FROM copy_follows
    `;
    return rows.map(followFromRow);
  }

  async listCopyingFollows(now: Date): Promise<CopyFollow[]> {
    const rows = await this.sql<FollowRow[]>`
      SELECT follow_id, follower_id, leader_id, region, permitted_markets,
             ${this.followColumns()}
        FROM copy_follows
       WHERE place_grant IS NOT NULL AND session_key_hash IS NOT NULL AND NOT session_key_revoked
         AND coalesce(relationship_state, 'ACTIVE') = 'ACTIVE' AND expires_at > ${now} AND copy_cursor_at IS NOT NULL
    `;
    return rows.map(followFromRow).filter((f) => isCopying(f, now));
  }

  async setCopyCursor(followId: string, cursor: CopyCursor, mode: 'forward' | 'reset'): Promise<void> {
    const fill = cursor.fillId ?? '';
    await this.sql`
      UPDATE copy_follows SET copy_cursor_at = ${cursor.at}, copy_cursor_fill = ${cursor.fillId}
       WHERE follow_id = ${followId}
         AND (${mode === 'reset'} OR copy_cursor_at IS NULL
              OR (copy_cursor_at, coalesce(copy_cursor_fill, '')) < (${cursor.at}::timestamptz, ${fill}::text))
    `;
  }

  async listFollowsByFollower(followerId: string, limit?: number): Promise<CopyFollow[]> {
    const rows =
      limit === undefined
        ? await this.sql<FollowRow[]>`
            SELECT follow_id, follower_id, leader_id, region, permitted_markets,
                   ${this.followColumns()}
              FROM copy_follows
             WHERE follower_id = ${followerId}
          `
        : await this.sql<FollowRow[]>`
            SELECT follow_id, follower_id, leader_id, region, permitted_markets,
                   ${this.followColumns()}
              FROM copy_follows
             WHERE follower_id = ${followerId}
             LIMIT ${limit}
          `;
    return rows.map(followFromRow);
  }

  async countActiveFollowsByLeader(leaderId: string): Promise<number> {
    const [row] = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM trade.copy_follows
       WHERE leader_id = ${leaderId}
         AND relationship_state = 'ACTIVE'
    `;
    return row?.n ?? 0;
  }

  async getExposure(followId: string): Promise<Amount> {
    const rows = await this.sql<Array<{ exposure: string }>>`
      SELECT exposure::text FROM copy_follows WHERE follow_id = ${followId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return 0n;
    return parseAmount(String(row.exposure));
  }

  async setExposure(followId: string, amount: Amount): Promise<void> {
    await this.sql`
      UPDATE copy_follows
         SET exposure = ${formatAmount(amount)}, updated_at = now()
       WHERE follow_id = ${followId}
    `;
  }

  async addExposureIfUnderCap(followId: string, delta: Amount, maxAggregate: Amount): Promise<AddExposureResult> {
    if (delta < 0n) {
      const current = await this.getExposure(followId);
      return { ok: false, current };
    }
    const deltaStr = formatAmount(delta);
    const maxStr = formatAmount(maxAggregate);
    const rows = await this.sql<Array<{ exposure: string }>>`
      UPDATE copy_follows
         SET exposure = exposure + ${deltaStr}::numeric,
             updated_at = now()
       WHERE follow_id = ${followId}
         AND exposure + ${deltaStr}::numeric <= ${maxStr}::numeric
      RETURNING exposure::text
    `;
    const row = rows[0];
    if (row) {
      return { ok: true, newExposure: parseAmount(String(row.exposure)) };
    }
    return { ok: false, current: await this.getExposure(followId) };
  }

  async getPeriodStats(pairKey: string): Promise<CopyPeriodStats> {
    const rows = await this.sql<Array<{ earnings_paid: string; round_trips: number }>>`
      SELECT earnings_paid::text, round_trips
        FROM copy_period_stats
       WHERE pair_key = ${pairKey}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { earningsPaid: 0n, roundTrips: 0 };
    return {
      earningsPaid: parseAmount(String(row.earnings_paid)),
      roundTrips: row.round_trips,
    };
  }

  async setPeriodStats(pairKey: string, stats: CopyPeriodStats): Promise<void> {
    await this.sql`
      INSERT INTO copy_period_stats (pair_key, earnings_paid, round_trips, updated_at)
      VALUES (${pairKey}, ${formatAmount(stats.earningsPaid)}, ${stats.roundTrips}, now())
      ON CONFLICT (pair_key) DO UPDATE SET
        earnings_paid = EXCLUDED.earnings_paid,
        round_trips = EXCLUDED.round_trips,
        updated_at = now()
    `;
  }

  async reserveEarnings(pairKey: string, amount: Amount, cap: Amount): Promise<ReserveEarningsResult> {
    // Transaction: row lock + claim headroom + bump round-trips. Concurrent
    // settlers serialise here so paid + reserved never exceeds cap.
    return await this.withSessionTxn(async (tx) => {
      await tx`
        INSERT INTO copy_period_stats (pair_key, earnings_paid, round_trips, updated_at)
        VALUES (${pairKey}, 0, 0, now())
        ON CONFLICT (pair_key) DO NOTHING
      `;
      const rows = await tx<Array<{ earnings_paid: string; round_trips: number }>>`
        SELECT earnings_paid::text, round_trips
          FROM copy_period_stats
         WHERE pair_key = ${pairKey}
         FOR UPDATE
      `;
      const row = rows[0]!;
      const paid = parseAmount(String(row.earnings_paid));
      const remaining = cap > paid ? cap - paid : 0n;
      const want = amount > 0n ? amount : 0n;
      const reserved = want <= remaining ? want : remaining;
      const newPaid = paid + reserved;
      const roundTrips = row.round_trips + 1;
      await tx`
        UPDATE copy_period_stats
           SET earnings_paid = ${formatAmount(newPaid)},
               round_trips = ${roundTrips},
               updated_at = now()
         WHERE pair_key = ${pairKey}
      `;
      return { reserved, newPaid, roundTrips };
    });
  }

  async savePendingFeeShareReserve(followId: string, fillId: string, reserved: Amount): Promise<void> {
    if (reserved <= 0n) return;
    const id = canonicalizeCopyFillId(fillId);
    const rows = await this.sql<Array<{ fill_id: string }>>`
      UPDATE copy_settled_fee_shares
         SET capped_leader_share = ${formatAmount(reserved)}
       WHERE follow_id = ${followId} AND fill_id = ${id}
         AND settled = false
         AND skipped_reason IS NULL
      RETURNING fill_id
    `;
    if (rows.length === 0) {
      throw new CopyError(
        'Pending fee-share reserve stamp matched 0 rows — refuse rather than post unstamped',
        'trade.copy_settle_refused',
      );
    }
  }

  async reserveAndStampPendingFeeShare(
    pairKey: string,
    amount: Amount,
    cap: Amount,
    followId: string,
    fillId: string,
  ): Promise<ReserveEarningsResult> {
    const id = canonicalizeCopyFillId(fillId);
    return await this.withSessionTxn(async (tx) => {
      const pendingRows = await tx<Array<{ capped_leader_share: string }>>`
        SELECT capped_leader_share::text
          FROM copy_settled_fee_shares
         WHERE follow_id = ${followId} AND fill_id = ${id}
           AND settled = false
           AND skipped_reason IS NULL
         FOR UPDATE
      `;
      const pending = pendingRows[0];
      if (pending) {
        const already = parseAmount(String(pending.capped_leader_share));
        if (already > 0n) {
          const statsRows = await tx<Array<{ earnings_paid: string; round_trips: number }>>`
            SELECT earnings_paid::text, round_trips
              FROM copy_period_stats
             WHERE pair_key = ${pairKey}
             LIMIT 1
          `;
          const stats = statsRows[0];
          return {
            reserved: already,
            newPaid: stats ? parseAmount(String(stats.earnings_paid)) : already,
            roundTrips: stats?.round_trips ?? 0,
          };
        }
      }

      await tx`
        INSERT INTO copy_period_stats (pair_key, earnings_paid, round_trips, updated_at)
        VALUES (${pairKey}, 0, 0, now())
        ON CONFLICT (pair_key) DO NOTHING
      `;
      const rows = await tx<Array<{ earnings_paid: string; round_trips: number }>>`
        SELECT earnings_paid::text, round_trips
          FROM copy_period_stats
         WHERE pair_key = ${pairKey}
         FOR UPDATE
      `;
      const row = rows[0]!;
      const paid = parseAmount(String(row.earnings_paid));
      const remaining = cap > paid ? cap - paid : 0n;
      const want = amount > 0n ? amount : 0n;
      const reserved = want <= remaining ? want : remaining;
      const newPaid = paid + reserved;
      const roundTrips = row.round_trips + 1;
      await tx`
        UPDATE copy_period_stats
           SET earnings_paid = ${formatAmount(newPaid)},
               round_trips = ${roundTrips},
               updated_at = now()
         WHERE pair_key = ${pairKey}
      `;
      if (reserved > 0n) {
        const stamped = await tx<Array<{ fill_id: string }>>`
          UPDATE copy_settled_fee_shares
             SET capped_leader_share = ${formatAmount(reserved)}
           WHERE follow_id = ${followId} AND fill_id = ${id}
             AND settled = false
             AND skipped_reason IS NULL
          RETURNING fill_id
        `;
        if (stamped.length === 0) {
          throw new CopyError(
            'Pending fee-share reserve stamp matched 0 rows — refuse rather than post unstamped',
            'trade.copy_settle_refused',
          );
        }
      }
      return { reserved, newPaid, roundTrips };
    });
  }

  async releaseEarnings(pairKey: string, amount: Amount): Promise<void> {
    if (amount <= 0n) return;
    const amountStr = formatAmount(amount);
    await this.sql`
      UPDATE copy_period_stats
         SET earnings_paid = GREATEST(earnings_paid - ${amountStr}::numeric, 0),
             updated_at = now()
       WHERE pair_key = ${pairKey}
    `;
  }

  async clearPeriodStats(pairKey: string): Promise<void> {
    await this.sql`DELETE FROM copy_period_stats WHERE pair_key = ${pairKey}`;
  }

  async getMirroredFill(followId: string, fillId: string): Promise<StoredMirrorPlan | null> {
    const id = canonicalizeCopyFillId(fillId);
    const rows = await this.sql<MirroredFillRow[]>`
      SELECT fill_id, follow_id, follower_id, leader_id, market_id, side,
             qty::text, notional::text, next_exposure::text
        FROM copy_mirrored_fills
       WHERE follow_id = ${followId} AND fill_id = ${id}
       LIMIT 1
    `;
    const row = rows[0];
    return row ? rowToMirrored(row) : null;
  }

  async claimMirrorFill(input: {
    followId: string;
    fillId: string;
    maxAggregate: Amount;
    plan: Omit<StoredMirrorPlan, 'nextExposure'>;
    drawdown?: { readonly current: Amount; readonly cap: Amount };
  }): Promise<ClaimMirrorFillResult> {
    if (input.plan.notional < 0n) {
      return { status: 'cap_exceeded', current: await this.getExposure(input.followId) };
    }
    const fillId = canonicalizeCopyFillId(input.fillId);
    const notionalStr = formatAmount(input.plan.notional);
    const maxStr = formatAmount(input.maxAggregate);

    // Transaction: lock follow row → check fill claim → drawdown peak →
    // bump exposure under cap → insert mirrored plan. A stop writes nothing.
    return await this.withSessionTxn(async (tx) => {
      const followRows = await tx<Array<{ exposure: string; peak_result: string | null }>>`
        SELECT exposure::text, peak_result::text AS peak_result
          FROM copy_follows
         WHERE follow_id = ${input.followId}
         FOR UPDATE
      `;
      const followRow = followRows[0];
      if (!followRow) {
        // Follow vanished mid-flight — treat as cap refuse rather than invent.
        return { status: 'cap_exceeded' as const, current: 0n };
      }

      const existingRows = await tx<MirroredFillRow[]>`
        SELECT fill_id, follow_id, follower_id, leader_id, market_id, side,
               qty::text, notional::text, next_exposure::text
          FROM copy_mirrored_fills
         WHERE follow_id = ${input.followId} AND fill_id = ${fillId}
         LIMIT 1
      `;
      const existing = existingRows[0];
      if (existing) {
        return { status: 'duplicate' as const, plan: rowToMirrored(existing) };
      }

      const storedPeak = followRow.peak_result != null && followRow.peak_result !== '' ? parseAmount(String(followRow.peak_result)) : null;
      let nextPeak: Amount | null = null;
      if (input.drawdown) {
        const decision = drawdownDecision(storedPeak, input.drawdown.current, input.drawdown.cap);
        if (decision.stop) {
          return { status: 'drawdown_stop' as const, peak: storedPeak ?? decision.peak };
        }
        nextPeak = decision.peak;
      }

      const current = parseAmount(String(followRow.exposure));
      const nextExposure = current + input.plan.notional;
      if (nextExposure > input.maxAggregate) {
        return { status: 'cap_exceeded' as const, current };
      }

      await tx`
        UPDATE copy_follows
           SET exposure = ${formatAmount(nextExposure)},
               peak_result = CASE WHEN ${nextPeak === null} THEN peak_result ELSE ${nextPeak === null ? null : formatAmount(nextPeak)}::numeric END,
               updated_at = now()
         WHERE follow_id = ${input.followId}
           AND exposure + ${notionalStr}::numeric <= ${maxStr}::numeric
      `;

      const plan: StoredMirrorPlan = { ...input.plan, fillId, nextExposure };
      await tx`
        INSERT INTO copy_mirrored_fills (
          follow_id, fill_id, follower_id, leader_id, market_id, side,
          qty, notional, next_exposure, created_at
        ) VALUES (
          ${plan.followId},
          ${plan.fillId},
          ${plan.followerId},
          ${plan.leaderId},
          ${plan.marketId},
          ${plan.side},
          ${formatAmount(plan.qty)},
          ${formatAmount(plan.notional)},
          ${formatAmount(plan.nextExposure)},
          now()
        )
      `;
      return { status: 'claimed' as const, plan };
    });
  }

  async countOpenMirrors(followId: string): Promise<number> {
    const rows = await this.sql<Array<{ status: string | null }>>`
      SELECT o.status::text AS status
        FROM copy_placed_mirrors p
        LEFT JOIN trade.orders o ON o.id::text = p.order_id
       WHERE p.follow_id = ${followId}
    `;
    let open = 0;
    for (const row of rows) {
      if (mirrorOccupiesConcurrencySlot(row.status)) open += 1;
    }
    return open;
  }

  async getSettledFeeShare(followId: string, fillId: string): Promise<StoredSettledFeeShare | null> {
    const id = canonicalizeCopyFillId(fillId);
    const rows = await this.sql<SettledFeeShareRow[]>`
      SELECT fill_id, follow_id, leader_id, follower_id, asset_id,
             protocol_fee::text, applied_share_bps, gross_leader_share::text,
             capped_leader_share::text, skipped_reason, settled
        FROM copy_settled_fee_shares
       WHERE follow_id = ${followId} AND fill_id = ${id}
       LIMIT 1
    `;
    const row = rows[0];
    return row ? rowToSettled(row) : null;
  }

  private async getSettledFeeShareByFillId(fillId: string): Promise<StoredSettledFeeShare | null> {
    const id = canonicalizeCopyFillId(fillId);
    const rows = await this.sql<SettledFeeShareRow[]>`
      SELECT fill_id, follow_id, leader_id, follower_id, asset_id,
             protocol_fee::text, applied_share_bps, gross_leader_share::text,
             capped_leader_share::text, skipped_reason, settled
        FROM copy_settled_fee_shares
       WHERE fill_id = ${id}
       LIMIT 1
    `;
    const row = rows[0];
    return row ? rowToSettled(row) : null;
  }

  async runFeeShareSettleOnce(
    followId: string,
    fillId: string,
    run: (ctx: FeeShareSettleOnceContext) => Promise<StoredSettledFeeShare>,
  ): Promise<RunFeeShareSettleOnceResult> {
    const id = canonicalizeCopyFillId(fillId);
    const settleOnce = async () => {
      let insertedThisCall = false;
      const existing = await this.getSettledFeeShareByFillId(id);
      if (existing) {
        const resolved = resolveExistingFeeShareClaim(followId, existing);
        if (resolved.action === 'duplicate') {
          return { status: 'duplicate' as const, record: resolved.record };
        }
      } else {
        // Claim unique fill_id BEFORE ledger recipes. Payout keys include
        // leaderId (`copy-leader-share:${fillId}:${leaderId}`); a crash after
        // post used to leave no row, so a second follow paid a second leader.
        const follow = await this.getFollow(followId);
        const claim = pendingFeeShareClaim(followId, id, follow?.leaderId ?? '', follow?.followerId ?? '');
        try {
          await this.sql`
            INSERT INTO copy_settled_fee_shares (
              follow_id, fill_id, leader_id, follower_id, asset_id,
              protocol_fee, applied_share_bps, gross_leader_share, capped_leader_share,
              skipped_reason, settled, created_at
            ) VALUES (
              ${claim.followId},
              ${claim.fillId},
              ${claim.leaderId},
              ${claim.followerId},
              ${claim.assetId},
              ${formatAmount(claim.protocolFee)},
              ${claim.appliedShareBps},
              ${formatAmount(claim.grossLeaderShare)},
              ${formatAmount(claim.cappedLeaderShare)},
              ${claim.skippedReason},
              ${claim.settled},
              now()
            )
          `;
          insertedThisCall = true;
        } catch (err) {
          if (isPgUniqueViolation(err)) {
            const saved = await this.getSettledFeeShareByFillId(id);
            if (!saved) rethrowCopyFeeShareUnique(err);
            const resolved = resolveExistingFeeShareClaim(followId, saved);
            if (resolved.action === 'duplicate') {
              return { status: 'duplicate' as const, record: resolved.record };
            }
          } else {
            throw err;
          }
        }
      }

      const ctx: FeeShareSettleOnceContext = { insertedThisCall, reservedThisCall: false };
      let record: StoredSettledFeeShare;
      try {
        record = await run(ctx);
      } catch (err) {
        if (shouldUnclaimCopyFeeShareClaim(ctx.insertedThisCall, err, ctx.reservedThisCall)) {
          try {
            await this.sql`
              DELETE FROM copy_settled_fee_shares
               WHERE follow_id = ${followId} AND fill_id = ${id}
            `;
          } catch {
            // Leftover claim is fail-closed: second leader still unique-violates.
          }
        }
        throw err;
      }

      const persisted = await this.sql<Array<{ fill_id: string }>>`
        UPDATE copy_settled_fee_shares
           SET leader_id = ${record.leaderId},
               follower_id = ${record.followerId},
               asset_id = ${record.assetId},
               protocol_fee = ${formatAmount(record.protocolFee)},
               applied_share_bps = ${record.appliedShareBps},
               gross_leader_share = ${formatAmount(record.grossLeaderShare)},
               capped_leader_share = ${formatAmount(record.cappedLeaderShare)},
               skipped_reason = ${record.skippedReason},
               settled = ${record.settled}
         WHERE follow_id = ${followId} AND fill_id = ${id}
        RETURNING fill_id
      `;
      if (persisted.length === 0) {
        throw new Error('Pending fee-share persist matched 0 rows — refuse rather than leave pending zeros after a successful post');
      }
      const saved = (await this.getSettledFeeShare(followId, id)) ?? record;
      return { status: 'claimed' as const, record: saved };
    };
    const fillLockKey = `copy-settle-fill:${id}`;
    // CopyService holds the per-follow lock on this pinned connection.
    // Take the fill lock on the SAME session so two follows cannot both
    // pass the empty lookup. Unique INSERT is the crash-safe once-key.
    if (this.lockedFollowId === followId) {
      await this.sql`SELECT pg_advisory_lock(hashtext(${fillLockKey}))`;
      try {
        return await settleOnce();
      } finally {
        await this.sql`SELECT pg_advisory_unlock(hashtext(${fillLockKey}))`;
      }
    }
    return this.withAdvisoryLock(fillLockKey, settleOnce);
  }

  async getPlacedMirror(followId: string, fillId: string): Promise<StoredPlacedMirror | null> {
    const id = canonicalizeCopyFillId(fillId);
    const rows = await this.sql<PlacedMirrorRow[]>`
      SELECT follow_id, fill_id, order_id, client_order_id, price::text
        FROM copy_placed_mirrors
       WHERE follow_id = ${followId} AND fill_id = ${id}
       LIMIT 1
    `;
    const row = rows[0];
    return row ? rowToPlacedMirror(row) : null;
  }

  async runPlaceMirrorOnce(followId: string, fillId: string, run: () => Promise<StoredPlacedMirror>): Promise<RunPlaceMirrorOnceResult> {
    const id = canonicalizeCopyFillId(fillId);
    const placeOnce = async () => {
      const existing = await this.getPlacedMirror(followId, id);
      if (existing) {
        return { status: 'duplicate' as const, record: existing };
      }
      const record = await run();
      try {
        await this.sql`
          INSERT INTO copy_placed_mirrors (
            follow_id, fill_id, order_id, client_order_id, price, created_at
          ) VALUES (
            ${record.followId},
            ${canonicalizeCopyFillId(record.fillId)},
            ${record.orderId},
            ${record.clientOrderId},
            ${formatAmount(record.price)},
            now()
          )
        `;
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          const saved = await this.getPlacedMirror(followId, id);
          if (saved) {
            return { status: 'duplicate' as const, record: saved };
          }
        }
        throw err;
      }
      return { status: 'claimed' as const, record };
    };
    // One lock per follow, not per fill: the concurrency cap counts open mirrors,
    // so two different fills of one follow must not both read the same count.
    return this.withAdvisoryLock(`copy-place:${followId}`, placeOnce);
  }
}

type PlacedMirrorRow = {
  follow_id: string;
  fill_id: string;
  order_id: string;
  client_order_id: string;
  price: string;
};

function rowToPlacedMirror(row: PlacedMirrorRow): StoredPlacedMirror {
  return {
    followId: row.follow_id,
    fillId: row.fill_id,
    orderId: row.order_id,
    clientOrderId: row.client_order_id,
    price: parseAmount(String(row.price)),
  };
}

type SettledFeeShareRow = {
  fill_id: string;
  follow_id: string;
  leader_id: string;
  follower_id: string;
  asset_id: string;
  protocol_fee: string;
  applied_share_bps: number;
  gross_leader_share: string;
  capped_leader_share: string;
  skipped_reason: string | null;
  settled: boolean;
};

function rowToSettled(row: SettledFeeShareRow): StoredSettledFeeShare {
  const skipped = row.skipped_reason === 'cap_reached' || row.skipped_reason === 'zero_share' ? row.skipped_reason : null;
  return {
    fillId: row.fill_id,
    followId: row.follow_id,
    leaderId: row.leader_id,
    followerId: row.follower_id,
    assetId: row.asset_id,
    protocolFee: parseAmount(String(row.protocol_fee)),
    appliedShareBps: row.applied_share_bps,
    grossLeaderShare: parseAmount(String(row.gross_leader_share)),
    cappedLeaderShare: parseAmount(String(row.capped_leader_share)),
    skippedReason: skipped,
    settled: row.settled === true,
  };
}

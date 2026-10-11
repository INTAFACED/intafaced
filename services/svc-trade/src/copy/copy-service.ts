/**
 * Copy trading service (trade.copy Stage — D-S-03 / SPEC-SOVEREIGN…).
 *
 * Default fee-share + jurisdiction laws are unpublished → follow and fee
 * payout refuse with DIRECTION §8 residual. Never invents leader_share_bps,
 * never pools funds, never ranks by returns, never charges on P&L.
 * Value moves only via ledger-client recipes when §8 rates are published.
 *
 * Follow/exposure state is durable via CopyFollowStore (Memory by default;
 * production mounts SqlCopyFollowStore — needs copy_follows + copy_mirrored_fills).
 * Product surface: tRPC `copy.*` on the trade router (follow / kill / unfollow /
 * pause / stop / detach / flatten / resume / settleFeeShare / deskStatus). Blank §8 env
 * laws refuse at the door. Pause/stop/detach never call flatten.
 */

import { randomUUID } from 'node:crypto';
import { formatAmount, parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import {
  autoMirrorPlaceStatus,
  copyLimitPriceFromPlan,
  copyMirrorClientOrderId,
  parseCopyPlaceMirrorFlag,
  COPY_AUTO_MIRROR_PLACE_RESIDUAL,
  COPY_AUTO_MIRROR_PLACE_SOCKET,
  COPY_PAPER_LIVE_RESIDUAL,
  COPY_PLACE_DISABLED_RESIDUAL,
  type InspectCopyMarket,
  type PlaceFollowerOrderPort,
} from './auto-mirror-place.js';
import { COPY_FEE_SHARE_RESIDUAL, COPY_JURISDICTION_RESIDUAL, CopyError } from './errors.js';
import {
  copyLawResidual,
  copyLawStatusLine,
  requirePublishedCopyFeeShareLaw,
  UNPUBLISHED_COPY_FEE_SHARE_LAW,
  UNPUBLISHED_COPY_JURISDICTION_LAW,
  type CopyFeeShareLaw,
  type CopyJurisdictionLaw,
} from './fee-share-law.js';
import { applyCopyFlatten, flattenFollowerCopyPosition, presentCopyFlattenAck, type FlattenCopyPositionPort } from './copy-flatten.js';
import {
  applyCopyDetach,
  applyCopyPause,
  applyCopyResume,
  applyCopyStop,
  followRelationshipState,
  presentCopyControlAck,
  requireCopyFollowId,
  requireNewCopyIntentAllowed,
} from './copy-lifecycle.js';
import { assertCopyRegionAllowed, copyRegionClosed, parseCopyEnvelope, presentCopyFollow, type CopyFollow } from './follows.js';
import {
  attributeCopyFeeShare,
  canonicalizeCopyFillId,
  planCopyFeeShareSettle,
  postCopyFeeShareSettle,
  presentFeeShareAttribution,
  refusePnlLinkedCopyFee,
} from './fee-share.js';
import { parseLeaderFillObservation, planMirror, presentMirrorPlan, refuseCopyLeaderRanking, type MirrorSide } from './mirror.js';
import {
  MemoryCopyFollowStore,
  isPendingFeeShareClaim,
  rethrowCopyFollowUnique,
  stampedPendingFeeShareReserve,
  type CopyFollowStore,
} from './follow-store.js';
import { generateCopySessionKey, requireUnrevokedCopySessionKey } from './session-key.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { TradingControlError } from '../controls/trading-controls.js';
import { businessPayload } from '../controls/business-payload.js';
import { bindEnvelopeLimits, type CopyLeaderLimitSettings } from './follower-limits.js';

/** Settled follower fill fee — `fills.fee_amount`, never a notional×bps invent. */
export type FollowerFillFee = {
  readonly fillId: string;
  readonly userId: string;
  readonly feeAsset: string;
  readonly feeAmount: Amount;
  /** Fill timestamp — refuse when before follow.createdAt (pre-follow volume). */
  readonly createdAt?: Date;
};

/** Production wires `trade.fills`. Absent or missing fill row → refuse-closed. */
export type LookupFollowerFillFeePort = (fillId: string) => Promise<FollowerFillFee | null>;

/** Settled leader fill — qty/notional/side/market come from the row, never the caller. */
export type LeaderFill = {
  readonly fillId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly side: MirrorSide;
  readonly qty: Amount;
  readonly notional: Amount;
};

/** Production wires `trade.fills`. Absent or missing fill row → refuse-closed. */
export type LookupLeaderFillPort = (fillId: string) => Promise<LeaderFill | null>;

const LEADER_FILL_MISSING = 'Leader fill not found — refuse rather than invent observation from caller qty/notional';

export interface CopyServiceOptions {
  feeShareLaw?: CopyFeeShareLaw;
  jurisdictionLaw?: CopyJurisdictionLaw;
  now?: () => Date;
  /** Defaults to in-memory. Production wires SqlCopyFollowStore. */
  store?: CopyFollowStore;
  /**
   * Follower spot place. Production wires TradeService.placeOrder as a limit
   * at the planned envelope. Absent → placeMirror refuse-closed.
   */
  placeFollowerOrder?: PlaceFollowerOrderPort;
  /** Mandatory for creating a live delegation; each mirror gets a separate decision. */
  accountAdmission?: TradingAdmissionPort;
  /**
   * Explicit operator flag. Default reads TRADE_COPY_PLACE_MIRROR (off).
   * Port wired + flag off still refuses by name.
   */
  placeMirrorEnabled?: boolean;
  /** Paper vs live honesty — never place live from a paper leader fill. */
  inspectMarket?: InspectCopyMarket;
  /**
   * Settled follower fill fee (`fills.fee_amount`). Required to settle.
   * Missing lookup or missing fill → refuse. Never a client `fillFeeAmount`.
   */
  lookupFollowerFillFee?: LookupFollowerFillFeePort;
  /**
   * Settled leader fill (`fills` qty / quote_amount / side / market).
   * Required to plan a mirror. Missing lookup or missing fill → refuse.
   * Never a client qty/notional.
   */
  lookupLeaderFill?: LookupLeaderFillPort;
  /**
   * Explicit flatten of the follower's copy position. Pause/stop never call
   * this. Absent → copy.flatten refuses rather than invent a close.
   */
  flattenCopyPosition?: FlattenCopyPositionPort;
}

type FollowRef = { followId: string };

type PlanMirrorInput = {
  followId: string;
  /** Leader fill business key — required; redelivery must not double-mirror. */
  fillId: string;
  /** Ignored. Observation market comes from the leader fill row. */
  marketId: string;
  /** Ignored. Observation side comes from the leader fill row. */
  side: MirrorSide;
  /** Ignored. Observation qty comes from the leader fill row. */
  qty: string;
  /** Ignored. Observation notional comes from the leader fill row. */
  notional: string;
  /**
   * Leader-recommended caps for this fill. Bound against the follower envelope;
   * never raises allocation / instruments / loss.
   */
  leaderSettings?: CopyLeaderLimitSettings;
  /** Realized session loss — required when the follower loss cap is set. */
  sessionLoss?: string;
};

type SettleFeeShareInput = {
  followId: string;
  fillId: string;
  assetId: string;
  followerFillNotional: string;
  protocolFeeBps: number;
  /** Ignored. Protocol fee is the fill row only — never a caller-invented pot. */
  fillFeeAmount?: string;
};

/** Blank / non-integer / out of 1..500 listMyFollows limit refuse. Never invent 50. */
export const TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET = 'trade.list_my_follows_limit_unset' as const;
export const LIST_MY_FOLLOWS_LIMIT_MAX = 500;

export class ListMyFollowsLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'ListMyFollowsLimitUnsetError';
  }
}

/** Owner-published copy desk window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedListMyFollowsLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > LIST_MY_FOLLOWS_LIMIT_MAX) {
    throw new ListMyFollowsLimitUnsetError('listMyFollows limit is unset — refuse to invent 50', TRADE_LIST_MY_FOLLOWS_LIMIT_UNSET);
  }
  return value;
}

export class CopyService {
  private readonly accountAdmission: TradingAdmissionPort | undefined;
  private readonly store: CopyFollowStore;
  private readonly feeShareLaw: CopyFeeShareLaw;
  private readonly jurisdictionLaw: CopyJurisdictionLaw;
  private readonly now: () => Date;
  private readonly placeFollowerOrder: PlaceFollowerOrderPort | null;
  private readonly placeMirrorEnabled: boolean;
  private readonly inspectMarket: InspectCopyMarket | null;
  private readonly lookupFollowerFillFee: LookupFollowerFillFeePort | null;
  private readonly lookupLeaderFill: LookupLeaderFillPort | null;
  private readonly flattenCopyPosition: FlattenCopyPositionPort | null;

  constructor(
    private readonly ledger: LedgerClient,
    options: CopyServiceOptions = {},
  ) {
    this.accountAdmission = options.accountAdmission;
    this.feeShareLaw = options.feeShareLaw ?? UNPUBLISHED_COPY_FEE_SHARE_LAW;
    this.jurisdictionLaw = options.jurisdictionLaw ?? UNPUBLISHED_COPY_JURISDICTION_LAW;
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? new MemoryCopyFollowStore();
    this.placeFollowerOrder = options.placeFollowerOrder ?? null;
    this.placeMirrorEnabled = options.placeMirrorEnabled ?? parseCopyPlaceMirrorFlag(process.env.TRADE_COPY_PLACE_MIRROR);
    this.inspectMarket = options.inspectMarket ?? null;
    this.lookupFollowerFillFee = options.lookupFollowerFillFee ?? null;
    this.lookupLeaderFill = options.lookupLeaderFill ?? null;
    this.flattenCopyPosition = options.flattenCopyPosition ?? null;
  }

  /**
   * Desk honesty for D26-P1-T3: sovereign shape is always on; rates /
   * jurisdiction stay refuse-closed until owner publishes P0-02 / P0-15.
   */
  deskStatus() {
    const feeSharePublished = this.feeShareLaw.published === true;
    const jurisdictionPublished = this.jurisdictionLaw.published === true;
    return {
      /** SPEC-SOVEREIGN §2–§4 — never invent pooling, P&L fees, or ranking. */
      sovereign: {
        shape: 'sovereign' as const,
        custody: false,
        feeModel: 'protocol_fee_share' as const,
        pnlFeeForbidden: true,
        rankingForbidden: true,
        killUnfollowReal: true,
      },
      feeSharePublished,
      leaderShareBps: feeSharePublished ? String(this.feeShareLaw.leaderShareBps) : null,
      jurisdictionPublished,
      statusLine: copyLawStatusLine(this.feeShareLaw, this.jurisdictionLaw),
      residual: copyLawResidual(this.feeShareLaw, this.jurisdictionLaw),
      residuals: {
        rates: feeSharePublished ? null : COPY_FEE_SHARE_RESIDUAL,
        jurisdiction: jurisdictionPublished ? null : COPY_JURISDICTION_RESIDUAL,
        autoMirrorPlace: this.placeMirrorEnabled && this.placeFollowerOrder ? null : COPY_PLACE_DISABLED_RESIDUAL,
      },
      autoMirrorPlace: autoMirrorPlaceStatus(this.placeMirrorEnabled && this.placeFollowerOrder !== null),
    };
  }

  /**
   * Place a planned mirror as a real follower spot limit at the plan envelope.
   * Flag off / blank §8 / paper→live refuse by name. Idempotent on fillId.
   */
  async placeMirrorForFollow(principal: Principal, input: { followId: string; fillId: string; leaderPaper: boolean }) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      if (!this.placeMirrorEnabled) {
        throw new CopyError(
          'copy.placeMirror is refuse-closed until TRADE_COPY_PLACE_MIRROR is on',
          'trade.copy_place_disabled',
          COPY_PLACE_DISABLED_RESIDUAL,
        );
      }
      requirePublishedCopyFeeShareLaw(this.feeShareLaw);

      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      await this.refuseIfFollowRegionClosed(store, follow);
      if (follow.envelope.expiresAt.getTime() <= this.now().getTime()) {
        throw new CopyError('Copy session envelope has expired', 'trade.copy_key_expired');
      }
      requireNewCopyIntentAllowed(follow);
      requireUnrevokedCopySessionKey(follow);
      const prior = await store.getMirroredFill(follow.followId, canonicalizeCopyFillId(input.fillId));
      if (!prior) {
        throw new CopyError(
          'No durable mirror plan for this fillId — planMirror first',
          'trade.copy_auto_mirror_place_socket',
          COPY_AUTO_MIRROR_PLACE_RESIDUAL,
        );
      }
      if (!this.placeFollowerOrder) {
        throw new CopyError(
          `Auto-mirror place into spot is refuse-closed (${COPY_AUTO_MIRROR_PLACE_SOCKET}) — planMirror claimed fill ${prior.fillId}; never invent a spot fill`,
          'trade.copy_auto_mirror_place_socket',
          COPY_AUTO_MIRROR_PLACE_RESIDUAL,
        );
      }

      const market = this.inspectMarket ? await this.inspectMarket(prior.marketId) : null;
      if (input.leaderPaper) {
        if (!market || market.paper !== true) {
          throw new CopyError(
            'Paper leader fill cannot place a live follower order',
            'trade.copy_paper_live_forbidden',
            COPY_PAPER_LIVE_RESIDUAL,
          );
        }
      } else if (market?.paper === true) {
        throw new CopyError(
          'Live leader fill cannot place onto a paper market',
          'trade.copy_paper_live_forbidden',
          COPY_PAPER_LIVE_RESIDUAL,
        );
      }

      const price = copyLimitPriceFromPlan(prior.qty, prior.notional);
      const once = await store.runPlaceMirrorOnce(follow.followId, prior.fillId, async () => {
        const clientOrderId = copyMirrorClientOrderId(follow.followId, prior.fillId);
        const placed = await this.placeFollowerOrder!(principal, {
          followId: follow.followId,
          symbol: prior.marketId,
          marketId: prior.marketId,
          side: prior.side,
          qty: prior.qty,
          price,
          clientOrderId,
        });
        return {
          followId: follow.followId,
          fillId: prior.fillId,
          orderId: placed.orderId,
          clientOrderId,
          price,
        };
      });

      return {
        followId: follow.followId,
        fillId: prior.fillId,
        orderId: once.record.orderId,
        marketId: prior.marketId,
        side: prior.side,
        qty: formatAmount(prior.qty),
        price: formatAmount(price),
        duplicate: once.status === 'duplicate',
      };
    });
  }

  /**
   * List the caller's own follows (product desk). Store filters by followerId —
   * never loads another user's envelope into this process.
   * Unset / null / non-int / out of 1..500 refuses — never invent 50.
   */
  async listMyFollows(principal: Principal, limit?: number) {
    const capped = publishedListMyFollowsLimit(limit);
    const mine = await this.store.listFollowsByFollower(principal.userId, capped);
    return Promise.all(
      mine.map(async (follow) => {
        const current = copyRegionClosed(this.jurisdictionLaw, follow.region)
          ? await this.store.runFollowExclusive(follow.followId, async (store) => {
              const latest = (await store.getFollow(follow.followId)) ?? follow;
              return this.persistClosedRegionFollow(store, latest);
            })
          : follow;
        const currentExposure = await this.store.getExposure(current.followId);
        return presentCopyFollow(current, currentExposure);
      }),
    );
  }

  /**
   * Detach every follow whose region is closed. Unpublished law closes all
   * regions. Never flattens, never moves value, never invents an allowlist.
   */
  async closeFollowsInClosedRegions() {
    const all = await this.store.listFollows();
    let closed = 0;
    let alreadyClosed = 0;
    let stillOpen = 0;
    for (const follow of all) {
      if (!copyRegionClosed(this.jurisdictionLaw, follow.region)) {
        stillOpen += 1;
        continue;
      }
      await this.store.runFollowExclusive(follow.followId, async (store) => {
        const latest = await store.getFollow(follow.followId);
        if (!latest || !copyRegionClosed(this.jurisdictionLaw, latest.region)) return;
        if (followRelationshipState(latest) === 'DETACHED') {
          alreadyClosed += 1;
          return;
        }
        await store.saveFollow(applyCopyDetach(latest));
        closed += 1;
      });
    }
    return { scanned: all.length, closed, alreadyClosed, stillOpen, flattenInvented: false as const };
  }

  /**
   * Follow a leader under a scoped envelope. Jurisdiction law must be published.
   * Does not move value — follower funds stay in follower account.
   */
  async follow(
    principal: Principal,
    input: {
      leaderId: string;
      region: string;
      permittedMarkets: readonly string[];
      maxNotionalPerOrder: string;
      maxAggregateExposure: string;
      /** Independent follower loss cap. Required when leaderSettings.maxLoss is set. */
      maxLoss?: string;
      expiresAt: string;
      /** Leader recommendations — clamp only; never raise follower caps. */
      leaderSettings?: CopyLeaderLimitSettings;
    },
  ) {
    const region = assertCopyRegionAllowed(this.jurisdictionLaw, input.region);
    const leaderId = input.leaderId.trim();
    if (!leaderId) {
      throw new CopyError('leaderId is required', 'trade.copy_envelope_invalid');
    }
    if (leaderId === principal.userId) {
      throw new CopyError('Cannot follow yourself', 'trade.copy_self_follow');
    }

    for (const f of await this.store.listFollowsByFollower(principal.userId)) {
      if (f.leaderId === leaderId) {
        throw new CopyError('Already following this leader', 'trade.copy_already_following');
      }
    }

    const envelope = bindEnvelopeLimits(
      parseCopyEnvelope({
        permittedMarkets: input.permittedMarkets,
        maxNotionalPerOrder: input.maxNotionalPerOrder,
        maxAggregateExposure: input.maxAggregateExposure,
        maxLoss: input.maxLoss,
        expiresAt: input.expiresAt,
        now: this.now(),
      }),
      input.leaderSettings,
    );

    const follow: CopyFollow = {
      followId: randomUUID(),
      followerId: principal.userId,
      leaderId,
      envelope,
      region,
      createdAt: this.now(),
      feeShareKilled: false,
      relationshipState: 'ACTIVE',
    };
    if (!this.accountAdmission) throw new TradingControlError('authority.unavailable');
    await this.accountAdmission.admit(
      principal,
      'strategy.start',
      `copy.follow:${follow.followId}`,
      businessPayload({
        followId: follow.followId,
        followerId: follow.followerId,
        leaderId: follow.leaderId,
        envelope: follow.envelope,
        region: follow.region,
        createdAt: follow.createdAt,
      }),
    );
    try {
      await this.store.saveFollow(follow, 0n);
    } catch (err) {
      if (err instanceof CopyError) throw err;
      rethrowCopyFollowUnique(err);
    }
    return presentCopyFollow(follow);
  }

  /** Unilateral unfollow — does not require fee-share law; always allowed. */
  async unfollow(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      // The churn counters deliberately SURVIVE this.
      //
      // They are keyed `leader:follower`, not on `followId`, and that is correct:
      // SPEC-SOVEREIGN caps leader earnings "per follower per period" and decays
      // the rate with turnover, so the unit is the pair and the period — not the
      // envelope. Clearing them here would make `unfollow` — which is unilateral,
      // needs no law, and is always allowed — a free reset of the abuse brake:
      // farm to the cap, unfollow, re-follow, farm again, unbounded, for the cost
      // of two API calls. That is precisely what the cap exists to stop.
      //
      // (The counters are in fact LIFETIME rather than per-period today, because
      // `copy_period_stats` has no period column. That is a real gap and the fix
      // is a period key, not a user-triggered delete.)
      await store.deleteFollow(follow.followId);
      return { followId: follow.followId, revoked: true as const };
    });
  }

  /**
   * Grant a durable auto-mirror session-key. Raw shown once; hash at rest.
   * Rotates an existing grant. Envelope expiry is not this key.
   */
  async grantSessionKey(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      await this.refuseIfFollowRegionClosed(store, follow);
      const generated = generateCopySessionKey();
      const next: CopyFollow = {
        ...follow,
        sessionKeyHash: generated.hash,
        sessionKeyPrefix: generated.prefix,
        sessionKeyRevoked: false,
      };
      await store.saveFollow(next);
      const currentExposure = await store.getExposure(follow.followId);
      return {
        ...presentCopyFollow(next, currentExposure),
        sessionKeyId: generated.id,
        sessionKey: generated.key,
      };
    });
  }

  /** Revoke the auto-mirror session-key. Follow may remain; subsequent place refuses. */
  async killSessionKey(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      const next: CopyFollow = { ...follow, sessionKeyRevoked: true };
      await store.saveFollow(next);
      const currentExposure = await store.getExposure(follow.followId);
      return presentCopyFollow(next, currentExposure);
    });
  }

  /**
   * Pause new mirrors immediately (PAUSE_NEW). Existing orders/positions continue.
   * Does not call flatten. Missing follow id refuses.
   */
  async pause(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      const next = applyCopyPause(follow);
      await store.saveFollow(next);
      return presentCopyControlAck(next, 'PAUSE_NEW');
    });
  }

  /**
   * Resume after pause. Follower-only — the leader cannot force-resume.
   * Stopped/detached follows cannot resume; that would invent a new consent.
   */
  async resume(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId, { refuseLeaderResume: true });
      await this.refuseIfFollowRegionClosed(store, follow);
      const next = applyCopyResume(follow);
      await store.saveFollow(next);
      return presentCopyControlAck(next, 'RESUME');
    });
  }

  /**
   * STOP_NEW — fence new intent and revoke the auto-mirror grant.
   * Does not call flatten or cancel-open.
   */
  async stop(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      const next = applyCopyStop(follow);
      await store.saveFollow(next);
      return presentCopyControlAck(next, 'STOP_NEW');
    });
  }

  /**
   * DETACH_KEEP — stop copying; leave existing orders/positions with the follower.
   * Does not call flatten.
   */
  async detach(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      const next = applyCopyDetach(follow);
      await store.saveFollow(next);
      return presentCopyControlAck(next, 'DETACH_KEEP');
    });
  }

  /**
   * DETACH_FLATTEN — follower-chosen close of the copy position.
   * Pause/stop/detach never call this. Missing follow id refuses.
   */
  async flatten(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      const closed = await flattenFollowerCopyPosition(principal, follow, this.flattenCopyPosition);
      const next = applyCopyFlatten(follow);
      await store.saveFollow(next);
      return presentCopyFlattenAck(next, closed.orderIds);
    });
  }

  /** Kill fee-share for a follow (churn / abuse brake). Follow may remain. */
  async killFeeShare(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      const next: CopyFollow = { ...follow, feeShareKilled: true };
      await store.saveFollow(next);
      const currentExposure = await store.getExposure(follow.followId);
      return presentCopyFollow(next, currentExposure);
    });
  }

  /**
   * Plan a mirror of a leader fill for one of the caller's follows.
   * Typed refuse on cap / market / expiry — never invent a different shape.
   *
   * `fillId` is required (engine business key). Size/side/market come from the
   * leader fill row — never caller qty/notional. The store claims each fillId
   * once per follow: a redelivered observation returns the prior plan and does
   * not bump exposure a second time. Same shape as fee-share settle's fillId.
   *
   * Exposure is claimed inside `claimMirrorFill` under the same exclusive key
   * as `addExposureIfUnderCap` (#1191), so concurrent distinct fills still
   * cannot both pass a stale near-cap read.
   */
  async planMirrorForFollow(principal: Principal, input: PlanMirrorInput) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), (store) =>
      this.planMirrorForFollowExclusive(store, principal, input),
    );
  }

  private async planMirrorForFollowExclusive(store: CopyFollowStore, principal: Principal, input: PlanMirrorInput) {
    const follow = await this.requireOwnedFollow(store, principal, input.followId);
    await this.refuseIfFollowRegionClosed(store, follow);
    requireNewCopyIntentAllowed(follow);

    const gated = { ...follow, envelope: bindEnvelopeLimits(follow.envelope, input.leaderSettings) };
    if (gated.envelope.maxLoss !== undefined) {
      const sessionLossRaw = input.sessionLoss?.trim();
      if (!sessionLossRaw) {
        throw new CopyError(
          'Follower session loss is required when a loss limit is set — refuse rather than invent',
          'trade.copy_limit_missing',
        );
      }
      let sessionLoss: Amount;
      try {
        sessionLoss = parseAmount(sessionLossRaw);
      } catch {
        throw new CopyError('sessionLoss must be a valid decimal amount', 'trade.copy_envelope_invalid');
      }
      if (sessionLoss < 0n) {
        throw new CopyError('sessionLoss must not be negative', 'trade.copy_envelope_invalid');
      }
      if (sessionLoss >= gated.envelope.maxLoss) {
        throw new CopyError(
          `Session loss ${formatAmount(sessionLoss)} exceeds follower loss cap ${formatAmount(gated.envelope.maxLoss)}`,
          'trade.copy_cap_exceeded',
        );
      }
    } else if (input.sessionLoss?.trim()) {
      throw new CopyError('Follower loss limit is required — refuse rather than inherit a leader cap', 'trade.copy_limit_missing');
    }

    const fillId = this.canonicalMirrorFillId(input.fillId);
    // Fast path: already claimed this leader fill under this follow.
    const prior = await store.getMirroredFill(follow.followId, fillId);
    if (prior) {
      return presentMirrorPlan({ ...prior, reason: 'within_envelope' });
    }

    const observation = await this.observationFromLeaderFill(follow, fillId);

    const current = await store.getExposure(follow.followId);
    // Envelope / market / expiry / per-order checks — may throw typed refuse.
    // Cap is re-checked inside claimMirrorFill under the follow exclusive lock
    // so a concurrent first-claim cannot overshoot even if this read is stale.
    const planned = planMirror({
      follow: gated,
      observation,
      currentExposure: current,
      now: this.now(),
    });

    const claimed = await store.claimMirrorFill({
      followId: follow.followId,
      fillId: observation.fillId,
      maxAggregate: gated.envelope.maxAggregateExposure,
      plan: {
        fillId: planned.fillId,
        followId: planned.followId,
        followerId: planned.followerId,
        leaderId: planned.leaderId,
        marketId: planned.marketId,
        side: planned.side,
        qty: planned.qty,
        notional: planned.notional,
      },
    });

    if (claimed.status === 'duplicate') {
      // Lost the race to another delivery of the same fill — return its plan.
      return presentMirrorPlan({ ...claimed.plan, reason: 'within_envelope' });
    }
    if (claimed.status === 'cap_exceeded') {
      throw new CopyError(
        `Mirror would exceed aggregate exposure cap ${formatAmount(gated.envelope.maxAggregateExposure)}`,
        'trade.copy_cap_exceeded',
      );
    }
    return presentMirrorPlan({ ...claimed.plan, reason: 'within_envelope' });
  }

  private canonicalMirrorFillId(fillId: string): string {
    const trimmed = fillId.trim();
    if (!trimmed) {
      throw new CopyError('Leader fill id required — without it a redelivered fill would mirror twice', 'trade.copy_envelope_invalid');
    }
    if (trimmed.length > 128) {
      throw new CopyError('Leader fill id exceeds 128 chars', 'trade.copy_envelope_invalid');
    }
    return canonicalizeCopyFillId(trimmed);
  }

  /**
   * Observation size/side/market from the leader fill row. Caller qty/notional
   * never plan a mirror.
   */
  private async observationFromLeaderFill(follow: CopyFollow, fillId: string) {
    if (!this.lookupLeaderFill) {
      throw new CopyError(LEADER_FILL_MISSING, 'trade.copy_leader_fill_not_found');
    }
    const fill = await this.lookupLeaderFill(fillId);
    if (!fill) {
      throw new CopyError(LEADER_FILL_MISSING, 'trade.copy_leader_fill_not_found');
    }
    if (fill.userId !== follow.leaderId) {
      throw new CopyError(
        'Fill does not belong to this leader — refuse rather than invent observation',
        'trade.copy_leader_fill_not_found',
      );
    }
    return parseLeaderFillObservation({
      fillId,
      leaderId: follow.leaderId,
      marketId: fill.marketId,
      side: fill.side,
      qty: formatAmount(fill.qty),
      notional: formatAmount(fill.notional),
      observedAt: this.now(),
    });
  }

  /**
   * Protocol fee is the fill's collected fee_amount. Never notional×bps
   * and never a caller fillFeeAmount. Missing lookup or missing fill → refuse.
   */
  private async resolveSettledProtocolFee(follow: CopyFollow, fillId: string, assetId: string): Promise<Amount> {
    if (!this.lookupFollowerFillFee) {
      throw new CopyError('Follower fill not found — refuse rather than invent protocolFee from notional×bps', 'trade.copy_settle_refused');
    }
    const fill = await this.lookupFollowerFillFee(fillId);
    if (!fill) {
      throw new CopyError('Follower fill not found — refuse rather than invent protocolFee from notional×bps', 'trade.copy_settle_refused');
    }
    if (fill.userId !== follow.followerId) {
      throw new CopyError('Fill does not belong to this follower — refuse fee-share', 'trade.copy_settle_refused');
    }
    if (fill.feeAsset !== assetId) {
      throw new CopyError('Fill fee asset does not match settle asset — refuse fee-share', 'trade.copy_settle_refused');
    }
    if (fill.feeAmount < 0n) {
      throw new CopyError('fillFeeAmount must not be negative', 'trade.copy_settle_refused');
    }
    const filledAt = fill.createdAt?.getTime();
    if (filledAt === undefined || Number.isNaN(filledAt) || filledAt < follow.createdAt.getTime()) {
      throw new CopyError('Fill predates this follow — refuse fee-share', 'trade.copy_settle_refused');
    }
    return fill.feeAmount;
  }

  /**
   * Attribute + settle leader fee-share for a follower fill via ledger-client.
   * Blank §8 rates → refuse. Cap / kill → typed skip or refuse.
   *
   * ── Reserve-then-post (closes the concurrent over-pay race) ───────────────
   *
   * Order: attribute gross/capped intent → **atomic reserve** under the period
   * cap → post ledger with the reserved amount → **release** on ledger failure.
   * Two fills with different fillIds (different business keys) can no longer
   * both pass a stale earningsPaid read and both move money past the cap.
   *
   * Ledger keys stay on fillId. Period boundary (D11) is not invented here —
   * pair-lifetime counters remain as today.
   * Expired envelope refuses (same as placeMirror). One fillId pays one
   * leader (global settle once-key). Fill must be copy-mirrored under this
   * follow and not predate follow.createdAt.
   * Same-fill redelivery on the mirror path is closed via claimMirrorFill.
   * Same-fill redelivery on **this** path is closed via runFeeShareSettleOnce —
   * unique fill_id is claimed **before** ledger recipes so a crash after post
   * cannot pay a second leader (`copy-leader-share:${fillId}:${leaderId}`).
   * A throw after sweep/payout keeps that claim (do not DELETE). Same-follow
   * pending retries `run` (keys `copy-fee:${fillId}` /
   * `copy-leader-share:${fillId}:${leaderId}` are idempotent). Unclaim CopyError
   * only when this call INSERTed **and reserve has not run** — leftover
   * pending retry and post-reserve CopyError (stamp 0-row) keep the row.
   * Pending retry must not re-reserve when this fill already occupied cap
   * (stamped `cappedLeaderShare` on the pending row). Reserve+stamp is one
   * step so leftover stamp-0 cannot mean both never-reserved and reserved-
   * stamp-lost. Crash after post / before UPDATE would persist cap_reached
   * over a paid fill and burn cap twice. Post-throw does **not**
   * releaseEarnings while unique fill_id is kept — a burned cap slot is
   * better than over-pay. Leftover retry re-posts the persisted reserved
   * amount, never gross.
   */
  async settleFeeShare(principal: Principal, input: SettleFeeShareInput) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), (store) =>
      this.settleFeeShareExclusive(store, principal, input),
    );
  }

  private async persistClosedRegionFollow(store: CopyFollowStore, follow: CopyFollow): Promise<CopyFollow> {
    if (followRelationshipState(follow) === 'DETACHED') return follow;
    const next = applyCopyDetach(follow);
    await store.saveFollow(next);
    return next;
  }

  /** Detach then named refuse — never flatten, never invent geo. */
  private async refuseIfFollowRegionClosed(store: CopyFollowStore, follow: CopyFollow): Promise<void> {
    const closed = copyRegionClosed(this.jurisdictionLaw, follow.region);
    if (!closed) return;
    await this.persistClosedRegionFollow(store, follow);
    throw closed;
  }

  private async requireOwnedFollow(
    store: CopyFollowStore,
    principal: Principal,
    followId: string,
    opts: { refuseLeaderResume?: boolean } = {},
  ): Promise<CopyFollow> {
    const id = requireCopyFollowId(followId);
    const follow = await store.getFollow(id);
    if (!follow) {
      throw new CopyError('Follow not found', 'trade.copy_not_following');
    }
    if (opts.refuseLeaderResume && follow.leaderId === principal.userId) {
      throw new CopyError('Leader cannot force-resume a follower copy session', 'trade.copy_leader_resume_forbidden');
    }
    if (follow.followerId !== principal.userId) {
      throw new CopyError('Follow belongs to another user', 'trade.copy_not_following');
    }
    return follow;
  }

  private async settleFeeShareExclusive(store: CopyFollowStore, principal: Principal, input: SettleFeeShareInput) {
    const follow = await this.requireOwnedFollow(store, principal, input.followId);
    await this.refuseIfFollowRegionClosed(store, follow);
    if (follow.envelope.expiresAt.getTime() <= this.now().getTime()) {
      throw new CopyError('Copy session envelope has expired', 'trade.copy_key_expired');
    }

    const fillId = canonicalizeCopyFillId(input.fillId);
    const assetId = input.assetId.trim();
    const once = await store.runFeeShareSettleOnce(follow.followId, fillId, async (ctx) => {
      const key = `${follow.leaderId}:${follow.followerId}`;
      const period = await store.getPeriodStats(key);
      requirePublishedCopyFeeShareLaw(this.feeShareLaw);
      const mirrored = await store.getMirroredFill(follow.followId, fillId);
      if (!mirrored) {
        throw new CopyError('Fill is not a copy-mirrored fill for this follow — refuse fee-share', 'trade.copy_settle_refused');
      }
      const settledFee = await this.resolveSettledProtocolFee(follow, fillId, assetId);
      const attribution = attributeCopyFeeShare({
        law: this.feeShareLaw,
        fillId,
        leaderId: follow.leaderId,
        followerId: follow.followerId,
        assetId,
        followerFillNotional: parseAmount(input.followerFillNotional),
        protocolFeeBps: input.protocolFeeBps,
        fillFeeAmount: settledFee,
        roundTripsThisPeriod: period.roundTrips,
        earningsPaidThisPeriod: period.earningsPaid,
        feeShareKilled: follow.feeShareKilled,
      });

      // Cap is owner-published law only — never invent. requirePublished ran inside attribute.
      const law = this.feeShareLaw;
      if (law.published !== true) {
        // attributeCopyFeeShare already throws on blank; this is defensive for types.
        throw new CopyError(
          'Copy fee-share is refuse-closed until owner publishes DIRECTION §8 / D26-P0-02 leader_share_bps',
          'trade.copy_fee_share_blank',
          COPY_FEE_SHARE_RESIDUAL,
        );
      }
      const cap = parseAmount(law.earningsCapPerFollower);

      // Intended claim: 0 when attribute already skipped (cap/zero), else capped share.
      // First INSERT reserves and stamps in one step before post. Leftover
      // retry uses that stamp (ledger keys copy-fee:${fillId} /
      // copy-leader-share:${fillId}:${leaderId} are idempotent). Never post
      // grossLeaderShare. Stamp 0-row throws (do not post unstamped) and rolls
      // the reserve back — leftover stamp-0 means never reserved and may
      // reserve once. A committed reserve is distinguishable on the pending
      // row (cappedLeaderShare > 0); leftover must not re-reserve.
      const intend = attribution.skippedReason !== null ? 0n : attribution.cappedLeaderShare;
      let reservedAmount: Amount;
      if (ctx.insertedThisCall) {
        ctx.reservedThisCall = true;
        const reserved = await store.reserveAndStampPendingFeeShare(key, intend, cap, follow.followId, fillId);
        reservedAmount = reserved.reserved;
      } else {
        const pending = await store.getSettledFeeShare(follow.followId, fillId);
        const alreadyReserved = stampedPendingFeeShareReserve(pending);
        if (alreadyReserved > 0n) {
          reservedAmount = alreadyReserved;
        } else if (intend > 0n) {
          ctx.reservedThisCall = true;
          const reserved = await store.reserveAndStampPendingFeeShare(key, intend, cap, follow.followId, fillId);
          reservedAmount = reserved.reserved;
        } else {
          reservedAmount = 0n;
        }
      }

      if (reservedAmount <= 0n) {
        if (!ctx.insertedThisCall) {
          const pending = await store.getSettledFeeShare(follow.followId, fillId);
          if (pending && isPendingFeeShareClaim(pending)) {
            throw new CopyError(
              'Pending fee-share has no stamped reserve — refuse rather than stamp skip over a reserved fill',
              'trade.copy_settle_refused',
            );
          }
        }
        const skipped =
          attribution.skippedReason !== null
            ? attribution
            : {
                ...attribution,
                cappedLeaderShare: 0n,
                skippedReason: 'cap_reached' as const,
              };
        return {
          fillId: skipped.fillId,
          followId: follow.followId,
          leaderId: skipped.leaderId,
          followerId: skipped.followerId,
          assetId: skipped.assetId,
          protocolFee: skipped.protocolFee,
          appliedShareBps: skipped.appliedShareBps,
          grossLeaderShare: skipped.grossLeaderShare,
          cappedLeaderShare: skipped.cappedLeaderShare,
          skippedReason: skipped.skippedReason,
          settled: false as const,
        };
      }

      const finalAttribution = {
        ...attribution,
        cappedLeaderShare: reservedAmount,
        skippedReason: null as null,
      };
      const plan = planCopyFeeShareSettle(finalAttribution);
      await postCopyFeeShareSettle(this.ledger, plan);
      return {
        fillId: finalAttribution.fillId,
        followId: follow.followId,
        leaderId: finalAttribution.leaderId,
        followerId: finalAttribution.followerId,
        assetId: finalAttribution.assetId,
        protocolFee: finalAttribution.protocolFee,
        appliedShareBps: finalAttribution.appliedShareBps,
        grossLeaderShare: finalAttribution.grossLeaderShare,
        cappedLeaderShare: finalAttribution.cappedLeaderShare,
        skippedReason: null as null,
        settled: true as const,
      };
    });

    const record = once.record;
    return {
      ...presentFeeShareAttribution({
        fillId: record.fillId,
        leaderId: record.leaderId,
        followerId: record.followerId,
        assetId: record.assetId,
        protocolFee: record.protocolFee,
        appliedShareBps: record.appliedShareBps,
        grossLeaderShare: record.grossLeaderShare,
        cappedLeaderShare: record.cappedLeaderShare,
        skippedReason: record.skippedReason,
      }),
      settled: record.settled,
    };
  }

  /** Forbidden surfaces — explicit refuse for honesty tests. */
  rankLeadersByReturns(): never {
    return refuseCopyLeaderRanking();
  }

  chargePnlPerformanceFee(): never {
    return refusePnlLinkedCopyFee();
  }
}

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

import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { requireScope, type Principal } from '@intafaced/auth';
import type { AlgoQuotedMark } from '../algo/types.js';
import {
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
import { logRefusalSpec } from '../refusal-spec-log.js';
import { presentCopyOpsStatus, presentCustomerCopyDesk, type CopyDeskFacts } from './desk-status.js';
import { COPY_FEE_SHARE_RESIDUAL, CopyError } from './errors.js';
import { NO_COPY_NOTICES, type CopyNotices } from './copy-notices.js';
import {
  requirePublishedCopyFeeShareLaw,
  UNPUBLISHED_COPY_FEE_SHARE_LAW,
  UNPUBLISHED_COPY_JURISDICTION_LAW,
  type CopyFeeShareLaw,
  type CopyJurisdictionLaw,
} from './fee-share-law.js';
import {
  applyCopyFlatten,
  COPY_FLATTEN_REFUSED_RESIDUAL,
  flattenFollowerCopyPosition,
  presentCopyFlattenAck,
  type FlattenCopyPositionPort,
} from './copy-flatten.js';
import {
  applyCopyDetach,
  applyCopyLeave,
  applyCopyPause,
  applyCopyResume,
  applyCopyStop,
  applyCopyStopCloseOnly,
  followRelationshipState,
  presentCopyControlAck,
  requireCopyFollowId,
  requireNewCopyIntentAllowed,
} from './copy-lifecycle.js';
import {
  assertCopyRegionAllowed,
  copyRegionClosed,
  parseCopyEnvelope,
  presentCopyFollow,
  type CopyCursor,
  type CopyFollow,
} from './follows.js';
import { TradeError } from '../spot/types.js';
import { randomUUID } from 'node:crypto';
import { assertMayFollow, assertReserveFits, copyFollowIdFor, copyQuoteAsset, freeSpotBalance, type CopyTier } from './follow-gate.js';
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
import { captureAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { TradingControlError } from '../controls/trading-controls.js';
import { businessPayload } from '../controls/business-payload.js';
import {
  bindCopyFollowerLimits,
  bindEnvelopeLimits,
  envelopeWithBoundLimits,
  followerLimitsFromEnvelope,
  type CopyLeaderLimitSettings,
} from './follower-limits.js';
import { assertCopyConcurrency, assertCopySlippage, assertLeverageUnsupported, drawdownDecision } from './follow-limits-extra.js';
import { followResultFigure, readFollowResult, type FollowResult } from './follow-result.js';
import {
  MemoryMirrorEventLog,
  observeCopyMirrorFill,
  recordPlaceMirrorEvents,
  recordPlanMirrorEvents,
  type CopyMirrorFillNotice,
  type MirrorEventLog,
} from './mirror-events.js';
import { exportMirrorTrail, listMirrorTrail, type MirrorTrailPage, type MirrorTrailQuery } from './mirror-trail.js';
import {
  LeaderDirectory,
  memoryLeaderDirectory,
  type ListLeadersQuery,
  type OperatorListingResult,
  type SetLeaderStateInput,
} from './leader-directory.js';
import type { LeaderDirectoryPage } from './leader-listing.js';
import {
  decodeLeaderTradesCursor,
  leaderTradesLimit,
  pageLeaderTrades,
  pairLeaderTrades,
  UNPUBLISHED_COPY_METRIC_DEFINITIONS,
  presentLeaderProfile,
  readLeaderOrderFills,
  type CopyMetricDefinitions,
  type LeaderProfile,
  type LeaderTradesPage,
} from './leader-profile.js';
import type { LeaderEventsPage } from './leader-events.js';
import type { UpsertLeaderListingInput } from './leader-listing.js';
import { CopyCloseError } from './copy-close-errors.js';
import { copyCloseAttemptKey, copyCloseKey, type CopyClosePort } from './copy-close.js';
import { copiedPositionWire, sellableInMarket, sqlCopiedPositions, type ReadCopiedPositions } from './copied-positions.js';
import { COPY_SKIP_LOG_LIMIT, asCopySkipReason, copySkipReasonFor, isCopySkipRefusal, recordCopySkip } from './skip-log.js';

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
  /** Leader fill price. Absent → a slippage cap cannot be evaluated. */
  readonly price?: Amount;
};

/** Production wires `trade.fills`. Absent or missing fill row → refuse-closed. */
export type LookupLeaderFillPort = (fillId: string) => Promise<LeaderFill | null>;

/** One copied order on a follow, as its follower sees it. */
export type CopyPosition = {
  readonly orderId: string;
  readonly market: string;
  readonly side: 'buy' | 'sell';
  readonly qty: string;
  readonly filledQty: string;
  readonly price: string;
  readonly status: string;
  readonly placedAt: string;
};

/**
 * A leader's own live spot fills after `after` (by time, then fill id), oldest first, at most `limit`, each with its
 * time. The copy driver reads ids and markets only; each copy still reads its fill through `lookupLeaderFill`.
 */
export type ListLeaderFillsSincePort = (
  leaderId: string,
  after: CopyCursor,
  limit: number,
) => Promise<ReadonlyArray<{ readonly fillId: string; readonly marketId: string; readonly at: Date }>>;

const LEADER_FILL_MISSING = 'Leader fill not found — refuse rather than invent observation from caller qty/notional';

export interface CopyServiceOptions {
  feeShareLaw?: CopyFeeShareLaw;
  /** Tells the follower about a skip or a stop (`trade.copy.skipped` / `.stopped`, J-copy-bots-otc-03 #6). Omitted → nobody is told. */
  notices?: CopyNotices;
  /**
   * What the follower's grid bots still reserve of one asset (grid/store.ts sumUnusedReserves). Read under the same
   * reserve lock a grid create takes, so a follow and a grid never both fit the same balance. Omitted → none.
   */
  gridUnusedReserves?: (userId: string, asset: string) => Promise<Amount>;
  /** Owner's verification level for copying (TRADE_COPY_MIN_TIER). Omitted → every startFollow refuses. */
  minTier?: CopyTier | null;
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
  /** The copy driver's read of new leader fills. Absent → the driver copies nothing (copies only by hand). */
  listLeaderFillsSince?: ListLeaderFillsSincePort;
  /**
   * Explicit flatten of the follower's copy position. Pause/stop never call
   * this. Absent → copy.flatten refuses rather than invent a close.
   */
  flattenCopyPosition?: FlattenCopyPositionPort;
  /** Append-only mirror trail. Production wires SqlMirrorEventLog. */
  mirrorEvents?: MirrorEventLog;
  /** Spot tables for the result and the trail. Absent → those reads refuse. */
  sql?: Sql;
  /**
   * Book mid the algo engine's markFor reads, then gated by acceptableForAlgo.
   * Absent → unrealised P&L is null with trade.mark_unavailable.
   */
  lookupMark?: (marketId: string) => Promise<AlgoQuotedMark | null>;
  /** Operator-published leader directory. Omitted → in-memory, empty until an operator writes. */
  directory?: LeaderDirectory;
  /** Owner wording for each lead-page metric. Omitted → unpublished, every metric reads "not set". */
  metricDefinitions?: CopyMetricDefinitions;
  /**
   * Result figure for the drawdown stop. Production reads `followResultFigure`.
   * A null figure refuses; this port must not invent one.
   */
  readResultFigure?: (follow: CopyFollow) => Promise<{ figure: Amount | null; missing: string | null }>;
  /** The follow's copied positions (CB-copy-09/10). Defaults to the SQL reader when `sql` is wired. */
  copiedPositions?: ReadCopiedPositions;
  /** A follower's close of one copied position (CB-copy-10). Absent → copy.closePosition refuses. */
  copyClose?: CopyClosePort;
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
  /**
   * Leader fill id — the mirror claim. `lookupLeaderFill` still requires that
   * row to belong to the leader. This id is not the follower's fills row.
   */
  fillId: string;
  /**
   * Follower's own fills row. Fee lookup reads this id and still requires
   * that row to belong to the follower. Omitted → look up `fillId`, which
   * refuses when that row is the leader's. Missing row refuses. Never
   * notional×bps.
   */
  followerFillId?: string;
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
  private readonly listLeaderFillsSince: ListLeaderFillsSincePort | null;
  private readonly flattenCopyPosition: FlattenCopyPositionPort | null;
  private readonly mirrorEvents: MirrorEventLog;
  private readonly sql: Sql | null;
  private readonly lookupMark: ((marketId: string) => Promise<AlgoQuotedMark | null>) | null;
  private readonly directory: LeaderDirectory;
  private readonly metricDefinitions: CopyMetricDefinitions;
  private readonly minTier: CopyTier | null;
  private readonly readResultFigure: ((follow: CopyFollow) => Promise<{ figure: Amount | null; missing: string | null }>) | null;
  private readonly gridUnusedReserves: (userId: string, asset: string) => Promise<Amount>;
  private readonly copiedPositionsPort: ReadCopiedPositions | null;
  private readonly copyClose: CopyClosePort | null;
  private readonly notices: CopyNotices;

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
    this.listLeaderFillsSince = options.listLeaderFillsSince ?? null;
    this.flattenCopyPosition = options.flattenCopyPosition ?? null;
    this.mirrorEvents = options.mirrorEvents ?? new MemoryMirrorEventLog();
    this.sql = options.sql ?? null;
    this.lookupMark = options.lookupMark ?? null;
    this.readResultFigure = options.readResultFigure ?? null;
    this.gridUnusedReserves = options.gridUnusedReserves ?? (async () => 0n);
    this.copiedPositionsPort = options.copiedPositions ?? (options.sql ? sqlCopiedPositions(options.sql) : null);
    this.copyClose = options.copyClose ?? null;
    this.notices = options.notices ?? NO_COPY_NOTICES;
    // Read like TRADE_COPY_PLACE_MIRROR above; env.ts declares it. Invalid JSON fails boot.
    this.metricDefinitions = options.metricDefinitions ?? UNPUBLISHED_COPY_METRIC_DEFINITIONS;
    this.minTier = options.minTier ?? null;
    this.directory =
      options.directory ??
      memoryLeaderDirectory({
        now: this.now,
        feeShareLaw: this.feeShareLaw,
        countActive: (leaderId) => this.store.countActiveFollowsByLeader(leaderId),
      });
  }

  private async presentFollow(follow: CopyFollow, currentExposure: Amount = 0n) {
    return presentCopyFollow(follow, currentExposure, await this.directory.listingIdentity(follow.leaderId));
  }

  private deskFacts(): CopyDeskFacts {
    return {
      mounted: true,
      fee: this.feeShareLaw,
      jurisdiction: this.jurisdictionLaw,
      placeEnabled: this.placeMirrorEnabled && this.placeFollowerOrder !== null,
    };
  }

  /** Customer desk. Codes only — sentences are on opsStatus. */
  deskStatus() {
    return presentCustomerCopyDesk(this.deskFacts());
  }

  /** Operator desk. Same codes, plus the sentences. */
  opsStatus() {
    return presentCopyOpsStatus(this.deskFacts());
  }

  /** Blank-law refusals carry the same blocker codes as deskStatus. */
  private blankLawRefusal(err: unknown): never {
    if (err instanceof CopyError && (err.code === 'trade.copy_fee_share_blank' || err.code === 'trade.copy_jurisdiction_blank')) {
      throw new CopyError(err.message, err.code, err.residual, err.orderIds, this.deskStatus().blockers);
    }
    throw err;
  }

  /**
   * Place a planned mirror as a real follower spot limit at the plan envelope.
   * Flag off / blank §8 / paper→live refuse by name. Idempotent on fillId.
   */
  async placeMirrorForFollow(principal: Principal, input: { followId: string; fillId: string; leaderPaper: boolean }) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), (store) =>
      recordPlaceMirrorEvents(this.mirrorEvents, store, principal, input, this.now(), async () => {
        let follow: CopyFollow;
        try {
          follow = await this.requireOwnedFollow(store, principal, input.followId);
        } catch (err) {
          // Flag off stays the public door: a missing follow must not become "not found".
          if (!this.placeMirrorEnabled && err instanceof CopyError && err.code === 'trade.copy_not_following') {
            throw new CopyError(
              'copy.placeMirror is refuse-closed until TRADE_COPY_PLACE_MIRROR is on',
              'trade.copy_place_disabled',
              COPY_PLACE_DISABLED_RESIDUAL,
            );
          }
          throw err;
        }
        await this.directory.refuseNewMirror(follow.leaderId);
        if (!this.placeMirrorEnabled) {
          throw new CopyError(
            'copy.placeMirror is refuse-closed until TRADE_COPY_PLACE_MIRROR is on',
            'trade.copy_place_disabled',
            COPY_PLACE_DISABLED_RESIDUAL,
          );
        }
        requirePublishedCopyFeeShareLaw(this.feeShareLaw);

        await this.refuseIfFollowRegionClosed(store, follow);
        if (follow.envelope.expiresAt.getTime() <= this.now().getTime()) {
          throw new CopyError('Copy session envelope has expired', 'trade.copy_key_expired');
        }
        const closeOnly = followRelationshipState(follow) === 'CLOSE_ONLY';
        const planned = closeOnly ? await store.getMirroredFill(follow.followId, canonicalizeCopyFillId(input.fillId)) : null;
        // Close-only (CB-copy-09) still places the leader's closes: a planned sell. Anything else is new intent.
        if (!closeOnly || planned?.side !== 'sell') requireNewCopyIntentAllowed(follow);
        requireUnrevokedCopySessionKey(follow);
        const prior = closeOnly ? planned : await store.getMirroredFill(follow.followId, canonicalizeCopyFillId(input.fillId));
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
          const leaderFill = this.lookupLeaderFill ? await this.lookupLeaderFill(prior.fillId) : null;
          assertCopySlippage({
            capBps: follow.envelope.maxSlippageBps,
            followerPrice: price,
            leaderPrice: leaderFill?.price ?? null,
          });
          if (prior.side === 'sell') {
            // A copied sell, active or close-only, never sells more than is copied and still open in that market: after
            // the follower closes a copy themselves, the leader's sell must not reach the follower's own coin.
            const sellable = sellableInMarket(await this.readCopiedPositions(follow), prior.marketId);
            if (prior.qty > sellable) {
              throw new CopyCloseError('Nothing copied is left open to close in this market', 'trade.copy_position_closed');
            }
          }
          if (!closeOnly && follow.envelope.maxConcurrent !== undefined) {
            assertCopyConcurrency(await store.countOpenMirrors(follow.followId), follow.envelope.maxConcurrent);
          }
          if (!closeOnly && follow.envelope.maxDrawdown !== undefined) {
            const reading = await this.currentResultFigure(follow);
            if (reading.figure === null) {
              throw new CopyError(
                `Drawdown cannot be evaluated: ${reading.missing ?? 'followResult'} is missing`,
                'trade.copy_limit_unevaluable',
              );
            }
            const latest = await store.getFollow(follow.followId);
            const decision = drawdownDecision(latest?.peakResult ?? null, reading.figure, follow.envelope.maxDrawdown);
            if (decision.stop) {
              throw new CopyError(
                'Drawdown from the peak result is at the cap — new mirrors stop and existing positions stay',
                'trade.copy_drawdown_stop',
              );
            }
          }
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
      }),
    );
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
        return this.presentFollow(current, currentExposure);
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
  /**
   * The customer's Start copying (CB-copy-03, CB-copy-04). Every gate runs before anything is written: sub-account,
   * the owner's copy tier, the country list (inside follow), and a reserve that fits the
   * follower's free spot balance. The same clientRequestId returns the follow it already made.
   */
  async startFollow(principal: Principal, input: Parameters<CopyService['follow']>[1] & { readonly clientRequestId: string }) {
    // The desk's own blocker first: with no country list nothing else matters.
    let region: string;
    try {
      region = assertCopyRegionAllowed(this.jurisdictionLaw, input.region);
    } catch (err) {
      this.blankLawRefusal(err);
    }
    assertMayFollow(principal, this.minTier);
    const leaderId = await this.directory.resolveLeaderId(input.leaderId, input.leaderRef);
    const followId = copyFollowIdFor(principal.userId, leaderId, input.clientRequestId);
    const already = await this.store.getFollow(followId);
    if (already) {
      if (already.followerId !== principal.userId) throw new CopyError('Follow not found', 'trade.copy_not_following');
      return this.presentFollow(already);
    }

    const asset = copyQuoteAsset(input.permittedMarkets);
    let amount: Amount;
    try {
      amount = parseAmount(input.maxAggregateExposure);
    } catch {
      throw new CopyError('Copy envelope caps must be valid decimal amounts', 'trade.copy_envelope_invalid');
    }
    const free = async () => freeSpotBalance(await this.ledger.balances('user', principal.userId), asset);
    const gridUnused = () => this.gridUnusedReserves(principal.userId, asset);
    // A quick refusal before admission; the same check runs again under the follower's reserve lock in the save, with
    // the balance and the grid reserves read again after whatever held the lock before.
    assertReserveFits({
      amount,
      asset,
      free: await free(),
      reservedElsewhere: (await this.store.sumUnusedReserves(principal.userId, asset)) + (await gridUnused()),
    });
    return this.follow(principal, input, {
      followId,
      leaderId,
      region,
      reserveAsset: asset,
      beforeSave: async (store, follow) => {
        await store.lockReserves(principal.userId, asset);
        assertReserveFits({
          amount: follow.reserve!.amount,
          asset,
          free: await free(),
          reservedElsewhere: (await store.sumUnusedReserves(principal.userId, asset)) + (await gridUnused()),
        });
      },
    });
  }

  /**
   * The follow write without startFollow's gates (tier, reserve). The router mounts only startFollow; this
   * stays callable for the unit tests of the envelope and lifecycle. Without `admitted` no reserve is held and the id
   * is random, so two direct follows of one leader race to the unique (follower, leader) row as before.
   */
  async follow(
    principal: Principal,
    input: {
      leaderId?: string;
      leaderRef?: string;
      region: string;
      permittedMarkets: readonly string[];
      maxNotionalPerOrder: string;
      maxAggregateExposure: string;
      /** Independent follower loss cap. Required when leaderSettings.maxLoss is set. */
      maxLoss?: string;
      /** Whole basis points, 1 to 10000. Required when the leader recommends one. */
      maxSlippageBps?: number | null;
      /** Placed mirrors of this follow that are not yet terminal. At least 1. */
      maxConcurrent?: number | null;
      /** Positive decimal. Peak minus current result at or above this stops new mirrors. */
      maxDrawdown?: string | null;
      /** Refused. Copy places spot limits only; nothing is stored. */
      maxLeverage?: string | number | null;
      expiresAt: string;
      /** Quote amount each copied order uses. Blank means no fixed size. */
      fixedOrderSize?: string | null;
      /** Leader recommendations — clamp only; never raise follower caps. */
      leaderSettings?: CopyLeaderLimitSettings;
    },
    /** From startFollow: the request's follow id, the resolved leader and region, the reserve asset and its check. */
    admitted?: {
      readonly followId: string;
      readonly leaderId: string;
      readonly region: string;
      readonly reserveAsset: string;
      readonly beforeSave: (store: CopyFollowStore, follow: CopyFollow) => Promise<void>;
    },
  ) {
    let leaderId: string;
    let region: string;
    if (admitted) {
      ({ leaderId, region } = admitted);
    } else {
      try {
        region = assertCopyRegionAllowed(this.jurisdictionLaw, input.region);
      } catch (err) {
        this.blankLawRefusal(err);
      }
      leaderId = await this.directory.resolveLeaderId(input.leaderId, input.leaderRef);
    }
    if (leaderId === principal.userId) {
      throw new CopyError('Cannot follow yourself', 'trade.copy_self_follow');
    }
    assertLeverageUnsupported(input.maxLeverage);

    for (const f of await this.store.listFollowsByFollower(principal.userId)) {
      if (f.leaderId === leaderId) {
        throw new CopyError('Already following this leader', 'trade.copy_already_following');
      }
    }

    const parsed = parseCopyEnvelope({
      permittedMarkets: input.permittedMarkets,
      maxNotionalPerOrder: input.maxNotionalPerOrder,
      maxAggregateExposure: input.maxAggregateExposure,
      maxLoss: input.maxLoss,
      fixedOrderSize: input.fixedOrderSize,
      expiresAt: input.expiresAt,
      now: this.now(),
    });
    const envelope = envelopeWithBoundLimits(
      parsed,
      bindCopyFollowerLimits({
        follower: {
          ...followerLimitsFromEnvelope(parsed),
          maxSlippageBps: input.maxSlippageBps,
          maxConcurrent: input.maxConcurrent,
          maxDrawdown: input.maxDrawdown,
        },
        leader: input.leaderSettings,
      }),
    );

    // A leader's recommendation can only lower the per-order cap; the fixed amount has to fit what is left.
    if (envelope.fixedOrderSize !== undefined && envelope.fixedOrderSize > envelope.maxNotionalPerOrder) {
      throw new CopyError(
        `The fixed amount cannot be above the most per order, ${formatAmount(envelope.maxNotionalPerOrder)}`,
        'trade.copy_fixed_size_above_cap',
      );
    }

    const follow: CopyFollow = {
      followId: admitted?.followId ?? randomUUID(),
      followerId: principal.userId,
      leaderId,
      envelope,
      region,
      createdAt: this.now(),
      feeShareKilled: false,
      relationshipState: 'ACTIVE',
      // The reserve is the most in total after the leader's limits, which can only lower what startFollow checked.
      ...(admitted
        ? { reserve: { asset: admitted.reserveAsset, amount: envelope.maxAggregateExposure, heldAt: this.now(), releasedAt: null } }
        : {}),
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
        ...(follow.reserve ? { reserve: { asset: follow.reserve.asset, amount: follow.reserve.amount } } : {}),
      }),
    );
    try {
      await this.directory.admitNewFollow(leaderId, this.store, follow, admitted?.beforeSave);
    } catch (err) {
      if (err instanceof CopyError) throw err;
      rethrowCopyFollowUnique(err);
    }
    return this.presentFollow(follow);
  }

  /**
   * The copy driver (CB-copy-10, J-copy-bots-otc-01 #8). For every ACTIVE follow whose follower turned automatic
   * copying on (an unrevoked session key with their place grant), each live fill its leader made after the follow's
   * copy cursor is planned and placed as a copy through planMirrorForFollow and placeMirrorForFollow, as the follower:
   * their stored grant, which ends with the envelope. So every gate, the once-per-fill claim and the order's own live
   * admission run per copy, exactly as by hand. A refusal is already on the mirror trail; the sweep counts it and the
   * cursor moves past that fill, so it is tried once. Any other failure leaves the cursor where it is (the fill is tried
   * again next sweep, and the once-per-fill claim keeps it to one order) and the sweep goes on to the next follow.
   */
  async runMirrorSweep(
    options: { readonly fillsPerFollow?: number; readonly onFollowFailed?: (followId: string, err: unknown) => void } = {},
  ): Promise<{ placed: number; refused: number; failed: number }> {
    const totals = { placed: 0, refused: 0, failed: 0 };
    if (!this.placeMirrorEnabled || !this.placeFollowerOrder || !this.listLeaderFillsSince) return totals;
    const now = this.now();
    for (const follow of await this.store.listCopyingFollows(now, ['ACTIVE', 'PAUSED', 'CLOSE_ONLY'])) {
      try {
        await this.copyNewLeaderFills(follow, now, options.fillsPerFollow ?? 20, totals);
      } catch (err) {
        totals.failed += 1;
        options.onFollowFailed?.(follow.followId, err);
      }
    }
    return totals;
  }

  private async copyNewLeaderFills(
    follow: CopyFollow,
    now: Date,
    limit: number,
    totals: { placed: number; refused: number },
  ): Promise<void> {
    if (!follow.placeGrant || !follow.copyCursor) return;
    const principal = principalFromAlgoGrant({
      userId: follow.followerId,
      grant: follow.placeGrant,
      expiresAt: follow.envelope.expiresAt,
      now,
    });
    if (followRelationshipState(follow) === 'PAUSED') {
      // Under the follow's lock and on a fresh read, so a resume racing the sweep never has a fill made after it
      // logged as paused, nor the cursor moved past one it should copy.
      await this.store.runFollowExclusive(follow.followId, async (store) => {
        const latest = await store.getFollow(follow.followId);
        if (latest && followRelationshipState(latest) === 'PAUSED') await this.skipLeaderFillsWhilePaused(store, latest, limit);
      });
      return;
    }
    const fills = await this.listLeaderFillsSince!(follow.leaderId, follow.copyCursor, limit);
    for (const fill of fills) {
      if (follow.envelope.permittedMarkets.includes(fill.marketId) && !(await this.store.getPlacedMirror(follow.followId, fill.fillId))) {
        try {
          const sessionLoss = await this.followSessionLoss(follow);
          await this.planMirrorForFollow(principal, {
            followId: follow.followId,
            fillId: fill.fillId,
            marketId: fill.marketId,
            side: 'buy',
            qty: '0',
            notional: '0',
            ...(sessionLoss !== null ? { sessionLoss } : {}),
          });
          await this.placeMirrorForFollow(principal, { followId: follow.followId, fillId: fill.fillId, leaderPaper: false });
          totals.placed += 1;
        } catch (err) {
          if (!isCopySkipRefusal(err)) throw err;
          totals.refused += 1;
          // The skip row is written before the cursor moves, so a crash between them re-reads the fill and the row's
          // once-per-fill index keeps it to one row.
          const skip = {
            followId: follow.followId,
            leaderFillId: canonicalizeCopyFillId(fill.fillId),
            reason: copySkipReasonFor(err),
            at: this.now(),
          };
          await recordCopySkip(this.mirrorEvents, skip);
          // Told after the row is written and before the cursor moves: a crash between re-reads the fill, finds the row,
          // and tells again under the same key, which the bus and svc-notify keep to one notice.
          await this.notices.skipped({ ...skip, followerId: follow.followerId, leaderId: follow.leaderId });
        }
      }
      await this.store.setCopyCursor(follow.followId, { at: fill.at, fillId: fill.fillId }, 'forward');
    }
  }

  /**
   * A paused follow copies nothing (CB-copy-11): each leader fill past its cursor in a permitted market gets a
   * `paused` skip row, then the cursor moves past it, so resuming never copies a fill made while paused. Pages until
   * the leader has no more fills, at most `pages` pages.
   */
  private async skipLeaderFillsWhilePaused(store: CopyFollowStore, follow: CopyFollow, limit: number, pages = 1): Promise<void> {
    if (!this.listLeaderFillsSince || !follow.copyCursor) return;
    let cursor = follow.copyCursor;
    for (let page = 0; page < pages; page += 1) {
      const fills = await this.listLeaderFillsSince(follow.leaderId, cursor, limit);
      for (const fill of fills) {
        if (follow.envelope.permittedMarkets.includes(fill.marketId) && !(await store.getPlacedMirror(follow.followId, fill.fillId))) {
          await recordCopySkip(this.mirrorEvents, {
            followId: follow.followId,
            leaderFillId: canonicalizeCopyFillId(fill.fillId),
            reason: 'paused',
            at: this.now(),
          });
        }
        cursor = { at: fill.at, fillId: fill.fillId };
        await store.setCopyCursor(follow.followId, cursor, 'forward');
      }
      if (fills.length < limit) return;
    }
  }

  /** Leaving a pause: the fills made while paused are logged as skipped before the follow moves on. */
  private async flushPausedSkips(store: CopyFollowStore, follow: CopyFollow): Promise<void> {
    if (followRelationshipState(follow) !== 'PAUSED') return;
    await this.skipLeaderFillsWhilePaused(store, follow, 50, 20);
  }

  private async readCopiedPositions(follow: CopyFollow) {
    if (!this.copiedPositionsPort) {
      throw new CopyCloseError('Copied positions need the spot tables', 'trade.copy_close_unavailable');
    }
    return this.copiedPositionsPort({ followId: follow.followId, followerId: follow.followerId });
  }

  /** The caller's skipped copies on one follow, newest first (CB-copy-11): the leader fill and the reason id. */
  async skipLog(principal: Principal, input: { followId: string }) {
    const follow = await this.requireOwnedFollow(this.store, principal, input.followId);
    const rows = await this.mirrorEvents.listSkips(follow.followId, COPY_SKIP_LOG_LIMIT);
    return {
      items: rows.map((row) => ({ leaderFillId: row.leaderFillId, reason: asCopySkipReason(row.code), at: row.at.toISOString() })),
    };
  }

  /** The caller's copied positions on one follow, newest first (CB-copy-09/10). */
  async copiedPositions(principal: Principal, input: { followId: string }) {
    const follow = await this.requireOwnedFollow(this.store, principal, input.followId);
    const positions = await this.readCopiedPositions(follow);
    return { positions: positions.map(copiedPositionWire) };
  }

  /**
   * Close one copied position, whole or in part (CB-copy-10). Runs once per close key: the same close asked again
   * while its order is live returns that order, or places that same order again when it never reached the book. Once
   * that order has settled, a close of what is open again runs under the key's next attempt. Stop, pause and leave never
   * call this.
   */
  async closePosition(principal: Principal, input: { followId: string; positionId: string; qty?: string }) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      if (!this.placeMirrorEnabled || !this.placeFollowerOrder || !this.copyClose) {
        throw new CopyCloseError('Closing a copied position needs the follower place port', 'trade.copy_close_unavailable');
      }
      const positions = await this.readCopiedPositions(follow);
      const position = positions.find((row) => row.orderId === input.positionId);
      if (!position) throw new CopyCloseError('No copied position of this follow has that id', 'trade.copy_position_not_found');

      let partial: Amount | null = null;
      if (input.qty !== undefined) {
        try {
          partial = parseAmount(input.qty.trim());
        } catch {
          throw new CopyCloseError('Close amount must be a decimal amount', 'trade.copy_close_qty_invalid');
        }
        if (partial <= 0n) throw new CopyCloseError('Close amount must be above zero', 'trade.copy_close_qty_invalid');
      }

      const baseKey = copyCloseKey(follow.followId, position.leaderFillId, partial);
      const prior = await this.copyClose.latest(follow.followId, baseKey);
      if (prior && !prior.settled) {
        const resumed = await this.copyClose.resume(principal, prior.record);
        return {
          followId: follow.followId,
          positionId: position.orderId,
          orderId: resumed.orderId,
          qty: formatAmount(prior.record.qty),
          duplicate: true,
        };
      }
      // The key's last close settled (filled, cancelled, expired or rejected): what is open now is a new close.
      const closeKey = copyCloseAttemptKey(baseKey, (prior?.attempts ?? 0) + 1);

      if (position.open === 0n) throw new CopyCloseError('Nothing is open on this copied position', 'trade.copy_position_closed');
      if (partial !== null && partial > position.open) {
        throw new CopyCloseError('Close amount is above what is open on this copied position', 'trade.copy_close_qty_exceeds');
      }
      const qty = partial ?? position.open;
      const placed = await this.copyClose.place(principal, {
        closeKey,
        followId: follow.followId,
        followerId: follow.followerId,
        leaderFillId: position.leaderFillId,
        symbol: position.symbol,
        baseAsset: position.baseAsset,
        qty,
      });
      return { followId: follow.followId, positionId: position.orderId, orderId: placed.orderId, qty: formatAmount(qty), duplicate: false };
    });
  }

  /**
   * The follower's loss on this follow so far, for a follow with a loss limit: the follow's result when it is a loss,
   * else 0. Null when no limit is set, or when the result cannot be read, so the plan refuses rather than guess.
   */
  private async followSessionLoss(follow: CopyFollow): Promise<string | null> {
    if (follow.envelope.maxLoss === undefined) return null;
    const reading = await this.currentResultFigure(follow);
    if (reading.figure === null) return null;
    return formatAmount(reading.figure < 0n ? -reading.figure : 0n);
  }

  /**
   * The caller's copied orders on one follow, newest first (CB-copy-10): market, side, quantity, how much filled,
   * the limit price and the order's state, read from the follower's own orders. No leader fill id leaves the service.
   */
  async followPositions(principal: Principal, input: { followId: string }): Promise<{ positions: CopyPosition[] }> {
    const follow = await this.requireOwnedFollow(this.store, principal, input.followId);
    if (!this.sql) throw new CopyError('Copied orders need the spot tables', 'trade.copy_unavailable');
    const rows = await this.sql<
      Array<{
        order_id: string;
        symbol: string;
        side: string;
        qty: string;
        filled_qty: string;
        price: string;
        status: string;
        created_at: Date;
      }>
    >`
      SELECT o.id AS order_id, m.symbol, o.side::text AS side, o.qty::text AS qty, o.filled_qty::text AS filled_qty,
             pm.price::text AS price, o.status::text AS status, pm.created_at
        FROM copy_placed_mirrors pm
        INNER JOIN orders o ON o.id = pm.order_id::uuid AND o.user_id = ${follow.followerId}
        INNER JOIN markets m ON m.id = o.market_id
       WHERE pm.follow_id = ${follow.followId}
       ORDER BY pm.created_at DESC, o.id DESC
       LIMIT 50
    `;
    return {
      positions: rows.map((row) => ({
        orderId: row.order_id,
        market: row.symbol,
        side: row.side === 'sell' ? 'sell' : 'buy',
        qty: formatAmount(parseAmount(row.qty)),
        filledQty: formatAmount(parseAmount(row.filled_qty)),
        price: formatAmount(parseAmount(row.price)),
        status: row.status,
        placedAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
      })),
    };
  }

  async listLeaders(principal: Principal, input: ListLeadersQuery): Promise<LeaderDirectoryPage> {
    void principal;
    return this.directory.listLeaders(input);
  }

  async followEvents(principal: Principal, input: { followId: string; limit?: number; cursor?: string | null }): Promise<LeaderEventsPage> {
    const follow = await this.requireOwnedFollow(this.store, principal, input.followId);
    return this.directory.followEvents({
      leaderUserId: follow.leaderId,
      since: follow.createdAt,
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  /** A listed leader's public page: listing facts and the metrics the owner defined. Not listed → not found. */
  async leaderProfile(principal: Principal, input: { leaderRef: string }): Promise<LeaderProfile> {
    void principal;
    const { row } = await this.directory.listedLeader(input.leaderRef);
    return presentLeaderProfile(row, 'listed', this.metricDefinitions);
  }

  /** A listed leader's own spot trades, newest first. The limit is required; without the spot tables this refuses. */
  async leaderTrades(
    principal: Principal,
    input: { leaderRef: string; limit?: number; cursor?: string | null },
  ): Promise<LeaderTradesPage> {
    void principal;
    const limit = leaderTradesLimit(input.limit);
    const after = decodeLeaderTradesCursor(input.cursor);
    const { leaderUserId } = await this.directory.listedLeader(input.leaderRef);
    if (!this.sql) throw new CopyError('Leader trades need the spot tables', 'trade.copy_unavailable');
    return pageLeaderTrades(pairLeaderTrades(await readLeaderOrderFills(this.sql, leaderUserId)), after, limit);
  }

  upsertListing(principal: Principal, input: UpsertLeaderListingInput): Promise<OperatorListingResult> {
    return this.directory.upsertListing(principal, input);
  }

  setLeaderState(principal: Principal, input: SetLeaderStateInput): Promise<OperatorListingResult> {
    return this.directory.setLeaderState(principal, input);
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
      // The grant is the follower's claims now, kept so the copy driver can place each copy as them. An earlier
      // grant's claims never carry over: without trade:write there is none, and the key only gates copying by hand.
      const { placeGrant: _earlier, ...rest } = follow;
      const next: CopyFollow = {
        ...rest,
        sessionKeyHash: generated.hash,
        sessionKeyPrefix: generated.prefix,
        sessionKeyRevoked: false,
        ...(principal.scopes?.includes('trade:write') ? { placeGrant: captureAlgoPlaceGrant(principal) } : {}),
      };
      await store.saveFollow(next);
      // Copying starts now: the driver copies the leader's fills from this moment, never ones made while it was off.
      await store.setCopyCursor(follow.followId, { at: this.now(), fillId: null }, 'reset');
      const currentExposure = await store.getExposure(follow.followId);
      return {
        ...(await this.presentFollow(next, currentExposure)),
        sessionKeyId: generated.id,
        sessionKey: generated.key,
      };
    });
  }

  /** Revoke the auto-mirror session-key. Follow may remain; subsequent place refuses. */
  async killSessionKey(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      // The stored claims go with the key, so nothing can be placed as the follower until they grant again.
      const { placeGrant: _revoked, ...rest } = follow;
      const next: CopyFollow = { ...rest, sessionKeyRevoked: true };
      await store.saveFollow(next);
      const currentExposure = await store.getExposure(follow.followId);
      return this.presentFollow(next, currentExposure);
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
      await this.flushPausedSkips(store, follow);
      const next = applyCopyResume(follow);
      await store.saveFollow(next);
      return presentCopyControlAck(next, 'RESUME');
    });
  }

  /**
   * STOP_NEW — fence new intent and revoke the auto-mirror grant.
   * Does not call flatten or cancel-open.
   */
  async stop(principal: Principal, input: FollowRef & { closeOnly?: boolean }) {
    const closeOnly = input.closeOnly === true;
    const next = await this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      // STOP_CLOSE_ONLY (CB-copy-09): no new opens, the grant stays so the leader's closes still close.
      const stopped = closeOnly ? applyCopyStopCloseOnly(follow) : applyCopyStop(follow);
      await this.flushPausedSkips(store, follow);
      await store.saveFollow(stopped);
      return stopped;
    });
    // Told once the stop is saved, never before: a stop that did not commit tells nobody.
    await this.notices.stopped({
      followId: next.followId,
      followerId: next.followerId,
      leaderId: next.leaderId,
      reason: 'follower',
      closeOnly,
      at: this.now(),
    });
    return presentCopyControlAck(next, closeOnly ? 'STOP_CLOSE_ONLY' : 'STOP_NEW');
  }

  /**
   * DETACH_KEEP — stop copying; leave existing orders/positions with the follower.
   * Does not call flatten.
   */
  async detach(principal: Principal, input: FollowRef) {
    return this.store.runFollowExclusive(requireCopyFollowId(input.followId), async (store) => {
      const follow = await this.requireOwnedFollow(store, principal, input.followId);
      const next = applyCopyLeave(follow);
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
      // Flag off or place port unwired: refuse and leave the follow attached (TRD-0723).
      if (!this.placeMirrorEnabled || !this.placeFollowerOrder || !this.flattenCopyPosition) {
        throw new CopyError(
          'copy.flatten is refuse-closed until the follower flatten port is wired — never invent a close',
          'trade.copy_flatten_refused',
          COPY_FLATTEN_REFUSED_RESIDUAL,
        );
      }
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
      return this.presentFollow(next, currentExposure);
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
      recordPlanMirrorEvents(this.mirrorEvents, store, principal, input, this.now(), () =>
        this.planMirrorForFollowExclusive(store, principal, input),
      ),
    );
  }

  private async planMirrorForFollowExclusive(store: CopyFollowStore, principal: Principal, input: PlanMirrorInput) {
    const follow = await this.requireOwnedFollow(store, principal, input.followId);
    await this.directory.refuseNewMirror(follow.leaderId);
    await this.refuseIfFollowRegionClosed(store, follow);
    const closeOnly = followRelationshipState(follow) === 'CLOSE_ONLY';
    if (!closeOnly) requireNewCopyIntentAllowed(follow);

    const gated = { ...follow, envelope: bindEnvelopeLimits(follow.envelope, input.leaderSettings) };
    // Close-only copies only closes, and a close lowers the loss at risk: the loss limit does not hold it back.
    if (closeOnly) {
      // A buy under close-only is refused as new intent once the leader fill's side is read, below.
    } else if (gated.envelope.maxLoss !== undefined) {
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

    const { observation, leaderPrice } = await this.observationFromLeaderFill(follow, fillId);
    // Close-only copies only the leader's closes (a sell); a buy is new intent.
    if (closeOnly && observation.side !== 'sell') requireNewCopyIntentAllowed(follow);
    assertCopySlippage({
      capBps: gated.envelope.maxSlippageBps,
      followerPrice: copyLimitPriceFromPlan(observation.qty, observation.notional),
      leaderPrice,
    });
    if (!closeOnly && gated.envelope.maxConcurrent !== undefined) {
      assertCopyConcurrency(await store.countOpenMirrors(follow.followId), gated.envelope.maxConcurrent);
    }

    const current = await store.getExposure(follow.followId);
    // Envelope / market / expiry / per-order checks — may throw typed refuse.
    // Cap is re-checked inside claimMirrorFill under the follow exclusive lock
    // so a concurrent first-claim cannot overshoot even if this read is stale.
    const market = this.inspectMarket ? await this.inspectMarket(observation.marketId) : null;
    // A close-only sell is sized against what is copied and open (capCopiedSell), not the per-order limit, so the
    // leader's close of a position built from several copies still closes it. The bound below is the most a plan can
    // reach: the leader's own notional, or the fixed amount.
    const planFollow = closeOnly
      ? {
          ...gated,
          envelope: {
            ...gated.envelope,
            maxNotionalPerOrder: [gated.envelope.maxNotionalPerOrder, observation.notional, gated.envelope.fixedOrderSize ?? 0n].reduce(
              (a, b) => (a > b ? a : b),
            ),
          },
        }
      : gated;
    const sized = planMirror({
      follow: planFollow,
      observation,
      currentExposure: current,
      now: this.now(),
      ...(market?.lotSize !== undefined ? { lotSize: market.lotSize } : {}),
    });
    const planned = observation.side === 'sell' ? await this.capCopiedSell(follow, sized) : sized;

    let drawdown: { current: Amount; cap: Amount } | undefined;
    if (!closeOnly && gated.envelope.maxDrawdown !== undefined) {
      const reading = await this.currentResultFigure(follow);
      if (reading.figure === null) {
        throw new CopyError(
          `Drawdown cannot be evaluated: ${reading.missing ?? 'followResult'} is missing`,
          'trade.copy_limit_unevaluable',
        );
      }
      drawdown = { current: reading.figure, cap: gated.envelope.maxDrawdown };
    }

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
      ...(drawdown ? { drawdown } : {}),
    });

    if (claimed.status === 'drawdown_stop') {
      throw new CopyError(
        'Drawdown from the peak result is at the cap — new mirrors stop and existing positions stay',
        'trade.copy_drawdown_stop',
      );
    }
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

  /**
   * A leader sell, on an active or a close-only follow (CB-copy-09), never sells more than the follower's copied coin
   * still open in that market, so a copy the follower already closed is never sold again out of their own coin. The plan
   * keeps its price; its notional scales down with the quantity. Nothing open refuses.
   */
  private async capCopiedSell<T extends { marketId: string; qty: Amount; notional: Amount }>(follow: CopyFollow, planned: T): Promise<T> {
    const sellable = sellableInMarket(await this.readCopiedPositions(follow), planned.marketId);
    if (sellable === 0n) throw new CopyCloseError('Nothing copied is left open to close in this market', 'trade.copy_position_closed');
    if (planned.qty <= sellable) return planned;
    return { ...planned, qty: sellable, notional: (planned.notional * sellable) / planned.qty };
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
    return {
      observation: parseLeaderFillObservation({
        fillId,
        leaderId: follow.leaderId,
        marketId: fill.marketId,
        side: fill.side,
        qty: formatAmount(fill.qty),
        notional: formatAmount(fill.notional),
        observedAt: this.now(),
      }),
      leaderPrice: fill.price ?? null,
    };
  }

  private async currentResultFigure(follow: CopyFollow): Promise<{ figure: Amount | null; missing: string | null }> {
    if (this.readResultFigure) return this.readResultFigure(follow);
    if (!this.sql) return { figure: null, missing: 'followResult' };
    const result = await readFollowResult(this.sql, follow, {
      lookupFollowerFillFee: this.lookupFollowerFillFee,
      lookupMark: this.lookupMark,
      now: this.now(),
    });
    const figured = followResultFigure(result);
    return {
      figure: figured.figure === null ? null : parseAmount(figured.figure),
      missing: figured.missing,
    };
  }

  /**
   * Protocol fee is the follower fill's collected fee_amount. The id is the
   * follower's own fills row, not the leader fill claimed by planMirror.
   * Never notional×bps and never a caller fillFeeAmount. Missing lookup
   * or missing fill → refuse. The row must belong to the follower.
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
    const followerFillId = input.followerFillId?.trim() ? canonicalizeCopyFillId(input.followerFillId) : fillId;
    const assetId = input.assetId.trim();
    const once = await store.runFeeShareSettleOnce(follow.followId, fillId, async (ctx) => {
      const key = `${follow.leaderId}:${follow.followerId}`;
      const period = await store.getPeriodStats(key);
      requirePublishedCopyFeeShareLaw(this.feeShareLaw);
      const mirrored = await store.getMirroredFill(follow.followId, fillId);
      if (!mirrored) {
        throw new CopyError('Fill is not a copy-mirrored fill for this follow — refuse fee-share', 'trade.copy_settle_refused');
      }
      const settledFee = await this.resolveSettledProtocolFee(follow, followerFillId, assetId);
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
        logRefusalSpec('trade.copy_fee_share_blank');
        throw new CopyError(COPY_FEE_SHARE_RESIDUAL, 'trade.copy_fee_share_blank', COPY_FEE_SHARE_RESIDUAL);
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

  /** Caller's own follow. Another account's id is not found. */
  async result(principal: Principal, followId: string): Promise<FollowResult> {
    requireScope(principal, 'trade:read');
    if (!this.sql) throw new CopyError('copy result is not mounted', 'trade.copy_unavailable');
    const follow = await this.requireOwnedFollow(this.store, principal, followId);
    return readFollowResult(this.sql, follow, {
      lookupFollowerFillFee: this.lookupFollowerFillFee,
      lookupMark: this.lookupMark,
      now: this.now(),
    });
  }

  /** Oldest first. Window and limit are required; a blank limit is refused. */
  async mirrorTrail(principal: Principal, input: MirrorTrailQuery): Promise<MirrorTrailPage> {
    requireScope(principal, 'trade:read');
    if (!this.sql) throw new CopyError('copy trail is not mounted', 'trade.copy_unavailable');
    await this.requireOwnedFollow(this.store, principal, input.followId);
    return listMirrorTrail(this.sql, principal, input);
  }

  /** Same rows as the trail, as CSV. Session scope is trade:read. */
  async exportMirrorTrail(principal: Principal, query: { followId?: string; from?: string; to?: string }): Promise<string> {
    requireScope(principal, 'trade:read');
    if (!this.sql) throw new CopyError('copy trail is not mounted', 'trade.copy_unavailable');
    const followId = requireCopyFollowId(query.followId);
    await this.requireOwnedFollow(this.store, principal, followId);
    return exportMirrorTrail(this.sql, principal, { followId, from: query.from, to: query.to });
  }

  /** One-line spot hook after a follower fill is stored. Not a mirror order → no row. */
  async observeFollowerFill(notice: CopyMirrorFillNotice): Promise<void> {
    if (!this.sql) return;
    await observeCopyMirrorFill(this.sql, this.mirrorEvents, notice, this.now());
  }

  /** Forbidden surfaces — explicit refuse for honesty tests. */
  rankLeadersByReturns(): never {
    return refuseCopyLeaderRanking();
  }

  chargePnlPerformanceFee(): never {
    return refusePnlLinkedCopyFee();
  }
}

/**
 * The answer schemas of the copy follow doors (`trade.copy.*`): each names every key its handler answers with
 * (`answerKeys`) and checks no more than the handler's own type, so a reply leaves exactly as it did before the schema
 * was added. Every answer here is built key by key (follows.ts, leader-listing.ts, leader-profile.ts,
 * copied-positions.ts, venue-copy.ts, copy-service.ts), so nothing outside these keys is ever stripped.
 */
import { z } from 'zod';
import { answerKeys } from '../answer-keys.js';
import type { CheckVenueFollowAnswer, CopyService } from './copy-service.js';
import type { PresentCopyFollow } from './follows.js';
import type { LeaderDirectoryPage } from './leader-listing.js';
import type { LeaderProfile, LeaderTradesPage } from './leader-profile.js';

type Answer<K extends keyof CopyService> = CopyService[K] extends (...args: never[]) => Promise<infer A> ? A : never;

/**
 * A held figure (leader-listing.ts `Held`): the set form is tried first. Only it has a non-null value, so a figure
 * with no record (value null) never reads as set and falls to the second form.
 */
const heldText = z.union([
  z.object({ value: z.string(), reason: z.null() }),
  z.object({ value: z.null(), reason: z.literal('no_published_record') }),
]);

const leaderDirectoryRowAnswer = z.object({
  leaderRef: z.string(),
  displayName: z.string(),
  marketMode: z.enum(['spot', 'futures', 'bot', 'signal']),
  recordKind: z.enum(['verified_live', 'paper', 'backtest', 'imported', 'self_reported']),
  tenureStart: z.string().nullable(),
  assets: z.array(z.string()).readonly(),
  strategyVersion: z.string().nullable(),
  publishedReturn: heldText,
  maximumDrawdown: heldText,
  windowStart: heldText,
  windowEnd: heldText,
  // The set form first, as in heldText: only it has a non-null value.
  netOfCosts: z.union([
    z.object({ value: z.boolean(), reason: z.null() }),
    z.object({ value: z.null(), reason: z.literal('no_published_record') }),
  ]),
  copiersCount: z.number(),
  capacity: z.union([
    z.object({ value: z.number(), reason: z.null() }),
    z.object({ value: z.null(), reason: z.literal('capacity_unpublished') }),
  ]),
  leaderShareBps: z.union([
    z.object({ value: z.string(), reason: z.null() }),
    z.object({ value: z.null(), reason: z.literal('leader_share_unpublished') }),
  ]),
});

export const copyListLeadersAnswer = z.object({
  leaders: z.array(leaderDirectoryRowAnswer).readonly(),
  nextCursor: z.string().nullable(),
});
answerKeys<LeaderDirectoryPage>()(copyListLeadersAnswer);

export const copyLeaderProfileAnswer = z.object({
  leader: leaderDirectoryRowAnswer,
  status: z.enum(['listed', 'suspended', 'delisted', 'unknown']),
  definitionsVersion: z.string().nullable(),
  metrics: z
    .array(
      z.object({
        key: z.enum(['publishedReturn', 'maximumDrawdown', 'winRate', 'sharpeRatio']),
        value: z.string().nullable(),
        reason: z.enum(['no_published_record', 'definition_unpublished', 'not_held']).nullable(),
        definition: z.string().nullable(),
      }),
    )
    .readonly(),
});
answerKeys<LeaderProfile>()(copyLeaderProfileAnswer);

export const copyLeaderTradesAnswer = z.object({
  trades: z
    .array(
      z.object({
        tradeId: z.string(),
        symbol: z.string(),
        state: z.enum(['open', 'closed']),
        openedAt: z.string().nullable(),
        closedAt: z.string().nullable(),
        entryPrice: z.string().nullable(),
        qty: z.string(),
        margin: z.string().nullable(),
        takeProfit: z.string().nullable(),
        stopLoss: z.string().nullable(),
        closePrice: z.string().nullable(),
        closedQty: z.string(),
        roiPercent: z.string().nullable(),
      }),
    )
    .readonly(),
  nextCursor: z.string().nullable(),
});
answerKeys<LeaderTradesPage>()(copyLeaderTradesAnswer);

/** One follow as its follower sees it (follows.ts `presentCopyFollow`). */
export const copyFollowAnswer = z.object({
  followId: z.string(),
  followerId: z.string(),
  leaderId: z.string().nullable(),
  leaderRef: z.string().nullable(),
  permittedMarkets: z.array(z.string()).readonly(),
  maxNotionalPerOrder: z.string(),
  maxAggregateExposure: z.string(),
  fixedOrderSize: z.string().nullable(),
  sizingMode: z.enum(['fixed_amount', 'smart_sync']),
  smartSync: z.object({ followerTotal: z.string() }).nullable(),
  maxPerMarket: z.string().nullable(),
  maxPerDay: z.string().nullable(),
  reserve: z.object({ asset: z.string(), amount: z.string(), released: z.boolean() }).nullable(),
  maxLoss: z.string().nullable(),
  maxSlippageBps: z.number().nullable(),
  maxConcurrent: z.number().nullable(),
  maxDrawdown: z.string().nullable(),
  peakResult: z.string().nullable(),
  currentExposure: z.string(),
  remainingExposure: z.string(),
  expiresAt: z.string(),
  region: z.string(),
  createdAt: z.string(),
  feeShareKilled: z.boolean(),
  sessionKeyGranted: z.boolean(),
  sessionKeyRevoked: z.boolean(),
  relationshipState: z.enum(['ACTIVE', 'PAUSED', 'STOPPING', 'CLOSE_ONLY', 'DETACHED']),
  newIntentFenced: z.boolean(),
  leaderStatus: z.enum(['listed', 'suspended', 'delisted', 'unknown']),
  // Last, as presentCopyFollow spreads them after every other key (and a grant adds sessionKey after them).
  sessionKeyPrefix: z.string().optional(),
  sessionKeyId: z.string().optional(),
  sessionKey: z.string().optional(),
});
answerKeys<PresentCopyFollow>()(copyFollowAnswer);
answerKeys<Answer<'startFollow'> | Answer<'startVenueFollow'> | Answer<'amendFollow'> | Answer<'killSessionKey'>>()(copyFollowAnswer);

/** A new session key's grant: the follow with the key's id and its raw token, shown this once. `extend` keeps both keys where copyFollowAnswer puts them, last. */
export const copyGrantSessionKeyAnswer = copyFollowAnswer.extend({ sessionKeyId: z.string(), sessionKey: z.string() });
answerKeys<Answer<'grantSessionKey'>>()(copyGrantSessionKeyAnswer);

/**
 * The venue follow's check (copy-service.ts `checkVenueFollow`). The unwritten form is tried first: only it has
 * `quoteAsset`, and its follow is null, so a follow already written (an object) never reads as one.
 */
export const copyCheckVenueFollowAnswer = z.union([
  z.object({ followId: z.string(), follow: z.null(), quoteAsset: z.string(), maxAggregateExposure: z.string() }),
  z.object({ followId: z.string(), follow: copyFollowAnswer }),
]);
answerKeys<CheckVenueFollowAnswer>()(copyCheckVenueFollowAnswer);

export const copyFollowPositionsAnswer = z.object({
  positions: z.array(
    z.object({
      orderId: z.string(),
      market: z.string(),
      side: z.enum(['buy', 'sell']),
      qty: z.string(),
      filledQty: z.string(),
      price: z.string(),
      status: z.string(),
      placedAt: z.string(),
      venue: z
        .object({
          venueName: z.string(),
          test: z.boolean(),
          asOf: z.string(),
          placedBy: z.string(),
          fills: z
            .array(
              z.object({
                fillId: z.string(),
                amount: z.string(),
                price: z.string(),
                venueFee: z.string(),
                builderFee: z.string(),
                feeAsset: z.string(),
                filledAt: z.string(),
              }),
            )
            .readonly(),
        })
        .optional(),
    }),
  ),
});
answerKeys<Answer<'followPositions'>>()(copyFollowPositionsAnswer);

export const copyCopiedPositionsAnswer = z.object({
  positions: z.array(
    z.object({
      positionId: z.string(),
      market: z.string(),
      bought: z.string(),
      open: z.string(),
      closing: z.string(),
      status: z.enum(['open', 'closed', 'buying', 'closing']),
      placedAt: z.string(),
      reportedBy: z.object({ venue: z.string(), test: z.boolean(), asOf: z.string() }).optional(),
    }),
  ),
  markets: z.array(
    z.object({
      market: z.string(),
      fills: z.number().nullable(),
      filled: z.string().nullable(),
      open: z.string(),
      averageEntry: z.string().nullable(),
      funding: z.null(),
    }),
  ),
});
answerKeys<Answer<'copiedPositions'>>()(copyCopiedPositionsAnswer);

export const copyCloseCopiedPositionAnswer = z.object({
  followId: z.string(),
  positionId: z.string(),
  orderId: z.string(),
  qty: z.string(),
  duplicate: z.boolean(),
});
answerKeys<Answer<'closePosition'>>()(copyCloseCopiedPositionAnswer);

export const copySkipLogAnswer = z.object({
  items: z.array(
    z.object({
      leaderFillId: z.string(),
      reason: z.enum([
        'paused',
        'stopped',
        'lead_stopped',
        'platform_paused',
        'risk_control',
        'insufficient_funds',
        'max_copy_total',
        'per_contract_cap',
        'daily_cap',
        'copy_slippage_exceeded',
        'position_closed',
        'not_lead_order',
        'refused',
      ]),
      at: z.string(),
    }),
  ),
});
answerKeys<Answer<'skipLog'>>()(copySkipLogAnswer);

export const copyListMyFollowsAnswer = z.array(copyFollowAnswer);
answerKeys<Answer<'listMyFollows'>>()(copyListMyFollowsAnswer);

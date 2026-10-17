/**
 * Copy fee-share attribution + ledger plan (D-S-03 §3 / §7.4–§7.5).
 *
 * Share of protocol trading fee only — never follower P&L.
 * Blank DIRECTION §8 leader_share_bps → refuse before any PostRequest.
 * When published: house fee → rewards pot → leader via ledger-client recipes.
 */

import { formatAmount, mulBps, parseAmount, recipes, type Amount, type LedgerClient, type PostRequest } from '@intafaced/ledger-client';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { COPY_FEE_SHARE_RESIDUAL, CopyError } from './errors.js';
import { requirePublishedCopyFeeShareLaw, type CopyFeeShareLaw } from './fee-share-law.js';

const COPY_FILL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trim, and lowercase UUID-shaped ids. Lookup and PG uuid-match already
 * collapse aliases; settle keys (`copy-fee:`, `copy-leader-share:`,
 * `runFeeShareSettleOnce`) must use the same canonical form or one fill
 * is paid twice.
 */
export function canonicalizeCopyFillId(fillId: string): string {
  const trimmed = fillId.trim();
  if (!trimmed) {
    throw new CopyError('fillId is required', 'trade.copy_settle_refused');
  }
  return COPY_FILL_UUID_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export interface FeeShareAttributionInput {
  readonly law: CopyFeeShareLaw;
  readonly fillId: string;
  readonly leaderId: string;
  readonly followerId: string;
  readonly assetId: string;
  /** Follower fill notional (quote asset). Not a fee — never used as the share pot. */
  readonly followerFillNotional: Amount;
  /**
   * Protocol maker/taker fee bps. Informational on this path — never multiplied
   * against notional to invent `protocolFee` (that over-claims the house pot).
   */
  readonly protocolFeeBps: number;
  /**
   * THE FEE ACTUALLY COLLECTED on the follower fill (`fills.fee_amount` / fee
   * asset). Required. Share is of THIS amount — never a re-invented
   * notional×bps that can over-claim the house fee pot.
   */
  readonly fillFeeAmount?: Amount;
  /** Round-trips already attributed this period for churn decay. */
  readonly roundTripsThisPeriod: number;
  /** Leader earnings already paid for this follower this period. */
  readonly earningsPaidThisPeriod: Amount;
  /** When true, kill switch — refuse payout. */
  readonly feeShareKilled: boolean;
}

export interface FeeShareAttribution {
  readonly fillId: string;
  readonly leaderId: string;
  readonly followerId: string;
  readonly assetId: string;
  readonly protocolFee: Amount;
  readonly appliedShareBps: number;
  readonly grossLeaderShare: Amount;
  readonly cappedLeaderShare: Amount;
  readonly skippedReason: null | 'cap_reached' | 'zero_share';
}

export interface FeeShareSettlePlan {
  readonly attribution: FeeShareAttribution;
  /** Sweep house trade fees into rewards pot (real revenue path). */
  readonly sweep: PostRequest;
  /** Pay leader from rewards pot. */
  readonly payout: PostRequest;
}

/**
 * Compute leader fee-share for one follower fill.
 * Never references P&L. Blank law → refuse.
 */
export function attributeCopyFeeShare(input: FeeShareAttributionInput): FeeShareAttribution {
  const law = requirePublishedCopyFeeShareLaw(input.law);
  const fillId = canonicalizeCopyFillId(input.fillId);

  if (input.feeShareKilled) {
    throw new CopyError('Fee-share killed for this leader/follow — refuse payout', 'trade.copy_fee_share_killed');
  }

  if (input.fillFeeAmount === undefined) {
    throw new CopyError(
      'Settled fill fee is required — refuse rather than invent protocolFee from notional×bps',
      'trade.copy_settle_refused',
    );
  }
  if (input.fillFeeAmount < 0n) {
    throw new CopyError('fillFeeAmount must not be negative', 'trade.copy_settle_refused');
  }

  const protocolFee = input.fillFeeAmount;
  const appliedShareBps =
    law.decayRoundTrips > 0 && input.roundTripsThisPeriod >= law.decayRoundTrips ? law.decayShareBps : law.leaderShareBps;

  const grossLeaderShare = mulBps(protocolFee, appliedShareBps, 'floor');
  const cap = parseAmount(law.earningsCapPerFollower);
  const remaining = cap > input.earningsPaidThisPeriod ? cap - input.earningsPaidThisPeriod : 0n;

  if (remaining <= 0n) {
    return {
      fillId,
      leaderId: input.leaderId,
      followerId: input.followerId,
      assetId: input.assetId,
      protocolFee,
      appliedShareBps,
      grossLeaderShare,
      cappedLeaderShare: 0n,
      skippedReason: 'cap_reached',
    };
  }

  const cappedLeaderShare = grossLeaderShare <= remaining ? grossLeaderShare : remaining;
  if (cappedLeaderShare <= 0n) {
    return {
      fillId,
      leaderId: input.leaderId,
      followerId: input.followerId,
      assetId: input.assetId,
      protocolFee,
      appliedShareBps,
      grossLeaderShare,
      cappedLeaderShare: 0n,
      skippedReason: 'zero_share',
    };
  }

  return {
    fillId,
    leaderId: input.leaderId,
    followerId: input.followerId,
    assetId: input.assetId,
    protocolFee,
    appliedShareBps,
    grossLeaderShare,
    cappedLeaderShare,
    skippedReason: null,
  };
}

/**
 * Build ledger posts for a non-zero attribution.
 * Path: houseFees(trade) → rewardsEngine → leader available (existing recipes).
 */
export function planCopyFeeShareSettle(attribution: FeeShareAttribution): FeeShareSettlePlan {
  if (attribution.skippedReason !== null || attribution.cappedLeaderShare <= 0n) {
    throw new CopyError(
      'No fee-share to settle (cap or zero) — refuse rather than invent a payout',
      'trade.copy_settle_refused',
      COPY_FEE_SHARE_RESIDUAL,
    );
  }

  const fillId = canonicalizeCopyFillId(attribution.fillId);
  const windowId = `copy-fee:${fillId}`;
  const rewardId = `copy-leader-share:${fillId}:${attribution.leaderId}`;

  return {
    attribution,
    sweep: recipes.sweepFeesToRewards({
      windowId,
      sourceModule: 'trade',
      assetId: attribution.assetId,
      amount: attribution.cappedLeaderShare,
    }),
    payout: recipes.rewardPay({
      rewardId,
      userId: attribution.leaderId,
      assetId: attribution.assetId,
      amount: attribution.cappedLeaderShare,
      reason: 'trade.copy.fee_share',
    }),
  };
}

/** Post settle plan in order. Idempotent via recipe keys. */
export async function postCopyFeeShareSettle(ledger: LedgerClient, plan: FeeShareSettlePlan): Promise<void> {
  await ledger.post(plan.sweep);
  await ledger.post(plan.payout);
}

/** Explicit ban — any P&L-linked fee is forbidden in v1 (SPEC §3). */
export function refusePnlLinkedCopyFee(): never {
  logRefusalSpec('trade.copy_pnl_fee_forbidden');
  throw new CopyError(
    'Copy trading does not charge a fee on profit. Only a share of the trading fee is allowed, and that share is not set.',
    'trade.copy_pnl_fee_forbidden',
    COPY_FEE_SHARE_RESIDUAL,
  );
}

export function presentFeeShareAttribution(a: FeeShareAttribution) {
  return {
    fillId: a.fillId,
    leaderId: a.leaderId,
    followerId: a.followerId,
    assetId: a.assetId,
    protocolFee: formatAmount(a.protocolFee),
    appliedShareBps: a.appliedShareBps,
    grossLeaderShare: formatAmount(a.grossLeaderShare),
    cappedLeaderShare: formatAmount(a.cappedLeaderShare),
    skippedReason: a.skippedReason,
  };
}

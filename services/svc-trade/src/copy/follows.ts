/**
 * Copy follow / unfollow — non-custody envelope (D-S-03 §2).
 *
 * Follower funds stay in the follower's account. This module records the
 * signed envelope (markets, caps, expiry) and never pools. Jurisdiction
 * screening runs before any follow is accepted — blank §8 list → refuse.
 */

import type { AlgoPlaceGrant } from '../algo/durable-principal.js';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { copyNewIntentFenced, followRelationshipState, type CopyRelationshipState } from './copy-lifecycle.js';
import { customerStatus, type CopyLeaderCustomerStatus, type CopyLeaderListingState } from './leader-listing.js';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { COPY_JURISDICTION_RESIDUAL, CopyError } from './errors.js';
import type { CopyJurisdictionLaw } from './fee-share-law.js';

export interface CopyEnvelope {
  /** Markets the follower permits the session to trade. */
  readonly permittedMarkets: readonly string[];
  /** Max notional per mirrored order (decimal string → Amount). */
  readonly maxNotionalPerOrder: Amount;
  /** Max aggregate open exposure (decimal string → Amount). */
  readonly maxAggregateExposure: Amount;
  /** Independent session loss cap — leader settings cannot raise this. */
  readonly maxLoss?: Amount;
  /** Max |follower limit − leader fill| in whole basis points. Unset means the axis is off. */
  readonly maxSlippageBps?: number;
  /** Max placed mirrors of this follow that are not yet terminal. */
  readonly maxConcurrent?: number;
  /** Max drop from the follow's peak result. Does not close existing positions. */
  readonly maxDrawdown?: Amount;
  /** Envelope expiry — unilateral revoke is always allowed before this. */
  readonly expiresAt: Date;
  /** Quote amount each copied order uses. Unset means no fixed size; never defaulted. At most maxNotionalPerOrder. */
  readonly fixedOrderSize?: Amount;
}

/**
 * How much of the follower's own spot balance this follow may use (CB-copy-03). A svc-trade limit row, not a balance
 * and not a ledger hold: nothing posts when it is held or released, and each copied order takes its own order hold.
 */
export interface CopyFollowReserve {
  readonly asset: string;
  readonly amount: Amount;
  readonly heldAt: Date;
  readonly releasedAt: Date | null;
}

/** The reserve's business key. One per follow. */
export function copyReserveKey(followId: string): string {
  return `copy.reserve:${followId}`;
}

export interface CopyFollow {
  readonly followId: string;
  readonly followerId: string;
  readonly leaderId: string;
  readonly envelope: CopyEnvelope;
  readonly region: string;
  readonly createdAt: Date;
  /** Kill switch for fee-share on this follow (earnings stop; follow may remain). */
  readonly feeShareKilled: boolean;
  /** sha256 of the auto-mirror session-key — never the raw token. */
  readonly sessionKeyHash?: string | null;
  readonly sessionKeyPrefix?: string | null;
  /** Kill of the auto-mirror grant; follow may remain. */
  readonly sessionKeyRevoked?: boolean;
  /** PTX-M26-R05 — ACTIVE ↔ PAUSED → STOPPING → DETACHED. Missing = ACTIVE. */
  readonly relationshipState?: CopyRelationshipState;
  /** High-water mark of the result figure. Written when a mirror is planned. */
  readonly peakResult?: Amount;
  /** Held with the follow; missing on follows made before the reserve existed. */
  readonly reserve?: CopyFollowReserve;
  /**
   * The follower's claims when they granted automatic copying, so the copy driver can place each copy as them until
   * the envelope expires (the same durable grant the algo engine keeps). Every copy still takes its own live
   * admission, and a revoked session key stops the driver. Missing until copying is granted.
   */
  readonly placeGrant?: AlgoPlaceGrant;
  /**
   * The last leader fill the copy driver dealt with (copied or refused), or the moment copying was turned on. The
   * driver reads only fills after it, so a fill is tried once and nothing from before copying was on is copied.
   */
  readonly copyCursor?: CopyCursor;
}

/** A point in a leader's fills: their time, then id. A null fill id is the moment itself. */
export type CopyCursor = { readonly at: Date; readonly fillId: string | null };

export interface PresentCopyFollow {
  readonly followId: string;
  readonly followerId: string;
  /** Leader user id when no listing row exists. Null when any listing row exists. */
  readonly leaderId: string | null;
  /** Listing ref when a listing row exists. Null when the leader has no row. */
  readonly leaderRef: string | null;
  readonly permittedMarkets: readonly string[];
  readonly maxNotionalPerOrder: string;
  readonly maxAggregateExposure: string;
  /** Quote amount each copied order uses; null when the follower chose no fixed size. */
  readonly fixedOrderSize: string | null;
  /** The reserve held for this follow; null on follows made before it existed. Not a balance and not a hold. */
  readonly reserve: { readonly asset: string; readonly amount: string; readonly released: boolean } | null;
  readonly maxLoss: string | null;
  readonly maxSlippageBps: number | null;
  readonly maxConcurrent: number | null;
  readonly maxDrawdown: string | null;
  readonly peakResult: string | null;
  /** Cumulative session budget spent — mirrors durable store exposure, not net position. */
  readonly currentExposure: string;
  /** Headroom under maxAggregateExposure; zero when exhausted. */
  readonly remainingExposure: string;
  readonly expiresAt: string;
  readonly region: string;
  readonly createdAt: string;
  readonly feeShareKilled: boolean;
  readonly sessionKeyGranted: boolean;
  readonly sessionKeyRevoked: boolean;
  readonly sessionKeyPrefix?: string;
  readonly sessionKeyId?: string;
  /** Raw token — grantSessionKey only, never list/store. */
  readonly sessionKey?: string;
  readonly relationshipState: CopyRelationshipState;
  readonly newIntentFenced: boolean;
  /** listed, suspended, delisted, or unknown when no listing exists. Never assumed listed. */
  readonly leaderStatus: CopyLeaderCustomerStatus;
}

export function parseCopyEnvelope(input: {
  permittedMarkets: readonly string[];
  maxNotionalPerOrder: string;
  maxAggregateExposure: string;
  maxLoss?: string;
  /** Blank means no fixed size. Zero, or above maxNotionalPerOrder, refuses. */
  fixedOrderSize?: string | null;
  expiresAt: Date | string;
  now: Date;
}): CopyEnvelope {
  const markets = input.permittedMarkets.map((m) => m.trim()).filter(Boolean);
  if (markets.length === 0) {
    throw new CopyError('Copy envelope requires at least one permitted market', 'trade.copy_envelope_invalid');
  }

  let maxNotionalPerOrder: Amount;
  let maxAggregateExposure: Amount;
  try {
    maxNotionalPerOrder = parseAmount(input.maxNotionalPerOrder);
    maxAggregateExposure = parseAmount(input.maxAggregateExposure);
  } catch {
    throw new CopyError('Copy envelope caps must be valid decimal amounts', 'trade.copy_envelope_invalid');
  }
  if (maxNotionalPerOrder <= 0n || maxAggregateExposure <= 0n) {
    throw new CopyError('Copy envelope caps must be strictly positive', 'trade.copy_envelope_invalid');
  }
  if (maxNotionalPerOrder > maxAggregateExposure) {
    throw new CopyError('maxNotionalPerOrder cannot exceed maxAggregateExposure', 'trade.copy_envelope_invalid');
  }

  let maxLoss: Amount | undefined;
  const lossRaw = input.maxLoss?.trim();
  if (lossRaw) {
    try {
      maxLoss = parseAmount(lossRaw);
    } catch {
      throw new CopyError('Copy envelope caps must be valid decimal amounts', 'trade.copy_envelope_invalid');
    }
    if (maxLoss <= 0n) {
      throw new CopyError('Copy envelope caps must be strictly positive', 'trade.copy_envelope_invalid');
    }
  }

  let fixedOrderSize: Amount | undefined;
  const fixedRaw = input.fixedOrderSize?.trim();
  if (fixedRaw) {
    try {
      fixedOrderSize = parseAmount(fixedRaw);
    } catch {
      throw new CopyError('The fixed amount must be a valid decimal amount', 'trade.copy_envelope_invalid');
    }
    if (fixedOrderSize <= 0n) {
      throw new CopyError('The fixed amount must be above zero', 'trade.copy_envelope_invalid');
    }
    if (fixedOrderSize > maxNotionalPerOrder) {
      throw new CopyError(
        `The fixed amount cannot be above the most per order, ${formatAmount(maxNotionalPerOrder)}`,
        'trade.copy_fixed_size_above_cap',
      );
    }
  }

  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= input.now.getTime()) {
    throw new CopyError('Copy envelope expiry must be in the future', 'trade.copy_envelope_invalid');
  }

  return {
    permittedMarkets: markets,
    maxNotionalPerOrder,
    maxAggregateExposure,
    expiresAt,
    ...(maxLoss !== undefined ? { maxLoss } : {}),
    ...(fixedOrderSize !== undefined ? { fixedOrderSize } : {}),
  };
}

/**
 * Closed-region screen. Unpublished law = every region closed (never invent ISO).
 * Off-allowlist / blank region = blocked. Null = open.
 */
export function copyRegionClosed(law: CopyJurisdictionLaw, region: string): CopyError | null {
  if (!law || law.published !== true) {
    logRefusalSpec('trade.copy_jurisdiction_blank');
    return new CopyError(COPY_JURISDICTION_RESIDUAL, 'trade.copy_jurisdiction_blank', COPY_JURISDICTION_RESIDUAL);
  }
  const code = region.trim().toUpperCase();
  if (!code) {
    return new CopyError('Follower region is required for copy screening', 'trade.copy_jurisdiction_blocked');
  }
  if (!law.allowedRegions.includes(code)) {
    return new CopyError(`Copy follow refused for region ${code} — not on owner-published allowlist`, 'trade.copy_jurisdiction_blocked');
  }
  return null;
}

/** Screen region against owner-published allowlist. Blank law → refuse (never invent). */
export function assertCopyRegionAllowed(law: CopyJurisdictionLaw, region: string): string {
  const closed = copyRegionClosed(law, region);
  if (closed) throw closed;
  return region.trim().toUpperCase();
}

export function presentCopyFollow(
  follow: CopyFollow,
  currentExposure: Amount = 0n,
  listing: { readonly leaderRef: string; readonly state: CopyLeaderListingState } | null = null,
): PresentCopyFollow {
  const remaining = follow.envelope.maxAggregateExposure > currentExposure ? follow.envelope.maxAggregateExposure - currentExposure : 0n;
  return {
    followId: follow.followId,
    followerId: follow.followerId,
    leaderId: listing ? null : follow.leaderId,
    leaderRef: listing ? listing.leaderRef : null,
    permittedMarkets: follow.envelope.permittedMarkets,
    maxNotionalPerOrder: formatAmount(follow.envelope.maxNotionalPerOrder),
    maxAggregateExposure: formatAmount(follow.envelope.maxAggregateExposure),
    fixedOrderSize: follow.envelope.fixedOrderSize !== undefined ? formatAmount(follow.envelope.fixedOrderSize) : null,
    reserve: follow.reserve
      ? { asset: follow.reserve.asset, amount: formatAmount(follow.reserve.amount), released: follow.reserve.releasedAt !== null }
      : null,
    maxLoss: follow.envelope.maxLoss !== undefined ? formatAmount(follow.envelope.maxLoss) : null,
    maxSlippageBps: follow.envelope.maxSlippageBps ?? null,
    maxConcurrent: follow.envelope.maxConcurrent ?? null,
    maxDrawdown: follow.envelope.maxDrawdown !== undefined ? formatAmount(follow.envelope.maxDrawdown) : null,
    peakResult: follow.peakResult !== undefined ? formatAmount(follow.peakResult) : null,
    currentExposure: formatAmount(currentExposure),
    remainingExposure: formatAmount(remaining),
    expiresAt: follow.envelope.expiresAt.toISOString(),
    region: follow.region,
    createdAt: follow.createdAt.toISOString(),
    feeShareKilled: follow.feeShareKilled,
    sessionKeyGranted: Boolean(follow.sessionKeyHash) && follow.sessionKeyRevoked !== true,
    sessionKeyRevoked: follow.sessionKeyRevoked === true,
    relationshipState: followRelationshipState(follow),
    newIntentFenced: copyNewIntentFenced(followRelationshipState(follow)),
    leaderStatus: customerStatus(listing?.state),
    ...(follow.sessionKeyPrefix ? { sessionKeyPrefix: follow.sessionKeyPrefix, sessionKeyId: follow.sessionKeyPrefix } : {}),
  };
}

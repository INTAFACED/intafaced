/**
 * Copy observation → scoped mirror plan (D-S-03 §2).
 *
 * No discretion: we either mirror within the follower's envelope or refuse
 * with a typed reason. Never resize, never invent a fill, never silently drop.
 * Session-key enforcement is on-chain; this is the service-side honesty gate.
 */

import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { CopyError } from './errors.js';
import { canonicalizeCopyFillId } from './fee-share.js';
import type { CopyFollow } from './follows.js';

export type MirrorSide = 'buy' | 'sell';

/**
 * One leader fill the copy desk observed.
 *
 * `fillId` is mandatory — it is the engine business key (same family as
 * `fillIdFor(market, sequence)` on the spot settle path and fee-share's
 * `fillId`). Without it a redelivered observation would plan a second mirror
 * and double-count session exposure. The store claims each fillId once per
 * follow; a second call returns the prior plan and moves nothing.
 */
export interface LeaderFillObservation {
  readonly fillId: string;
  readonly leaderId: string;
  readonly marketId: string;
  readonly side: MirrorSide;
  readonly qty: Amount;
  readonly notional: Amount;
  readonly observedAt: Date;
}

export interface MirrorPlan {
  readonly fillId: string;
  readonly followId: string;
  readonly followerId: string;
  readonly leaderId: string;
  readonly marketId: string;
  readonly side: MirrorSide;
  readonly qty: Amount;
  readonly notional: Amount;
  /**
   * Signed net exposure once this mirror is taken — the value the caller must
   * persist. Carried on the plan so the write cannot recompute it differently
   * from the check that approved it.
   */
  readonly nextExposure: Amount;
  readonly reason: 'within_envelope';
}

export interface PresentMirrorPlan {
  readonly fillId: string;
  readonly followId: string;
  readonly followerId: string;
  readonly leaderId: string;
  readonly marketId: string;
  readonly side: MirrorSide;
  readonly qty: string;
  readonly notional: string;
  readonly nextExposure: string;
  readonly reason: 'within_envelope';
}

/**
 * Exposure after mirroring one leader fill.
 *
 * Exposure is a CUMULATIVE SESSION BUDGET, not a net position: every mirror
 * adds, whatever its side, and nothing ever gives budget back.
 *
 * That is not an accident of this service — it is what the envelope IS.
 * `SessionKeyLib.sol` holds the real cap as `uint128 spendLimitWei`,
 * documented as "cumulative cap on native value this session may ever move",
 * and SPEC-SOVEREIGN §2 is explicit that the cap is enforced on-chain because
 * "a cap only we enforce is a promise; a cap the account enforces is a fact".
 * This module is the service-side honesty gate in front of that account, so
 * its arithmetic has to agree with the chain's. Netting a sell against a buy
 * here would approve mirrors the account will reject, which is worse than
 * refusing them.
 *
 * A follower who exhausts their budget is a session key with its
 * `spendLimitWei` spent. The remedy is a NEW session — a fresh follow with a
 * fresh envelope and expiry — not handing budget back, which the chain cannot
 * do either.
 *
 * This exists as one exported function because the real bug was two
 * expressions that disagreed about the same number: `planMirror` checked
 * `currentExposure + observation.notional` while `CopyService` separately
 * wrote `current + plan.notional`. They happened to agree, and nothing made
 * them. The check and the write now call this, and the approved value rides on
 * the plan, so they cannot drift apart.
 */
export function exposureAfterMirror(currentExposure: Amount, _side: MirrorSide, notional: Amount): Amount {
  return currentExposure + notional;
}

/**
 * Build a mirror plan for one follow against one leader fill.
 * Refuses (never invents) when caps / market / expiry fail.
 */
export function planMirror(input: {
  follow: CopyFollow;
  observation: LeaderFillObservation;
  /** Current aggregate exposure already open for this follow. */
  currentExposure: Amount;
  now: Date;
  /** The market's quantity step. A fixed-amount quantity is rounded down to it. */
  lotSize?: Amount;
}): MirrorPlan {
  const { follow, observation } = input;

  if (follow.leaderId !== observation.leaderId) {
    throw new CopyError('Observation leader does not match follow', 'trade.copy_envelope_invalid');
  }

  if (input.now.getTime() >= follow.envelope.expiresAt.getTime()) {
    throw new CopyError('Copy session envelope expired — refuse rather than invent', 'trade.copy_key_expired');
  }

  if (!follow.envelope.permittedMarkets.includes(observation.marketId)) {
    throw new CopyError(`Market ${observation.marketId} is outside the follower envelope`, 'trade.copy_market_not_permitted');
  }

  if (observation.qty <= 0n || observation.notional <= 0n) {
    throw new CopyError('Leader fill qty/notional must be strictly positive', 'trade.copy_envelope_invalid');
  }

  // A fixed amount sizes every copied order at that quote amount, the quantity scaled from the leader's fill price.
  // Rounded down to the market's lot step, so the quote amount is what that quantity costs at the leader's price.
  const fixed = follow.envelope.fixedOrderSize;
  const scaled = fixed === undefined ? observation.qty : (observation.qty * fixed) / observation.notional;
  const qty = fixed !== undefined && input.lotSize !== undefined && input.lotSize > 0n ? scaled - (scaled % input.lotSize) : scaled;
  if (qty <= 0n) {
    throw new CopyError('The fixed amount buys less than the smallest quantity at this price', 'trade.copy_cap_exceeded');
  }
  const notional = fixed === undefined ? observation.notional : (qty * observation.notional) / observation.qty;

  if (notional > follow.envelope.maxNotionalPerOrder) {
    throw new CopyError(
      `Mirror notional ${formatAmount(notional)} exceeds per-order cap ${formatAmount(follow.envelope.maxNotionalPerOrder)}`,
      'trade.copy_cap_exceeded',
    );
  }

  const nextExposure = exposureAfterMirror(input.currentExposure, observation.side, notional);
  if (nextExposure > follow.envelope.maxAggregateExposure) {
    throw new CopyError(
      `Mirror would exceed aggregate exposure cap ${formatAmount(follow.envelope.maxAggregateExposure)}`,
      'trade.copy_cap_exceeded',
    );
  }

  return {
    fillId: observation.fillId,
    followId: follow.followId,
    followerId: follow.followerId,
    leaderId: follow.leaderId,
    marketId: observation.marketId,
    side: observation.side,
    qty,
    notional,
    nextExposure,
    reason: 'within_envelope',
  };
}

export function parseLeaderFillObservation(input: {
  fillId: string;
  leaderId: string;
  marketId: string;
  side: MirrorSide;
  qty: string;
  notional: string;
  observedAt?: Date;
}): LeaderFillObservation {
  if (input.side !== 'buy' && input.side !== 'sell') {
    throw new CopyError('Mirror side must be buy|sell', 'trade.copy_envelope_invalid');
  }
  const trimmed = input.fillId.trim();
  if (!trimmed) {
    throw new CopyError('Leader fill id required — without it a redelivered fill would mirror twice', 'trade.copy_envelope_invalid');
  }
  if (trimmed.length > 128) {
    throw new CopyError('Leader fill id exceeds 128 chars', 'trade.copy_envelope_invalid');
  }
  const fillId = canonicalizeCopyFillId(trimmed);
  const marketId = input.marketId.trim();
  if (!marketId) {
    throw new CopyError('Market id required', 'trade.copy_envelope_invalid');
  }
  let qty: Amount;
  let notional: Amount;
  try {
    qty = parseAmount(input.qty);
    notional = parseAmount(input.notional);
  } catch {
    throw new CopyError('Leader fill amounts must be valid decimals', 'trade.copy_envelope_invalid');
  }
  return {
    fillId,
    leaderId: input.leaderId.trim(),
    marketId,
    side: input.side,
    qty,
    notional,
    observedAt: input.observedAt ?? new Date(),
  };
}

export function presentMirrorPlan(plan: MirrorPlan): PresentMirrorPlan {
  return {
    fillId: plan.fillId,
    followId: plan.followId,
    followerId: plan.followerId,
    leaderId: plan.leaderId,
    marketId: plan.marketId,
    side: plan.side,
    qty: formatAmount(plan.qty),
    notional: formatAmount(plan.notional),
    nextExposure: formatAmount(plan.nextExposure),
    reason: plan.reason,
  };
}

/** Explicit ban — never rank leaders by returns (SPEC §4). */
export function refuseCopyLeaderRanking(): never {
  logRefusalSpec('trade.copy_ranking_forbidden');
  throw new CopyError('Copy trading does not rank leaders by returns. Search verified history instead.', 'trade.copy_ranking_forbidden');
}

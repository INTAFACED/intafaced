import { compare, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { MerchantStatus } from './merchant-programme.js';

/**
 * P-ads-merchant-13 — merchant tier ladder, badge, benefits and automatic tier
 * review (pure, no I/O). NO application path (that is P-ads-merchant-14).
 *
 * Tier is ORTHOGONAL to standing (MerchantStatus): only an `approved` merchant
 * gets tier benefits or a tier badge, so the dispute-law suspension always wins.
 * Owner values (ladder, cadence, upgrade delay, assessment period) are
 * `owner-decision`: blank means no tiers, no badge, no benefits, no sweeper action.
 */

export type TierCode = 'p2p.tier_ladder_unset' | 'p2p.invalid_tier_transition' | 'p2p.reason_required' | 'p2p.invalid_tier';

export class TierError extends Error {
  constructor(
    message: string,
    readonly code: TierCode,
  ) {
    super(message);
    this.name = 'TierError';
  }
}

export interface TierRequirements {
  readonly minCompletedTrades: number;
  /** Completion rate floor in basis points (0..10000). */
  readonly minCompletionBps: number;
}

export interface TierBenefits {
  /** Order ceiling (scaled Amount). */
  readonly orderCeiling: Amount;
  readonly maxPendingOrders: number;
}

export interface Tier {
  readonly rank: number;
  readonly name: string;
  readonly requirements: TierRequirements;
  readonly benefits: TierBenefits;
}

export interface TierPolicy {
  readonly ladder: readonly Tier[];
  readonly upgradeDelayMs: number;
  readonly assessmentPeriodMs: number;
}

export interface TierPolicyInput {
  ladder?:
    | readonly {
        rank: number;
        name: string;
        minCompletedTrades: number;
        minCompletionBps: number;
        orderCeiling: string;
        maxPendingOrders: number;
      }[]
    | null;
  upgradeDelayMs?: number | null;
  assessmentPeriodMs?: number | null;
}

function nonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** `tiers.set` validation (founder-ops). Any blank owner value refuses. */
export function parseTierPolicy(input: TierPolicyInput): TierPolicy {
  if (!input.ladder || input.ladder.length === 0 || input.upgradeDelayMs == null || input.assessmentPeriodMs == null) {
    throw new TierError('Tier ladder is unset (owner decision)', 'p2p.tier_ladder_unset');
  }
  if (!nonNegInt(input.upgradeDelayMs) || !nonNegInt(input.assessmentPeriodMs)) {
    throw new TierError('Delays must be non-negative integers (ms)', 'p2p.invalid_tier');
  }
  const ladder = [...input.ladder]
    .map((t): Tier => {
      if (!Number.isSafeInteger(t.rank) || t.rank < 1 || t.name.trim() === '') {
        throw new TierError('Tier needs rank >= 1 and a name', 'p2p.invalid_tier');
      }
      if (!nonNegInt(t.minCompletedTrades) || !nonNegInt(t.minCompletionBps) || t.minCompletionBps > 10_000) {
        throw new TierError(`Tier ${t.rank} requirements invalid`, 'p2p.invalid_tier');
      }
      if (!Number.isSafeInteger(t.maxPendingOrders) || t.maxPendingOrders < 1) {
        throw new TierError(`Tier ${t.rank} maxPendingOrders invalid`, 'p2p.invalid_tier');
      }
      let ceiling: Amount;
      try {
        ceiling = parseAmount(t.orderCeiling);
      } catch {
        throw new TierError(`Tier ${t.rank} orderCeiling invalid`, 'p2p.invalid_tier');
      }
      if (ceiling <= 0n) throw new TierError(`Tier ${t.rank} orderCeiling invalid`, 'p2p.invalid_tier');
      return {
        rank: t.rank,
        name: t.name.trim(),
        requirements: { minCompletedTrades: t.minCompletedTrades, minCompletionBps: t.minCompletionBps },
        benefits: { orderCeiling: ceiling, maxPendingOrders: t.maxPendingOrders },
      };
    })
    .sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < ladder.length; i++) {
    const lo = ladder[i - 1]!;
    const hi = ladder[i]!;
    if (lo.rank === hi.rank) throw new TierError(`Duplicate tier rank ${hi.rank}`, 'p2p.invalid_tier');
    if (
      hi.requirements.minCompletedTrades < lo.requirements.minCompletedTrades ||
      hi.requirements.minCompletionBps < lo.requirements.minCompletionBps ||
      compare(hi.benefits.orderCeiling, lo.benefits.orderCeiling) < 0
    ) {
      throw new TierError(`Tier ${hi.rank} must not be easier or smaller than tier ${lo.rank}`, 'p2p.invalid_tier');
    }
  }
  return { ladder, upgradeDelayMs: input.upgradeDelayMs, assessmentPeriodMs: input.assessmentPeriodMs };
}

export interface TierMetrics {
  readonly completedTrades: number;
  /** null when there is no history: qualifies for nothing. */
  readonly completionBps: number | null;
}

/** Highest rank whose requirements the metrics meet, or null. */
export function qualifyingRank(ladder: readonly Tier[], m: TierMetrics): number | null {
  let best: number | null = null;
  if (m.completionBps === null) return null;
  for (const t of ladder) {
    if (m.completedTrades >= t.requirements.minCompletedTrades && m.completionBps >= t.requirements.minCompletionBps) {
      best = t.rank;
    }
  }
  return best;
}

export type TierState = 'active' | 'assessment' | 'downgrade_requested' | 'revoked';

/** Closed tier-state edge list. */
export const TIER_EDGES: Readonly<Record<TierState, readonly TierState[]>> = Object.freeze({
  active: ['assessment', 'downgrade_requested', 'revoked'],
  assessment: ['active', 'revoked'],
  downgrade_requested: ['active', 'revoked'],
  revoked: ['active'],
});

export function assertTierTransition(from: TierState, to: TierState): void {
  if (!TIER_EDGES[from].includes(to)) {
    throw new TierError(`Tier state ${from} -> ${to} is not allowed`, 'p2p.invalid_tier_transition');
  }
}

export interface MerchantTierRecord {
  readonly rank: number | null;
  readonly state: TierState;
  /** When the merchant first qualified for a higher rank (upgrade delay clock). */
  readonly qualifiedSince: number | null;
  readonly assessmentEndsAt: number | null;
}

/**
 * Applier contract: `upgrade` and `reset_upgrade_clock` both clear
 * `qualifiedSince`, so every upgrade waits the full owner delay again.
 */
export type TierMove =
  | { readonly kind: 'none' }
  | { readonly kind: 'start_upgrade_clock'; readonly at: number }
  | { readonly kind: 'reset_upgrade_clock' }
  | { readonly kind: 'upgrade'; readonly from: number | null; readonly to: number }
  | { readonly kind: 'start_assessment'; readonly endsAt: number }
  | { readonly kind: 'end_assessment' }
  | { readonly kind: 'downgrade'; readonly from: number; readonly to: number | null };

/**
 * One sweeper decision. Idempotent: applying the move and re-running with the
 * same metrics and clock yields `none`. Never raises a tier before the owner
 * upgrade delay. Blank policy or a non-approved merchant: `none`.
 */
export function reassess(input: {
  policy: TierPolicy | null;
  status: MerchantStatus;
  record: MerchantTierRecord;
  metrics: TierMetrics;
  now: number;
}): TierMove {
  const { policy, record, metrics, now } = input;
  if (policy === null || input.status !== 'approved') return { kind: 'none' };
  if (record.state === 'revoked' || record.state === 'downgrade_requested') return { kind: 'none' };
  const target = qualifyingRank(policy.ladder, metrics);
  const current = record.rank;

  // The upgrade clock only runs while a HIGHER rank is met. Dropping back
  // resets it, so a later re-qualification waits the full delay again.
  if (record.qualifiedSince !== null && !(target !== null && (current === null || target > current))) {
    return { kind: 'reset_upgrade_clock' };
  }

  if (record.state === 'assessment') {
    if (target !== null && current !== null && target >= current) return { kind: 'end_assessment' };
    if (record.assessmentEndsAt !== null && now >= record.assessmentEndsAt && current !== null) {
      return { kind: 'downgrade', from: current, to: target };
    }
    return { kind: 'none' };
  }

  if (current !== null && (target === null || target < current)) {
    return { kind: 'start_assessment', endsAt: now + policy.assessmentPeriodMs };
  }
  if (target !== null && (current === null || target > current)) {
    if (record.qualifiedSince === null) return { kind: 'start_upgrade_clock', at: now };
    if (now - record.qualifiedSince >= policy.upgradeDelayMs) return { kind: 'upgrade', from: current, to: target };
  }
  return { kind: 'none' };
}

/** Merchant asks to step down a tier; a reason is required. */
export function requestDowngrade(record: MerchantTierRecord, reason: string): TierState {
  if (reason.trim() === '') throw new TierError('A reason is required', 'p2p.reason_required');
  assertTierTransition(record.state, 'downgrade_requested');
  return 'downgrade_requested';
}

function tierOf(policy: TierPolicy | null, status: MerchantStatus, record: MerchantTierRecord | null): Tier | null {
  if (policy === null || status !== 'approved' || record === null || record.rank === null) return null;
  if (record.state === 'revoked') return null;
  return policy.ladder.find((t) => t.rank === record.rank) ?? null;
}

/** Benefits in force. Standing wins: suspended/other non-approved → none. */
export function tierBenefits(policy: TierPolicy | null, status: MerchantStatus, record: MerchantTierRecord | null): TierBenefits | null {
  return tierOf(policy, status, record)?.benefits ?? null;
}

/** Public badge: name and rank only, never requirements or metrics. */
export function tierBadge(
  policy: TierPolicy | null,
  status: MerchantStatus,
  record: MerchantTierRecord | null,
): { readonly rank: number; readonly name: string } | null {
  const t = tierOf(policy, status, record);
  return t ? { rank: t.rank, name: t.name } : null;
}

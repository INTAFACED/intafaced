import { isNegative, isZero, parseAmount } from '@intafaced/ledger-client';

/**
 * §28 / M22 / M25 — arb legs are non-atomic.
 *
 * Cross-venue buy+sell is two independent submissions. A filled first leg plus
 * a refused or unknown second leg is not a successful arb. Unknown is not a
 * reject (it must not invite a duplicate retry dressed as success).
 */

/** Typed `false` so `if (ARB_LEGS_ATOMIC)` cannot compile a success-on-partial path. */
export const ARB_LEGS_ATOMIC: false = false;

export const ARB_LEG_OUTCOMES = ['APPLIED', 'REFUSED', 'UNWIRED', 'OUTCOME_UNKNOWN'] as const;
export type ArbLegOutcome = (typeof ARB_LEG_OUTCOMES)[number];

export type PlanArbLegsInput = {
  readonly symbol: string;
  readonly amount: string;
  readonly buyVenueId: string;
  readonly sellVenueId: string;
  readonly inventory: { readonly prePositionedByVenue: Readonly<Record<string, boolean>> };
};

export type PlanArbLegsRefuseReason = 'same_venue' | 'inventory_missing' | 'size_refused';

export type ArbPlannedLeg = {
  readonly side: 'buy' | 'sell';
  readonly venueId: string;
  readonly symbol: string;
  readonly amount: string;
};

export type PlanArbLegsAccepted = {
  readonly ok: true;
  readonly atomic: false;
  readonly symbol: string;
  readonly amount: string;
  readonly expectedLegCount: 2;
  readonly legs: readonly [ArbPlannedLeg, ArbPlannedLeg];
};

export type PlanArbLegsRefusal = {
  readonly ok: false;
  readonly atomic: false;
  readonly reason: PlanArbLegsRefuseReason;
  readonly detail: string;
};

export type PlanArbLegsResult = PlanArbLegsAccepted | PlanArbLegsRefusal;

export type ArbLegResult = {
  readonly side: 'buy' | 'sell';
  readonly venueId: string;
  readonly outcome: ArbLegOutcome;
};

export type ReduceArbLegGroupInput = {
  /** Planned size of the group. A truncated observation cannot look like success. */
  readonly expectedLegCount: number;
  readonly legs: readonly ArbLegResult[];
};

export type ArbLegGroupRefuseReason = 'empty_legs' | 'incomplete_legs' | 'failed_leg' | 'partial_legs' | 'unknown_leg';

type ArbLegGroupBuckets = {
  readonly applied: readonly ArbLegResult[];
  readonly refused: readonly ArbLegResult[];
  readonly unknown: readonly ArbLegResult[];
};

export type ArbLegGroupSuccess = ArbLegGroupBuckets & {
  readonly ok: true;
  readonly atomic: false;
  readonly outcome: 'APPLIED';
};

export type ArbLegGroupFailure = ArbLegGroupBuckets & {
  readonly ok: false;
  readonly atomic: false;
  readonly outcome: 'REFUSED' | 'OUTCOME_UNKNOWN';
  readonly reason: ArbLegGroupRefuseReason;
  readonly detail: string;
};

export type ArbLegGroupResult = ArbLegGroupSuccess | ArbLegGroupFailure;

function buckets(legs: readonly ArbLegResult[]): ArbLegGroupBuckets {
  return {
    applied: legs.filter((leg) => leg.outcome === 'APPLIED'),
    refused: legs.filter((leg) => leg.outcome === 'REFUSED' || leg.outcome === 'UNWIRED'),
    unknown: legs.filter((leg) => leg.outcome === 'OUTCOME_UNKNOWN'),
  };
}

function failure(
  split: ArbLegGroupBuckets,
  outcome: 'REFUSED' | 'OUTCOME_UNKNOWN',
  reason: ArbLegGroupRefuseReason,
  detail: string,
): ArbLegGroupFailure {
  return { ok: false, atomic: ARB_LEGS_ATOMIC, outcome, reason, detail, ...split };
}

function sizeRefused(): PlanArbLegsRefusal {
  return {
    ok: false,
    atomic: ARB_LEGS_ATOMIC,
    reason: 'size_refused',
    detail: 'size must be a positive decimal string — blank, zero, and non-decimal sizes are refused',
  };
}

/**
 * Plan buy+sell legs. Planning both does not make submission atomic.
 * Missing inventory is refused — never sized on a bridge completing in-spread.
 * A blank, zero, or non-decimal size is refused. No default size is substituted.
 */
export function planArbLegs(input: PlanArbLegsInput): PlanArbLegsResult {
  if (input.buyVenueId === input.sellVenueId) {
    return {
      ok: false,
      atomic: ARB_LEGS_ATOMIC,
      reason: 'same_venue',
      detail: 'buy and sell venue must differ',
    };
  }

  const buyReady = input.inventory.prePositionedByVenue[input.buyVenueId] === true;
  const sellReady = input.inventory.prePositionedByVenue[input.sellVenueId] === true;
  if (!buyReady || !sellReady) {
    return {
      ok: false,
      atomic: ARB_LEGS_ATOMIC,
      reason: 'inventory_missing',
      detail: 'both venues must be pre-positioned for cross-venue arb legs — refuse bridge fantasy',
    };
  }

  try {
    const size = parseAmount(input.amount);
    if (isZero(size) || isNegative(size)) return sizeRefused();
  } catch {
    return sizeRefused();
  }

  return {
    ok: true,
    atomic: ARB_LEGS_ATOMIC,
    symbol: input.symbol,
    amount: input.amount,
    expectedLegCount: 2,
    legs: [
      { side: 'buy', venueId: input.buyVenueId, symbol: input.symbol, amount: input.amount },
      { side: 'sell', venueId: input.sellVenueId, symbol: input.symbol, amount: input.amount },
    ],
  };
}

/**
 * Group outcome for non-atomic arb legs.
 *
 * Success only when every expected leg is APPLIED. Any unknown leg is
 * OUTCOME_UNKNOWN (not success, not a refuse that invites a duplicate). Any
 * refused/unwired leg with no unknown is REFUSED. Partial fill of the group
 * stays visible on the buckets and never flips `ok` to true.
 */
export function reduceArbLegGroup(input: ReduceArbLegGroupInput): ArbLegGroupResult {
  const expected = input.expectedLegCount;
  const split = buckets(input.legs);

  if (!Number.isInteger(expected) || expected < 1) {
    return failure(split, 'REFUSED', 'empty_legs', 'expectedLegCount missing — group success not invented');
  }

  if (input.legs.length === 0) {
    return failure(split, 'REFUSED', 'empty_legs', 'no legs observed — group success not invented');
  }

  // Unknown beats refuse: a transport hole is not a reject, and not a win.
  if (split.unknown.length > 0) {
    return failure(split, 'OUTCOME_UNKNOWN', 'unknown_leg', 'a leg is unresolved — the arb did not succeed; lookup before retry');
  }

  if (input.legs.length !== expected) {
    return failure(split, 'OUTCOME_UNKNOWN', 'incomplete_legs', 'observed legs do not match the plan — truncated group is not success');
  }

  if (split.refused.length > 0) {
    return failure(
      split,
      'REFUSED',
      split.applied.length > 0 ? 'partial_legs' : 'failed_leg',
      split.applied.length > 0 ? 'a failed leg does not make the remaining fills a successful arb' : 'a failed leg is not a successful arb',
    );
  }

  if (split.applied.length !== expected) {
    return failure(split, 'OUTCOME_UNKNOWN', 'incomplete_legs', 'not every expected leg is APPLIED — group success not invented');
  }

  return {
    ok: true,
    atomic: ARB_LEGS_ATOMIC,
    outcome: 'APPLIED',
    ...split,
  };
}

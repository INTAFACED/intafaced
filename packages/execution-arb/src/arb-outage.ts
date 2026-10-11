/**
 * §28 / PTX-M22-R07 — venue outage, timeout, and missing fill reports are not
 * a successful arb and never invent a fill. Duplicate recovery is idempotent.
 */
import { compare, formatAmount, isNegative, isZero, parseAmount } from '@intafaced/ledger-client';
import { ARB_LEGS_ATOMIC, reduceArbLegGroup, type ArbLegGroupResult, type ArbLegResult } from './arb-legs.js';

export const ARB_UNKNOWN_VENUE_SIGNALS = ['outage', 'timeout', 'missing_fill_report', 'degraded'] as const;
export type ArbUnknownVenueSignalKind = (typeof ARB_UNKNOWN_VENUE_SIGNALS)[number];

export type ArbFillFact = {
  readonly fillId: string;
  readonly clientOrderId: string;
  readonly venueId: string;
  readonly amount: string;
};

export type ArbVenueSignal =
  | { readonly kind: 'fill_report'; readonly fillId: string; readonly clientOrderId: string; readonly amount: string }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unwired' }
  | { readonly kind: ArbUnknownVenueSignalKind };

export type ObserveArbLegInput = {
  readonly side: 'buy' | 'sell';
  readonly venueId: string;
  readonly signal: ArbVenueSignal;
};

export type ObserveArbLegResult = {
  readonly leg: ArbLegResult;
  readonly fill: ArbFillFact | null;
};

export type ArbFillConflict = {
  readonly fillId: string;
  readonly kept: ArbFillFact;
  readonly ignored: ArbFillFact;
};

export type RecoverArbFillsResult = {
  readonly journal: readonly ArbFillFact[];
  readonly newlyApplied: readonly ArbFillFact[];
  readonly duplicatesIgnored: readonly ArbFillFact[];
  readonly conflicts: readonly ArbFillConflict[];
};

export type RecordArbVenueLegsInput = {
  readonly expectedLegCount: number;
  readonly observations: readonly ObserveArbLegInput[];
  readonly journal?: readonly ArbFillFact[];
};

export type RecordArbVenueLegsResult = RecoverArbFillsResult & {
  readonly group: ArbLegGroupResult;
  readonly legs: readonly ArbLegResult[];
};

function unknownLeg(side: 'buy' | 'sell', venueId: string): ObserveArbLegResult {
  return { leg: { side, venueId, outcome: 'OUTCOME_UNKNOWN' }, fill: null };
}

function parseFill(venueId: string, fillId: string, clientOrderId: string, amount: string): ArbFillFact | null {
  const id = fillId.trim();
  const client = clientOrderId.trim();
  if (id.length === 0 || client.length === 0) return null;
  try {
    const parsed = parseAmount(amount);
    if (isZero(parsed) || isNegative(parsed)) return null;
    return { fillId: id, clientOrderId: client, venueId, amount: formatAmount(parsed) };
  } catch {
    return null;
  }
}

/**
 * Map a venue/adapter observation onto a leg. Outage, timeout, degraded, and a
 * fill_report missing identity/amount stay unknown with `fill: null` — never APPLIED.
 */
export function observeArbLeg(input: ObserveArbLegInput): ObserveArbLegResult {
  const { side, venueId, signal } = input;
  if (signal.kind === 'refused') {
    return { leg: { side, venueId, outcome: 'REFUSED' }, fill: null };
  }
  if (signal.kind === 'unwired') {
    return { leg: { side, venueId, outcome: 'UNWIRED' }, fill: null };
  }
  if (signal.kind === 'fill_report') {
    const fill = parseFill(venueId, signal.fillId, signal.clientOrderId, signal.amount);
    if (!fill) return unknownLeg(side, venueId);
    return { leg: { side, venueId, outcome: 'APPLIED' }, fill };
  }
  return unknownLeg(side, venueId);
}

/** Same fillId is one fill. A conflicting amount does not create a second fill. */
export function recoverArbFills(journal: readonly ArbFillFact[], incoming: readonly ArbFillFact[]): RecoverArbFillsResult {
  const byId = new Map<string, ArbFillFact>();
  for (const fact of journal) byId.set(fact.fillId, fact);

  const newlyApplied: ArbFillFact[] = [];
  const duplicatesIgnored: ArbFillFact[] = [];
  const conflicts: ArbFillConflict[] = [];

  for (const fact of incoming) {
    const kept = byId.get(fact.fillId);
    if (!kept) {
      byId.set(fact.fillId, fact);
      newlyApplied.push(fact);
      continue;
    }
    if (compare(parseAmount(kept.amount), parseAmount(fact.amount)) === 0) {
      duplicatesIgnored.push(fact);
      continue;
    }
    conflicts.push({ fillId: fact.fillId, kept, ignored: fact });
  }

  return { journal: [...byId.values()], newlyApplied, duplicatesIgnored, conflicts };
}

/**
 * Record venue observations into the arb group and fill journal.
 * A dead/degraded venue cannot become group success or an invented fill.
 * A non-empty amount conflict is not group success either. The first amount
 * stays on the journal and the conflict row stays; neither amount wins.
 */
export function recordArbVenueLegs(input: RecordArbVenueLegsInput): RecordArbVenueLegsResult {
  const observed = input.observations.map(observeArbLeg);
  const legs = observed.map((row) => row.leg);
  const incoming = observed.flatMap((row) => (row.fill ? [row.fill] : []));
  const recovered = recoverArbFills(input.journal ?? [], incoming);
  const grouped = reduceArbLegGroup({ expectedLegCount: input.expectedLegCount, legs });
  if (recovered.conflicts.length > 0 && grouped.ok) {
    return {
      group: {
        ok: false,
        atomic: ARB_LEGS_ATOMIC,
        outcome: 'OUTCOME_UNKNOWN',
        reason: 'amount_conflict',
        detail: 'same fillId disagrees on amount — kept journal amount stands; group success not invented',
        applied: grouped.applied,
        refused: grouped.refused,
        unknown: grouped.unknown,
      },
      legs,
      ...recovered,
    };
  }
  return {
    group: grouped,
    legs,
    ...recovered,
  };
}

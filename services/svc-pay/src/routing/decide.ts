/**
 * pay.routing — geo / method / risk smart rail selection (D26-P1-P3).
 *
 * SPEC-PAY-VERTICALS §5: optimise for success then cost, log why each rail was
 * chosen or skipped, never route on undisclosed rail-side incentives, skip a
 * rail that cannot honestly accept rather than try-and-fail, and refuse rather
 * than invent missing signals (DIRECTION §8 — no fabricated approval rates /
 * cost weights).
 *
 * This module is the product path that replaces preference-only
 * `selectPublicCheckoutRail` when smart dimensions are in play. It always
 * demands geo + method + risk. Blank dims → `pay.routing_input_missing`.
 * Rails without an explicit eligibility profile for a dim → skipped with a
 * named reason (never assumed worldwide / any-method / any-risk). A rail
 * without an operator-declared success fraction cannot win (never 100%,
 * never cheapest-success).
 *
 * Money does not move here. Callers that charge must still pass the chosen
 * rail through posture value-movement gates and ledger recipes.
 */

import { isUsable, type RailAdapter } from '../rails/rail-adapter.js';
import type { RailRegistry } from '../rails/registry.js';
import {
  assertRailMayAcceptPublicPayment,
  PUBLIC_CHECKOUT_CAPABILITIES,
  type RailSkipReason,
  type ValueMovementPolicy,
} from '../rails/posture.js';
import {
  APPROVAL_RATE_UNSET_SKIP,
  assertNoInventedRoutingScores,
  assertRoutingInputsPresent,
  readOperatorDeclaredSuccessRate,
  type RoutingInputs,
} from '../routing-inputs.js';

/** Why a candidate was skipped during smart routing (extends posture taxonomy). */
export type SmartRoutingSkipReason =
  | RailSkipReason
  | 'profile-missing'
  | 'method-mismatch'
  | 'method-unset'
  | 'geo-mismatch'
  | 'geo-unset'
  | 'risk-mismatch'
  | 'risk-unset'
  | 'approval-rate-unset'
  | 'outranked-success-rate'
  | 'tied-declared-rate-lost-preference-order'
  /** RC-merchant-08: the business's category takes payments on other rails only. */
  | 'category-restricted';

export interface SmartRailDecisionEntry {
  readonly railId: string;
  readonly outcome: 'chosen' | 'skipped';
  readonly reason?: SmartRoutingSkipReason;
}

/**
 * Operator-declared eligibility for one rail. Every smart dimension that the
 * engine requires must be declared here — omission means "we do not honestly
 * know", which is a skip, not a free pass.
 *
 * `'*'` in countries / riskBands is an explicit operator declaration of
 * worldwide / any-band coverage — never inferred.
 */
export interface RailRoutingProfile {
  readonly railId: string;
  /** Methods this rail accepts (e.g. `card`, `crypto`). Empty/omit → method-unset. */
  readonly methods?: readonly string[];
  /** ISO-3166-1 alpha-2 countries, or `'*'` for explicit worldwide. */
  readonly countries?: readonly string[];
  /** Opaque risk-band labels the rail may accept, or `'*'` for any configured band. */
  readonly riskBands?: readonly string[];
  /**
   * Operator-declared success fraction as a decimal string in (0, 1].
   * Omitted / blank / zero / guessed → skip `approval-rate-unset`.
   * Never inferred; DIRECTION §8 rates are not invented here.
   */
  readonly successRate?: string;
}

export interface SmartRoutingRequest {
  readonly inputs: RoutingInputs;
  /** Ordered candidate rail ids (operator preference — never a payer-named rail). */
  readonly preference: readonly string[];
  /** Eligibility profiles keyed by rail id (at most one profile per railId). */
  readonly profiles: readonly RailRoutingProfile[];
  readonly rails: RailRegistry;
  readonly policy: ValueMovementPolicy;
  readonly now?: Date;
  /**
   * RC-merchant-08: when set, only these rails may be chosen (a permissionless or restricted business category).
   * Every other candidate is skipped `category-restricted`. Omitted: no category limit.
   */
  readonly onlyRails?: readonly string[];
}

/** Present, trimmed inputs after the refuse-missing gate. */
export interface PresentRoutingInputs {
  readonly geoCountry: string;
  readonly method: string;
  readonly riskBand: string;
}

export interface SmartRoutingDecision {
  readonly adapter: RailAdapter;
  readonly chosenRailId: string;
  readonly considered: readonly SmartRailDecisionEntry[];
  readonly inputs: PresentRoutingInputs;
}

export type SmartRoutingErrorCode = 'pay.routing_no_rail' | 'pay.routing_input_missing' | 'pay.routing_approval_rate_unset';

/**
 * No candidate accepted after geo/method/risk + posture filters.
 * Distinct from input-missing — inputs were present; rails could not serve them.
 */
export class SmartRoutingNoRailError extends Error {
  readonly code: SmartRoutingErrorCode = 'pay.routing_no_rail';

  constructor(
    message: string,
    readonly considered: readonly SmartRailDecisionEntry[],
    readonly inputs: PresentRoutingInputs,
  ) {
    super(message);
    this.name = 'SmartRoutingNoRailError';
  }
}

/**
 * Matching rails existed, but none carried an honest operator-declared
 * success fraction — refuse rather than treat blank as 100% or cheapest-success.
 */
export class SmartRoutingApprovalRateUnsetError extends Error {
  readonly code: SmartRoutingErrorCode = 'pay.routing_approval_rate_unset';

  constructor(
    message: string,
    readonly considered: readonly SmartRailDecisionEntry[],
    readonly inputs: PresentRoutingInputs,
  ) {
    super(message);
    this.name = 'SmartRoutingApprovalRateUnsetError';
  }
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function normCountry(value: string): string {
  return value.trim().toUpperCase();
}

function profileMap(profiles: readonly RailRoutingProfile[]): Map<string, RailRoutingProfile> {
  const map = new Map<string, RailRoutingProfile>();
  for (const p of profiles) {
    map.set(p.railId, p);
  }
  return map;
}

function methodMatches(profile: RailRoutingProfile, method: string): SmartRoutingSkipReason | null {
  if (!profile.methods || profile.methods.length === 0) return 'method-unset';
  const want = norm(method);
  if (profile.methods.some((m) => norm(m) === want)) return null;
  return 'method-mismatch';
}

function geoMatches(profile: RailRoutingProfile, geoCountry: string): SmartRoutingSkipReason | null {
  if (!profile.countries || profile.countries.length === 0) return 'geo-unset';
  if (profile.countries.some((c) => c.trim() === '*')) return null;
  const want = normCountry(geoCountry);
  if (profile.countries.some((c) => normCountry(c) === want)) return null;
  return 'geo-mismatch';
}

function riskMatches(profile: RailRoutingProfile, riskBand: string): SmartRoutingSkipReason | null {
  if (!profile.riskBands || profile.riskBands.length === 0) return 'risk-unset';
  if (profile.riskBands.some((b) => b.trim() === '*')) return null;
  const want = norm(riskBand);
  if (profile.riskBands.some((b) => norm(b) === want)) return null;
  return 'risk-mismatch';
}

/**
 * Append-only decision record shape for `payment_events` (or operator logs).
 * Forbidden inventable score fields are stripped by assert before return.
 */
export function toRoutingDecisionRecord(decision: SmartRoutingDecision): Record<string, unknown> {
  const record: Record<string, unknown> = {
    kind: 'pay.routing.decision',
    chosenRailId: decision.chosenRailId,
    geoCountry: decision.inputs.geoCountry,
    method: decision.inputs.method,
    riskBand: decision.inputs.riskBand,
    considered: decision.considered.map((e) =>
      e.outcome === 'chosen' ? { railId: e.railId, outcome: e.outcome } : { railId: e.railId, outcome: e.outcome, reason: e.reason },
    ),
  };
  assertNoInventedRoutingScores(record);
  return record;
}

type EligibleSlot = {
  readonly tag: 'ok';
  readonly railId: string;
  readonly adapter: RailAdapter;
  readonly scaled: bigint;
};

type SkipSlot = { readonly tag: 'skip'; readonly entry: SmartRailDecisionEntry };

/**
 * Smart checkout rail selection — geo + method + risk required, then
 * operator-declared success fraction. Blank/zero/guessed rates cannot win.
 *
 * Walks the preference list. For each entry: profile eligibility → posture
 * → declared success-rate. Eligible slots rank by the scaled fraction from
 * `readOperatorDeclaredSuccessRate`. A strictly higher scaled rate replaces
 * the winner. An equal scaled rate keeps the earlier preference entry. Any
 * other eligible slot at that same scaled rate is a preference tie, not a
 * higher success rate. Chosen is that winning slot object, once.
 * Full considered log always returned.
 */
export function selectSmartCheckoutRail(request: SmartRoutingRequest): SmartRoutingDecision {
  // Smart routing always requires all three dims — never preference-only invent.
  assertRoutingInputsPresent({ required: ['geo', 'method', 'risk'] }, request.inputs);

  const present: PresentRoutingInputs = {
    geoCountry: request.inputs.geoCountry!.trim(),
    method: request.inputs.method!.trim(),
    riskBand: request.inputs.riskBand!.trim(),
  };

  const profiles = profileMap(request.profiles);
  const now = request.now ?? new Date();
  const slots: Array<EligibleSlot | SkipSlot> = [];

  for (const railId of request.preference) {
    if (request.onlyRails && !request.onlyRails.includes(railId)) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: 'category-restricted' } });
      continue;
    }
    const profile = profiles.get(railId);
    if (!profile) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: 'profile-missing' } });
      continue;
    }

    const methodSkip = methodMatches(profile, present.method);
    if (methodSkip) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: methodSkip } });
      continue;
    }
    const geoSkip = geoMatches(profile, present.geoCountry);
    if (geoSkip) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: geoSkip } });
      continue;
    }
    const riskSkip = riskMatches(profile, present.riskBand);
    if (riskSkip) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: riskSkip } });
      continue;
    }

    // Posture walk — same honesty as selectPublicCheckoutRailDetailed.
    if (!request.rails.has(railId)) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: 'not-registered' } });
      continue;
    }
    const adapter = request.rails.get(railId);
    if (!PUBLIC_CHECKOUT_CAPABILITIES.every((c) => adapter.capabilities.includes(c))) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: 'missing-capability' } });
      continue;
    }
    if (adapter.mode === 'absent') {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: 'absent' } });
      continue;
    }
    if (!isUsable(adapter, now)) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: 'unhealthy' } });
      continue;
    }
    try {
      assertRailMayAcceptPublicPayment(adapter, request.policy);
    } catch {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: 'sandbox' } });
      continue;
    }

    const parsed = readOperatorDeclaredSuccessRate(profile.successRate);
    if (!parsed.ok) {
      slots.push({ tag: 'skip', entry: { railId, outcome: 'skipped', reason: parsed.skip } });
      continue;
    }
    slots.push({ tag: 'ok', railId, adapter, scaled: parsed.scaled });
  }

  const eligible = slots.filter((s): s is EligibleSlot => s.tag === 'ok');
  const skipped = slots.filter((s): s is SkipSlot => s.tag === 'skip').map((s) => s.entry);

  if (eligible.length === 0) {
    if (skipped.some((e) => e.reason === APPROVAL_RATE_UNSET_SKIP)) {
      throw new SmartRoutingApprovalRateUnsetError(
        'Smart routing will not choose a rail with an unset, zero, or guessed success-rate — refuse rather than invent',
        skipped,
        present,
      );
    }
    throw new SmartRoutingNoRailError(
      'Smart routing found no rail that honestly accepts this geo/method/risk — refuse rather than invent a fallback',
      skipped,
      present,
    );
  }

  let winner = eligible[0]!;
  for (const row of eligible.slice(1)) {
    if (row.scaled > winner.scaled) winner = row;
  }

  const considered: SmartRailDecisionEntry[] = slots.map((slot) => {
    if (slot.tag === 'skip') return slot.entry;
    if (slot === winner) return { railId: slot.railId, outcome: 'chosen' };
    if (slot.scaled === winner.scaled) {
      return { railId: slot.railId, outcome: 'skipped', reason: 'tied-declared-rate-lost-preference-order' };
    }
    return { railId: slot.railId, outcome: 'skipped', reason: 'outranked-success-rate' };
  });

  const decision: SmartRoutingDecision = {
    adapter: winner.adapter,
    chosenRailId: winner.railId,
    considered,
    inputs: present,
  };
  assertNoInventedRoutingScores(toRoutingDecisionRecord(decision));
  return decision;
}

/**
 * Reference profiles for the v1 adapters and the TEST bank. Operators pass these (or a
 * tightened subset) into `selectSmartCheckoutRail` — they are never applied
 * silently when the caller omitted profiles.
 *
 * - crypto-native: crypto method; explicit worldwide geo (`*`); low/external bands.
 * - card-sandbox: card method; explicit worldwide; low/medium only (sandbox refuse on live-only still applies).
 * - bank-transfer-sandbox: pushed bank transfer (J-merchant-04 step 6); explicit worldwide; low/medium only; sandbox, so
 *   refused wherever only live rails may take a public payment.
 */
export const REFERENCE_RAIL_ROUTING_PROFILES: readonly RailRoutingProfile[] = [
  {
    railId: 'crypto-native',
    methods: ['crypto'],
    countries: ['*'],
    riskBands: ['low', 'external:ok'],
  },
  {
    railId: 'card-sandbox',
    methods: ['card'],
    countries: ['*'],
    riskBands: ['low', 'medium'],
  },
  {
    railId: 'bank-transfer-sandbox',
    methods: ['bank_transfer'],
    countries: ['*'],
    riskBands: ['low', 'medium'],
  },
];

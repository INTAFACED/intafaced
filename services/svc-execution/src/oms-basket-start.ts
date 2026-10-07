/**
 * Start one already-approved live basket / rebalance parent.
 * Named legs carry ledger qty strings. Blank/missing leg qty refuses.
 * Partial-failure policy must be explicit — never invent remaining flatten.
 * Jobs off refuses. Credit and residual leftover are ledger amounts.
 * Not paper. Mill start does not place children — HTTP hitch posts matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type BasketParentKind = 'basket' | 'rebalance';
export type BasketPartialFailurePolicy = 'refuse_all';

export type OmsBasketStartRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'not_approved'
  | 'already_started'
  | 'missing_kind'
  | 'missing_legs'
  | 'missing_leg_name'
  | 'duplicate_leg_name'
  | 'missing_qty'
  | 'qty_invalid'
  | 'missing_partial_failure_policy'
  | 'flatten_remaining_refused'
  | 'credit_blank'
  | 'credit_invalid'
  | 'missing_residual'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'missing_operator'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsBasketStartRefusal = {
  readonly ok: false;
  readonly reason: OmsBasketStartRefuseReason;
  readonly detail: string;
};

export type OmsBasketNamedLeg = {
  readonly name: string;
  readonly qty: string;
};

export type OmsBasketStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly parentClientOrderId: string;
  readonly kind: BasketParentKind;
  readonly status: 'running';
  readonly legs: readonly OmsBasketNamedLeg[];
  readonly partialFailurePolicy: BasketPartialFailurePolicy;
  readonly credit: string;
  readonly residual: { readonly remaining: string };
  readonly startedAt: string;
};

export type OmsBasketStartResult = OmsBasketStartOk | OmsBasketStartRefusal;

export type OmsBasketLegInput = {
  readonly name?: string | null;
  readonly qty?: string | null;
};

function refuse(reason: OmsBasketStartRefuseReason, detail: string): OmsBasketStartRefusal {
  return { ok: false, reason, detail };
}

function isBasketKind(kind: string | undefined): kind is BasketParentKind {
  return kind === 'basket' || kind === 'rebalance';
}

function parseCredit(raw: string | null | undefined): { ok: true; text: string } | OmsBasketStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('credit_blank', 'pre-trade credit is blank — refuse rather than invent a limit');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('credit_blank', 'pre-trade credit is blank — refuse rather than invent a limit');
  }
  try {
    const value = parseAmount(text);
    if (value < 0n) {
      return refuse('credit_invalid', 'pre-trade credit must be a non-negative ledger amount — not invented');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('credit_invalid', 'pre-trade credit is not a ledger amount — refusing to invent a limit');
  }
}

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsBasketStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover flatten from partial failure');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover flatten from partial failure');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

function parseLegQty(raw: string | null | undefined, name: string): { ok: true; text: string } | OmsBasketStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_qty', `leg ${name} qty is blank — refuse rather than invent size`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_qty', `leg ${name} qty is blank — refuse rather than invent size`);
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('qty_invalid', `leg ${name} qty must be a positive ledger amount — not invented`);
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('qty_invalid', `leg ${name} qty is not a ledger amount — refusing to invent size`);
  }
}

function parseNamedLegs(
  raw: readonly OmsBasketLegInput[] | null | undefined,
): { ok: true; legs: OmsBasketNamedLeg[] } | OmsBasketStartRefusal {
  if (raw === null || raw === undefined || raw.length === 0) {
    return refuse('missing_legs', 'basket/rebalance parent requires named legs — refuse rather than invent a book');
  }
  const seen = new Set<string>();
  const legs: OmsBasketNamedLeg[] = [];
  for (const [index, leg] of raw.entries()) {
    const name = leg.name?.trim() ?? '';
    if (!name) {
      return refuse('missing_leg_name', `leg ${index} is unnamed — refuse rather than silently weaken the parent`);
    }
    if (seen.has(name)) {
      return refuse('duplicate_leg_name', `leg ${name} is duplicated — refuse rather than silently merge qty`);
    }
    seen.add(name);
    const qty = parseLegQty(leg.qty, name);
    if (!qty.ok) return qty;
    legs.push({ name, qty: qty.text });
  }
  return { ok: true, legs };
}

function parsePartialFailurePolicy(
  raw: string | null | undefined,
): { ok: true; policy: BasketPartialFailurePolicy } | OmsBasketStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_partial_failure_policy', 'partial-failure policy is missing — refuse rather than invent remaining flatten');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_partial_failure_policy', 'partial-failure policy is missing — refuse rather than invent remaining flatten');
  }
  if (text === 'flatten_remaining' || text === 'flatten' || text === 'continue') {
    return refuse('flatten_remaining_refused', 'partial-failure flatten is not a policy — refusing to invent remaining flatten');
  }
  if (text !== 'refuse_all') {
    return refuse(
      'flatten_remaining_refused',
      `partial-failure policy ${text} is unsupported — only refuse_all is explicit; never invent remaining flatten`,
    );
  }
  return { ok: true, policy: 'refuse_all' };
}

/**
 * Start an already-approved live basket/rebalance parent.
 * Jobs off refuses. Blank leg qty refuses. Flatten-remaining refuses.
 * Not paper. Mill start does not submit; HTTP hitch posts matching children.
 */
export function startBasketParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved live parent. */
  approved?: boolean;
  /** Live-approved status is 'approved'. Status paper refuses even when approved is true. Running refuses already_started. */
  status?: 'approved' | 'running' | 'paper' | string;
  legs?: readonly OmsBasketLegInput[] | null;
  /** Explicit policy. Only `refuse_all` is accepted — never invent flatten. */
  partialFailurePolicy?: string | null;
  credit?: string | null;
  remaining?: string | null;
  operatorId?: string;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
  now?: Date;
}): OmsBasketStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.jobs) {
    return refuse('jobs_gate_unwired', 'algo jobs gate is required for start');
  }
  if (input.jobs.enabled === false) {
    return refuse('jobs_off', 'EXECUTION_ALGO_JOBS_ENABLED is off — refusing to invent a live start');
  }
  const kindRaw = input.kind?.trim() ?? '';
  if (!kindRaw) {
    return refuse('missing_kind', 'kind basket or rebalance is required — refusing to invent a parent type');
  }
  if (!isBasketKind(kindRaw)) {
    return refuse('not_live', `kind ${kindRaw} is not basket or rebalance`);
  }
  if (input.status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running`);
  }
  if (input.status === 'paper' || (input.approved !== true && input.status !== 'approved')) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not approved`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const legs = parseNamedLegs(input.legs);
  if (!legs.ok) return legs;
  const policy = parsePartialFailurePolicy(input.partialFailurePolicy);
  if (!policy.ok) return policy;
  const credit = parseCredit(input.credit);
  if (!credit.ok) return credit;
  const leftover = parseRetainedRemaining(input.remaining);
  if (!leftover.ok) return leftover;
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  const startedAt = (input.now ?? new Date()).toISOString();
  return {
    ok: true,
    started: true,
    parentClientOrderId,
    kind: kindRaw,
    status: 'running',
    legs: legs.legs,
    partialFailurePolicy: policy.policy,
    credit: credit.text,
    residual: { remaining: leftover.text },
    startedAt,
  };
}

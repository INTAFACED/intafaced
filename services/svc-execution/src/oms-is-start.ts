/**
 * Start one already-approved implementation-shortfall parent.
 * Jobs off refuses. Arrival price is the retained schedule — blank refuses,
 * never invent slices. Does not place children and does not touch matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsIsStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_schedule'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'missing_operator'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsIsStartRefusal = {
  readonly ok: false;
  readonly reason: OmsIsStartRefuseReason;
  readonly detail: string;
};

export type OmsIsStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly parentClientOrderId: string;
  readonly kind: 'implementation_shortfall';
  readonly status: 'running';
  readonly arrivalPrice: string;
  readonly startedAt: string;
};

export type OmsIsStartResult = OmsIsStartOk | OmsIsStartRefusal;

function refuse(reason: OmsIsStartRefuseReason, detail: string): OmsIsStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedArrival(raw: string | null | undefined): { ok: true; text: string } | OmsIsStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_schedule', 'arrival price is missing — refusing to invent an IS schedule');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_schedule', 'arrival price is missing — refusing to invent an IS schedule');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('missing_schedule', 'arrival price is not a ledger amount — refusing to invent an IS schedule');
    }
    return { ok: true, text };
  } catch {
    return refuse('missing_schedule', 'arrival price is not a ledger amount — refusing to invent an IS schedule');
  }
}

/**
 * Start an already-approved implementation-shortfall parent.
 * Jobs off refuses. Does not invent slices or a book arrival.
 */
export function startImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  /** Must be true — start needs an already-approved IS parent. */
  approved?: boolean;
  /** Running, including padded or differently cased running, refuses already_started. A finished status refuses not_approved. */
  status?: 'approved' | 'running' | string;
  /** Retained arrival from approve. Blank refuses — never invent a schedule. */
  arrivalPrice?: string | null;
  operatorId?: string;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
  now?: Date;
}): OmsIsStartResult {
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
  if (typeof input.status === 'string' && input.status.trim().toLowerCase() === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running`);
  }
  if (input.approved === true) {
    if (input.status !== undefined && input.status !== 'approved') {
      return refuse('not_approved', `parent ${parentClientOrderId} is not approved`);
    }
  } else if (input.status !== 'approved') {
    return refuse('not_approved', `parent ${parentClientOrderId} is not approved`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const arrival = parseRetainedArrival(input.arrivalPrice);
  if (!arrival.ok) return arrival;
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  const startedAt = (input.now ?? new Date()).toISOString();
  return {
    ok: true,
    started: true,
    parentClientOrderId,
    kind: 'implementation_shortfall',
    status: 'running',
    arrivalPrice: arrival.text,
    startedAt,
  };
}

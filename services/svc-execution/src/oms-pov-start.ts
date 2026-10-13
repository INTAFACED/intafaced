/**
 * Start one already-approved live POV parent.
 * Jobs off refuses. Credit and residual leftover are ledger amounts.
 * Missing/blank credit refuses. Residual leftover is never invented from
 * participation. Max participation is the retained rate from live approve.
 * Not paper. Does not place children and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsPovStartRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'not_approved'
  | 'already_started'
  | 'missing_max_participation'
  | 'credit_blank'
  | 'credit_invalid'
  | 'missing_residual'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'missing_operator'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsPovStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPovStartRefuseReason;
  readonly detail: string;
};

export type OmsPovStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly parentClientOrderId: string;
  readonly kind: 'pov';
  readonly status: 'running';
  readonly maxParticipationBps: number;
  readonly credit: string;
  readonly residual: { readonly remaining: string };
  readonly startedAt: string;
};

export type OmsPovStartResult = OmsPovStartOk | OmsPovStartRefusal;

function refuse(reason: OmsPovStartRefuseReason, detail: string): OmsPovStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedMaxParticipation(raw: number | null | undefined): { ok: true; value: number } | OmsPovStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_max_participation', 'POV max participation is missing — refusing to invent a rate');
  }
  if (!Number.isInteger(raw) || raw < 0) {
    return refuse('missing_max_participation', 'POV max participation must be a non-negative integer bps — refusing to invent a rate');
  }
  return { ok: true, value: raw };
}

function parseCredit(raw: string | null | undefined): { ok: true; text: string } | OmsPovStartRefusal {
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

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsPovStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from participation or credit');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from participation or credit');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

/**
 * Start an already-approved live POV parent.
 * Jobs off refuses. Blank credit refuses. Residual leftover is already retained.
 * Not paper.
 */
export function startPovParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true. A true flag still needs omitted or approved status. */
  approved?: boolean;
  /** Trimmed. Omitted stays omitted. running is already_started. Only omitted or approved can start. */
  status?: 'approved' | 'running' | 'paper' | string;
  /** Retained max participation from live approve. Blank refuses — never invent a rate. */
  maxParticipationBps?: number | null;
  credit?: string | null;
  remaining?: string | null;
  operatorId?: string;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
  now?: Date;
}): OmsPovStartResult {
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
  if (input.kind !== undefined && input.kind !== 'pov') {
    return refuse('not_live', `kind ${String(input.kind)} is not pov`);
  }
  const status = input.status === undefined ? undefined : input.status.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running`);
  }
  if (input.approved !== true || (status !== undefined && status !== 'approved')) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not approved`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const rate = parseRetainedMaxParticipation(input.maxParticipationBps);
  if (!rate.ok) return rate;
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
    kind: 'pov',
    status: 'running',
    maxParticipationBps: rate.value,
    credit: credit.text,
    residual: { remaining: leftover.text },
    startedAt,
  };
}

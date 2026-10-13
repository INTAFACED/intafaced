/**
 * Start one already-approved live VWAP parent.
 * Jobs off refuses. Credit and residual leftover are ledger amounts.
 * Missing/blank credit refuses. Residual leftover is never invented from duration.
 * Not paper. Does not place children and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsVwapStartRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'not_approved'
  | 'already_started'
  | 'missing_schedule'
  | 'credit_blank'
  | 'credit_invalid'
  | 'missing_residual'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'missing_operator'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsVwapStartRefusal = {
  readonly ok: false;
  readonly reason: OmsVwapStartRefuseReason;
  readonly detail: string;
};

export type OmsVwapStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly parentClientOrderId: string;
  readonly kind: 'vwap';
  readonly status: 'running';
  readonly durationMs: number;
  readonly credit: string;
  readonly residual: { readonly remaining: string };
  readonly startedAt: string;
};

export type OmsVwapStartResult = OmsVwapStartOk | OmsVwapStartRefusal;

function refuse(reason: OmsVwapStartRefuseReason, detail: string): OmsVwapStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedDuration(raw: number | null | undefined): { ok: true; value: number } | OmsVwapStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_schedule', 'VWAP duration is missing — refusing to invent a schedule');
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    return refuse('missing_schedule', 'VWAP duration must be a positive integer ms — refusing to invent a schedule from slices');
  }
  return { ok: true, value: raw };
}

function parseCredit(raw: string | null | undefined): { ok: true; text: string } | OmsVwapStartRefusal {
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

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsVwapStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration or credit');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration or credit');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

/**
 * Start an already-approved live VWAP parent.
 * Jobs off refuses. Blank credit refuses. Residual leftover is already retained.
 * Not paper.
 */
export function startVwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved live VWAP parent. */
  approved?: boolean;
  /** Live-approved status is 'approved'. Running refuses already_started. */
  status?: 'approved' | 'running' | 'paper' | string;
  /** Retained duration from live approve. Blank refuses — never invent a schedule. */
  durationMs?: number | null;
  credit?: string | null;
  remaining?: string | null;
  operatorId?: string;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
  now?: Date;
}): OmsVwapStartResult {
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
  if (input.kind !== undefined && input.kind !== 'vwap') {
    return refuse('not_live', `kind ${String(input.kind)} is not vwap`);
  }
  if (input.status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running`);
  }
  if (input.approved !== true && input.status !== 'approved') {
    return refuse('not_approved', `parent ${parentClientOrderId} is not approved`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const duration = parseRetainedDuration(input.durationMs);
  if (!duration.ok) return duration;
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
    kind: 'vwap',
    status: 'running',
    durationMs: duration.value,
    credit: credit.text,
    residual: { remaining: leftover.text },
    startedAt,
  };
}

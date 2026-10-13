/**
 * Approve one live TWAP parent.
 * Duration is integer milliseconds. Credit and residual leftover are ledger
 * amounts. Missing/blank duration or credit refuses. Residual leftover is never
 * invented from duration. Not paper. Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsTwapApproveRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'duration_blank'
  | 'duration_invalid'
  | 'credit_blank'
  | 'credit_invalid'
  | 'missing_residual'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'missing_operator'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsTwapApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsTwapApproveRefuseReason;
  readonly detail: string;
};

export type OmsTwapApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'twap';
  };
  readonly status: 'approved';
  readonly durationMs: number;
  readonly credit: string;
  readonly residual: { readonly remaining: string };
};

export type OmsTwapApproveResult = OmsTwapApproveOk | OmsTwapApproveRefusal;

function refuse(reason: OmsTwapApproveRefuseReason, detail: string): OmsTwapApproveRefusal {
  return { ok: false, reason, detail };
}

function parseTwapDurationMs(raw: number | null | undefined): { ok: true; value: number } | OmsTwapApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('duration_blank', 'TWAP duration is blank — refuse rather than invent a schedule');
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    return refuse('duration_invalid', 'TWAP duration must be a positive integer ms — not invented from slices');
  }
  return { ok: true, value: raw };
}

function parseCredit(raw: string | null | undefined): { ok: true; text: string } | OmsTwapApproveRefusal {
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

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsTwapApproveRefusal {
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
 * Approve a live TWAP parent only when owner duration and credit are present.
 * Residual leftover is already retained — never invented from duration.
 * Jobs off refuses. Not paper.
 */
export function approveTwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  durationMs?: number | null;
  credit?: string | null;
  remaining?: string | null;
  operatorId?: string;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
}): OmsTwapApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.jobs) {
    return refuse('jobs_gate_unwired', 'algo jobs gate is required for approve');
  }
  if (input.jobs.enabled === false) {
    return refuse('jobs_off', 'EXECUTION_ALGO_JOBS_ENABLED is off — refusing to invent an approval');
  }
  if (input.kind !== undefined && input.kind !== 'twap') {
    return refuse('not_live', `kind ${String(input.kind)} is not twap`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const duration = parseTwapDurationMs(input.durationMs);
  if (!duration.ok) return duration;
  const credit = parseCredit(input.credit);
  if (!credit.ok) return credit;
  const leftover = parseRetainedRemaining(input.remaining);
  if (!leftover.ok) return leftover;
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  return {
    ok: true,
    approved: true,
    parent: { parentClientOrderId, kind: 'twap' },
    status: 'approved',
    durationMs: duration.value,
    credit: credit.text,
    residual: { remaining: leftover.text },
  };
}

/**
 * Approve one live POV parent.
 * Max participation is integer bps. Credit and residual leftover are ledger
 * amounts. Missing/blank participation or credit refuses. Residual leftover is
 * never invented from participation. Not paper. Does not start and does not
 * touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsPovApproveRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'participation_blank'
  | 'participation_invalid'
  | 'credit_blank'
  | 'credit_invalid'
  | 'missing_residual'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'missing_operator'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsPovApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPovApproveRefuseReason;
  readonly detail: string;
};

export type OmsPovApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'pov';
  };
  readonly status: 'approved';
  readonly maxParticipationBps: number;
  readonly credit: string;
  readonly residual: { readonly remaining: string };
};

export type OmsPovApproveResult = OmsPovApproveOk | OmsPovApproveRefusal;

function refuse(reason: OmsPovApproveRefuseReason, detail: string): OmsPovApproveRefusal {
  return { ok: false, reason, detail };
}

function parseMaxParticipationBps(raw: number | null | undefined): { ok: true; value: number } | OmsPovApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('participation_blank', 'POV participation is blank — refuse rather than invent a rate');
  }
  if (!Number.isInteger(raw) || raw < 0) {
    return refuse('participation_invalid', 'POV participation must be a non-negative integer bps — not invented');
  }
  return { ok: true, value: raw };
}

function parseCredit(raw: string | null | undefined): { ok: true; text: string } | OmsPovApproveRefusal {
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

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsPovApproveRefusal {
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
 * Approve a live POV parent only when owner participation and credit are present.
 * Residual leftover is already retained — never invented from participation.
 * Jobs off refuses. Not paper.
 */
export function approvePovParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  maxParticipationBps?: number | null;
  credit?: string | null;
  remaining?: string | null;
  operatorId?: string;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
}): OmsPovApproveResult {
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
  if (input.kind !== undefined && input.kind !== 'pov') {
    return refuse('not_live', `kind ${String(input.kind)} is not pov`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const rate = parseMaxParticipationBps(input.maxParticipationBps);
  if (!rate.ok) return rate;
  const credit = parseCredit(input.credit);
  if (!credit.ok) return credit;
  const leftover = parseRetainedRemaining(input.remaining);
  if (!leftover.ok) return leftover;
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  return {
    ok: true,
    approved: true,
    parent: { parentClientOrderId, kind: 'pov' },
    status: 'approved',
    maxParticipationBps: rate.value,
    credit: credit.text,
    residual: { remaining: leftover.text },
  };
}

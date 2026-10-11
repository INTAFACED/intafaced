/**
 * Expire one live POV parent when its window ends.
 * The caller supplies now. A missing clock or a now before expireAt refuses.
 * Jobs off refuses. Residual leftover is a ledger amount and stays on the parent.
 * This door never invents expireAt from participation, duration, or the wall clock,
 * never invents leftover from participation or duration, and does not touch matching.
 * Not paper.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsPovExpireRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'not_running'
  | 'already_expired'
  | 'already_stopped'
  | 'missing_expire_at'
  | 'missing_clock'
  | 'not_due'
  | 'missing_residual'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsPovExpireRefusal = {
  readonly ok: false;
  readonly reason: OmsPovExpireRefuseReason;
  readonly detail: string;
};

export type OmsPovExpireOk = {
  readonly ok: true;
  readonly expired: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'pov';
  };
  readonly status: 'expired';
  readonly expireAt: string;
  readonly residual: { readonly remaining: string };
};

export type OmsPovExpireResult = OmsPovExpireOk | OmsPovExpireRefusal;

function refuse(reason: OmsPovExpireRefuseReason, detail: string): OmsPovExpireRefusal {
  return { ok: false, reason, detail };
}

function retainedExpireAt(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return trimmed;
}

function injectedNow(now?: Date): Date | null {
  if (!(now instanceof Date)) return null;
  const ms = now.getTime();
  if (!Number.isFinite(ms)) return null;
  return now;
}

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsPovExpireRefusal {
  if (raw === null || raw === undefined) {
    return refuse(
      'missing_residual',
      'residual.remaining is missing — refusing to invent leftover from participation, duration, or the clock',
    );
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse(
      'missing_residual',
      'residual.remaining is missing — refusing to invent leftover from participation, duration, or the clock',
    );
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

/**
 * Expire a running live POV parent using expireAt already retained on the schedule.
 * The caller supplies now. A missing clock or a now before expireAt refuses.
 * Residual is not released or consumed. Jobs off refuses. Not paper.
 */
export function expirePovParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Retained schedule expireAt. Blank refuses — never invent from participation, duration, or the clock. */
  expireAt?: string | null;
  remaining?: string | null;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
  now?: Date;
}): OmsPovExpireResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.jobs) {
    return refuse('jobs_gate_unwired', 'algo jobs gate is required for expire');
  }
  if (input.jobs.enabled === false) {
    return refuse('jobs_off', 'EXECUTION_ALGO_JOBS_ENABLED is off — refusing to invent a live expire');
  }
  if (input.kind !== undefined && input.kind !== 'pov') {
    return refuse('not_live', `kind ${String(input.kind)} is not pov`);
  }
  const status = input.status?.trim() ?? '';
  if (status === 'expired') {
    return refuse('already_expired', `parent ${parentClientOrderId} is already expired`);
  }
  if (status === 'stopped') {
    return refuse('already_stopped', `parent ${parentClientOrderId} is already stopped`);
  }
  if (status !== 'running') {
    return refuse('not_running', `parent ${parentClientOrderId} is not running`);
  }
  const expireAt = retainedExpireAt(input.expireAt);
  if (!expireAt) {
    return refuse('missing_expire_at', 'expireAt is missing — refusing to invent a schedule from participation, duration, or the clock');
  }
  const now = injectedNow(input.now);
  if (!now) {
    return refuse('missing_clock', 'now is required — refusing to invent a wall clock');
  }
  if (now.getTime() < Date.parse(expireAt)) {
    return refuse('not_due', `parent ${parentClientOrderId} expires at ${expireAt} — injected clock is not past the deadline`);
  }
  const leftover = parseRetainedRemaining(input.remaining);
  if (!leftover.ok) return leftover;
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  return {
    ok: true,
    expired: true,
    parent: { parentClientOrderId, kind: 'pov' },
    status: 'expired',
    expireAt,
    residual: { remaining: leftover.text },
  };
}

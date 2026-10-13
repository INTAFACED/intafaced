/**
 * Stop one running live TWAP parent.
 * Jobs off refuses. Children take no new. Residual leftover is a ledger amount
 * and stays on the parent — never invented from duration. Not paper. This door
 * never invents a canceled order and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsTwapStopRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'not_running'
  | 'already_stopped'
  | 'missing_residual'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsTwapStopRefusal = {
  readonly ok: false;
  readonly reason: OmsTwapStopRefuseReason;
  readonly detail: string;
};

export type OmsTwapStopOk = {
  readonly ok: true;
  readonly stopped: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'twap';
  };
  readonly childrenTakeNew: false;
  readonly residual: { readonly remaining: string };
};

export type OmsTwapStopResult = OmsTwapStopOk | OmsTwapStopRefusal;

function refuse(reason: OmsTwapStopRefuseReason, detail: string): OmsTwapStopRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsTwapStopRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

/**
 * Stop a running live TWAP parent. Existing children stay as recorded.
 * Residual is not released or consumed. Jobs off refuses. Not paper.
 */
export function stopTwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  remaining?: string | null;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
}): OmsTwapStopResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.jobs) {
    return refuse('jobs_gate_unwired', 'algo jobs gate is required for stop');
  }
  if (input.jobs.enabled === false) {
    return refuse('jobs_off', 'EXECUTION_ALGO_JOBS_ENABLED is off — refusing to invent a live stop');
  }
  if (input.kind !== undefined && input.kind !== 'twap') {
    return refuse('not_live', `kind ${String(input.kind)} is not twap`);
  }
  const status = input.status?.trim() ?? '';
  if (status === 'stopped') {
    return refuse('already_stopped', `parent ${parentClientOrderId} is already stopped`);
  }
  if (status !== 'running') {
    return refuse('not_running', `parent ${parentClientOrderId} is not running`);
  }
  const leftover = parseRetainedRemaining(input.remaining);
  if (!leftover.ok) return leftover;
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  return {
    ok: true,
    stopped: true,
    parent: { parentClientOrderId, kind: 'twap' },
    childrenTakeNew: false,
    residual: { remaining: leftover.text },
  };
}

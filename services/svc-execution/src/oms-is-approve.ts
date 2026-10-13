/**
 * Approve one implementation-shortfall parent.
 * Arrival price is required. Missing/blank/invalid refuses — this never
 * invents a price from a book or a mid. Does not plan slices, does not
 * start, and does not touch matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsIsApproveRefuseReason =
  | 'missing_parent'
  | 'arrival_price_blank'
  | 'arrival_price_invalid'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'missing_operator'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsIsApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsIsApproveRefuseReason;
  readonly detail: string;
};

export type OmsIsApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly status: 'approved';
  readonly arrivalPrice: string;
};

export type OmsIsApproveResult = OmsIsApproveOk | OmsIsApproveRefusal;

function refuse(reason: OmsIsApproveRefuseReason, detail: string): OmsIsApproveRefusal {
  return { ok: false, reason, detail };
}

function parseArrivalPrice(raw: string | null | undefined): { ok: true; text: string } | OmsIsApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('arrival_price_blank', 'arrival price is blank — refuse rather than invent a price from a book');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('arrival_price_blank', 'arrival price is blank — refuse rather than invent a price from a book');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('arrival_price_invalid', 'arrival price must be a positive ledger amount — not invented');
    }
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('arrival_price_invalid', `arrival price is not a ledger amount: ${message}`);
  }
}

/**
 * Approve an implementation-shortfall parent when arrival price is present.
 * Blank arrival refuses before approve — no parent is invented live.
 */
export function approveImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  arrivalPrice?: string | null;
  operatorId?: string;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
}): OmsIsApproveResult {
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
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const arrival = parseArrivalPrice(input.arrivalPrice);
  if (!arrival.ok) return arrival;
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  return {
    ok: true,
    approved: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    status: 'approved',
    arrivalPrice: arrival.text,
  };
}

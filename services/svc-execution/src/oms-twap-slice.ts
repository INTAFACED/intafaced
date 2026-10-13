/**
 * Slice one child of a live TWAP parent.
 * Qty, credit, and residual leftover are ledger amounts. Missing/blank qty
 * refuses — never invent size from duration. Missing/blank credit refuses.
 * Residual leftover is never invented from duration or credit. Not paper.
 * Does not submit to matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate } from './oms-start.js';

export type OmsTwapSliceRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'not_running'
  | 'missing_qty'
  | 'qty_invalid'
  | 'credit_blank'
  | 'credit_invalid'
  | 'missing_residual'
  | 'jobs_gate_unwired'
  | 'jobs_off'
  | 'venue_halted'
  | 'venue_halt_unavailable';

export type OmsTwapSliceRefusal = {
  readonly ok: false;
  readonly reason: OmsTwapSliceRefuseReason;
  readonly detail: string;
};

export type OmsTwapSliceOk = {
  readonly ok: true;
  readonly sliced: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'twap';
  };
  readonly amount: string;
  readonly credit: string;
  readonly residual: { readonly remaining: string };
};

export type OmsTwapSliceResult = OmsTwapSliceOk | OmsTwapSliceRefusal;

function refuse(reason: OmsTwapSliceRefuseReason, detail: string): OmsTwapSliceRefusal {
  return { ok: false, reason, detail };
}

function parseQty(raw: string | null | undefined): { ok: true; text: string } | OmsTwapSliceRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_qty', 'slice qty is blank — refuse rather than invent size from duration');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_qty', 'slice qty is blank — refuse rather than invent size from duration');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('qty_invalid', 'slice qty must be a positive ledger amount — not invented from duration');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('qty_invalid', 'slice qty is not a ledger amount — refusing to invent size');
  }
}

function parseCredit(raw: string | null | undefined): { ok: true; text: string } | OmsTwapSliceRefusal {
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

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsTwapSliceRefusal {
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
 * Slice one child of a live TWAP parent using caller qty.
 * Duration is ignored for size — never a substitute leftover.
 * Jobs off refuses. Blank credit refuses. Not paper.
 */
export function sliceTwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  amount?: string | null;
  /** Retained duration. Must not be used as qty. */
  durationMs?: number | null;
  credit?: string | null;
  remaining?: string | null;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
}): OmsTwapSliceResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.jobs) {
    return refuse('jobs_gate_unwired', 'algo jobs gate is required for slice');
  }
  if (input.jobs.enabled === false) {
    return refuse('jobs_off', 'EXECUTION_ALGO_JOBS_ENABLED is off — refusing to invent a live child');
  }
  if (input.kind !== undefined && input.kind !== 'twap') {
    return refuse('not_live', `kind ${String(input.kind)} is not twap`);
  }
  if (input.status !== 'running') {
    return refuse('not_running', `parent ${parentClientOrderId} is ${input.status ?? 'not running'} — slice needs a running TWAP parent`);
  }
  const qty = parseQty(input.amount);
  if (!qty.ok) return qty;
  const credit = parseCredit(input.credit);
  if (!credit.ok) return credit;
  const leftover = parseRetainedRemaining(input.remaining);
  if (!leftover.ok) return leftover;
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  return {
    ok: true,
    sliced: true,
    parent: { parentClientOrderId, kind: 'twap' },
    amount: qty.text,
    credit: credit.text,
    residual: { remaining: leftover.text },
  };
}

/**
 * Start one already-approved paper implementation-shortfall parent.
 * Paper off refuses. Arrival price is the retained schedule — blank refuses.
 * Never invents a live venue or slices. Does not place children and does not
 * touch matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsIsPaperStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_schedule'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsIsPaperStartRefusal = {
  readonly ok: false;
  readonly reason: OmsIsPaperStartRefuseReason;
  readonly detail: string;
};

export type OmsIsPaperStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'implementation_shortfall';
  readonly status: 'paper';
  readonly arrivalPrice: string;
};

export type OmsIsPaperStartResult = OmsIsPaperStartOk | OmsIsPaperStartRefusal;

function refuse(reason: OmsIsPaperStartRefuseReason, detail: string): OmsIsPaperStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedArrival(
  raw: string | null | undefined,
): { ok: true; text: string } | OmsIsPaperStartRefusal {
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
 * Start an already-approved paper IS parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  /** Must be true — start needs an already-approved paper IS parent. */
  approved?: boolean;
  /** Omitted, paper, or approved may start. Running refuses already_started. Any other status refuses not_approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained arrival from paper approve. Blank refuses — never invent a schedule. */
  arrivalPrice?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsIsPaperStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  const statusOmitted = input.status === undefined;
  const paperOrApproved = input.status === 'paper' || input.status === 'approved';
  if (!statusOmitted && !paperOrApproved) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper parent`);
  }
  if (input.approved !== true && !paperOrApproved) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const arrival = parseRetainedArrival(input.arrivalPrice);
  if (!arrival.ok) return arrival;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'implementation_shortfall',
    status: 'paper',
    arrivalPrice: arrival.text,
  };
}

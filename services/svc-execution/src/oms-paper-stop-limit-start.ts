/**
 * Start one already-approved paper stop-limit parent.
 * Paper off refuses. Stop price and limit price are the retained leftovers from paper
 * approve — blank refuses. Never invents a trigger from parent qty or the other
 * price. Does not place children and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperStopLimitStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_stop'
  | 'missing_limit'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperStopLimitStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperStopLimitStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperStopLimitStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'stop-limit';
  readonly status: 'paper';
  readonly stopPrice: string;
  readonly limitPrice: string;
};

export type OmsPaperStopLimitStartResult = OmsPaperStopLimitStartOk | OmsPaperStopLimitStartRefusal;

function refuse(reason: OmsPaperStopLimitStartRefuseReason, detail: string): OmsPaperStopLimitStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedTrigger(
  raw: string | null | undefined,
  missing: 'missing_stop' | 'missing_limit',
  label: string,
): { ok: true; text: string } | OmsPaperStopLimitStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse(missing, `${label} is missing — refusing to invent a trigger or a live venue`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse(missing, `${label} is missing — refusing to invent a trigger or a live venue`);
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse(missing, `${label} is not a ledger amount — refusing to invent a trigger`);
  }
}

/**
 * Start an already-approved paper stop-limit parent.
 * Both prices go live from retained stop and limit. Paper off refuses.
 */
export function startPaperStopLimitParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper stop-limit parent. */
  approved?: boolean;
  /** Trimmed before compare. 'running' refuses already_started. A present blank or other non-startable status refuses not_approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained stop price from paper approve. Blank refuses — never invent a trigger. */
  stopPrice?: string | null;
  /** Retained limit price from paper approve. Blank refuses — never invent a trigger. */
  limitPrice?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperStopLimitStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper stop-limit start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'stop-limit') {
    return refuse('not_live', `kind ${String(input.kind)} is not stop-limit`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  // Trimmed '' is present. Only an omitted status is undefined and may follow approved.
  const startableStatus = status === 'paper' || status === 'approved';
  if (status !== undefined && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper stop-limit parent`);
  }
  if (input.approved !== true && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper stop-limit parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const stop = parseRetainedTrigger(input.stopPrice, 'missing_stop', 'stop-limit stop price');
  if (!stop.ok) return stop;
  const limit = parseRetainedTrigger(input.limitPrice, 'missing_limit', 'stop-limit limit price');
  if (!limit.ok) return limit;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'stop-limit',
    status: 'paper',
    stopPrice: stop.text,
    limitPrice: limit.text,
  };
}

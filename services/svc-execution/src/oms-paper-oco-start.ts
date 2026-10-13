/**
 * Start one already-approved paper OCO parent.
 * Paper off refuses. Both sibling triggers are the retained leftovers from paper
 * approve — blank refuses. Never invents a trigger from parent qty or the other
 * sibling. Does not place children and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperOcoStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_take_profit'
  | 'missing_stop_loss'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperOcoStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperOcoStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperOcoStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'oco';
  readonly status: 'paper';
  readonly takeProfit: string;
  readonly stopLoss: string;
};

export type OmsPaperOcoStartResult = OmsPaperOcoStartOk | OmsPaperOcoStartRefusal;

function refuse(reason: OmsPaperOcoStartRefuseReason, detail: string): OmsPaperOcoStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedTrigger(
  raw: string | null | undefined,
  missing: 'missing_take_profit' | 'missing_stop_loss',
  label: string,
): { ok: true; text: string } | OmsPaperOcoStartRefusal {
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
 * Start an already-approved paper OCO parent.
 * Both siblings go live from retained take-profit and stop-loss. Paper off refuses.
 */
export function startPaperOcoParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper OCO parent. */
  approved?: boolean;
  /** Paper-approved status is 'paper' or 'approved'. Trimmed 'running' refuses already_started. Stopped and expired refuse not_approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained take-profit from paper approve. Blank refuses — never invent a trigger. */
  takeProfit?: string | null;
  /** Retained stop-loss from paper approve. Blank refuses — never invent a trigger. */
  stopLoss?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperOcoStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper OCO start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'oco') {
    return refuse('not_live', `kind ${String(input.kind)} is not oco`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  if (status === 'stopped' || status === 'expired' || (input.approved !== true && status !== 'paper' && status !== 'approved')) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper OCO parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const takeProfit = parseRetainedTrigger(input.takeProfit, 'missing_take_profit', 'OCO take-profit');
  if (!takeProfit.ok) return takeProfit;
  const stopLoss = parseRetainedTrigger(input.stopLoss, 'missing_stop_loss', 'OCO stop-loss');
  if (!stopLoss.ok) return stopLoss;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'oco',
    status: 'paper',
    takeProfit: takeProfit.text,
    stopLoss: stopLoss.text,
  };
}

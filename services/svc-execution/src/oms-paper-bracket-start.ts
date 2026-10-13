/**
 * Start one already-approved paper bracket parent.
 * Paper off refuses. All three leg triggers are the retained leftovers from paper
 * approve — blank refuses. Never invents a trigger from parent qty or another leg.
 * Does not place children and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperBracketStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_entry'
  | 'missing_take_profit'
  | 'missing_stop_loss'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperBracketStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperBracketStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperBracketStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'bracket';
  readonly status: 'paper';
  readonly entry: string;
  readonly takeProfit: string;
  readonly stopLoss: string;
};

export type OmsPaperBracketStartResult = OmsPaperBracketStartOk | OmsPaperBracketStartRefusal;

function refuse(reason: OmsPaperBracketStartRefuseReason, detail: string): OmsPaperBracketStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedTrigger(
  raw: string | null | undefined,
  missing: 'missing_entry' | 'missing_take_profit' | 'missing_stop_loss',
  label: string,
): { ok: true; text: string } | OmsPaperBracketStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse(missing, `${label} is missing — refusing to invent a trigger or a live venue`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse(missing, `${label} is missing — refusing to invent a trigger or a live venue`);
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse(missing, `${label} must be a positive ledger amount — refusing to invent a trigger`);
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse(missing, `${label} is not a ledger amount — refusing to invent a trigger`);
  }
}

/**
 * Start an already-approved paper bracket parent.
 * All three legs go live from retained entry, take-profit, and stop-loss. Paper off refuses.
 */
export function startPaperBracketParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper bracket parent. */
  approved?: boolean;
  /** Paper-approved status is 'paper'. Live running refuses already_started. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained entry from paper approve. Blank refuses — never invent a trigger. */
  entry?: string | null;
  /** Retained take-profit from paper approve. Blank refuses — never invent a trigger. */
  takeProfit?: string | null;
  /** Retained stop-loss from paper approve. Blank refuses — never invent a trigger. */
  stopLoss?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperBracketStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper bracket start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'bracket') {
    return refuse('not_live', `kind ${String(input.kind)} is not bracket`);
  }
  if (input.status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  if (input.approved !== true && input.status !== 'paper' && input.status !== 'approved') {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper bracket parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const entry = parseRetainedTrigger(input.entry, 'missing_entry', 'bracket entry');
  if (!entry.ok) return entry;
  const takeProfit = parseRetainedTrigger(input.takeProfit, 'missing_take_profit', 'bracket take-profit');
  if (!takeProfit.ok) return takeProfit;
  const stopLoss = parseRetainedTrigger(input.stopLoss, 'missing_stop_loss', 'bracket stop-loss');
  if (!stopLoss.ok) return stopLoss;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'bracket',
    status: 'paper',
    entry: entry.text,
    takeProfit: takeProfit.text,
    stopLoss: stopLoss.text,
  };
}

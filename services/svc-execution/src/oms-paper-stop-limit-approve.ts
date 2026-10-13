/**
 * Approve one paper stop-limit parent when owner stop price and limit price are present.
 * Both prices are ledger amounts. Missing/blank/invalid refuses — this never invents
 * a trigger from parent qty or the other price. Paper off refuses a live venue.
 * Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperStopLimitApproveRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'stop_blank'
  | 'stop_invalid'
  | 'limit_blank'
  | 'limit_invalid'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperStopLimitApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperStopLimitApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperStopLimitApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'stop-limit';
  };
  readonly status: 'paper';
  readonly stopPrice: string;
  readonly limitPrice: string;
};

export type OmsPaperStopLimitApproveResult = OmsPaperStopLimitApproveOk | OmsPaperStopLimitApproveRefusal;

function refuse(reason: OmsPaperStopLimitApproveRefuseReason, detail: string): OmsPaperStopLimitApproveRefusal {
  return { ok: false, reason, detail };
}

function parseTrigger(
  raw: string | null | undefined,
  blank: 'stop_blank' | 'limit_blank',
  invalid: 'stop_invalid' | 'limit_invalid',
  label: string,
): { ok: true; text: string } | OmsPaperStopLimitApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse(blank, `${label} is blank — refuse rather than invent a trigger`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse(blank, `${label} is blank — refuse rather than invent a trigger`);
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse(invalid, `${label} is not a ledger amount — refusing to invent a trigger`);
  }
}

/**
 * Approve a paper stop-limit parent only when both stop and limit prices are present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperStopLimitParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  stopPrice?: string | null;
  limitPrice?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperStopLimitApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper stop-limit approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'stop-limit') {
    return refuse('not_live', `kind ${String(input.kind)} is not stop-limit`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const stop = parseTrigger(input.stopPrice, 'stop_blank', 'stop_invalid', 'stop-limit stop price');
  if (!stop.ok) return stop;
  const limit = parseTrigger(input.limitPrice, 'limit_blank', 'limit_invalid', 'stop-limit limit price');
  if (!limit.ok) return limit;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'stop-limit' },
    status: 'paper',
    stopPrice: stop.text,
    limitPrice: limit.text,
  };
}

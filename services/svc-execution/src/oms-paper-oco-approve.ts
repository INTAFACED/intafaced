/**
 * Approve one paper OCO parent with linked take-profit and stop-loss children.
 * Both sibling triggers are ledger amounts. Missing, blank, zero, or negative
 * refuses with that leg's blank reason; unparsable refuses invalid — this
 * never invents a trigger from parent qty or the other sibling. Paper off refuses
 * a live venue. Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperOcoApproveRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'take_profit_blank'
  | 'take_profit_invalid'
  | 'stop_loss_blank'
  | 'stop_loss_invalid'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperOcoApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperOcoApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperOcoApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'oco';
  };
  readonly status: 'paper';
  readonly takeProfit: string;
  readonly stopLoss: string;
};

export type OmsPaperOcoApproveResult = OmsPaperOcoApproveOk | OmsPaperOcoApproveRefusal;

function refuse(reason: OmsPaperOcoApproveRefuseReason, detail: string): OmsPaperOcoApproveRefusal {
  return { ok: false, reason, detail };
}

function parseTrigger(
  raw: string | null | undefined,
  blank: 'take_profit_blank' | 'stop_loss_blank',
  invalid: 'take_profit_invalid' | 'stop_loss_invalid',
  label: string,
): { ok: true; text: string } | OmsPaperOcoApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse(blank, `${label} is blank — refuse rather than invent a trigger`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse(blank, `${label} is blank — refuse rather than invent a trigger`);
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse(blank, `${label} is blank — refuse rather than invent a trigger`);
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse(invalid, `${label} is not a ledger amount — refusing to invent a trigger`);
  }
}

/**
 * Approve a paper OCO parent only when both sibling triggers are present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperOcoParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  takeProfit?: string | null;
  stopLoss?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperOcoApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper OCO approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'oco') {
    return refuse('not_live', `kind ${String(input.kind)} is not oco`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const takeProfit = parseTrigger(input.takeProfit, 'take_profit_blank', 'take_profit_invalid', 'OCO take-profit');
  if (!takeProfit.ok) return takeProfit;
  const stopLoss = parseTrigger(input.stopLoss, 'stop_loss_blank', 'stop_loss_invalid', 'OCO stop-loss');
  if (!stopLoss.ok) return stopLoss;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'oco' },
    status: 'paper',
    takeProfit: takeProfit.text,
    stopLoss: stopLoss.text,
  };
}

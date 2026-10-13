/**
 * Approve one paper bracket parent with entry, take-profit, and stop-loss children.
 * All three leg triggers are ledger amounts. Missing/blank/invalid refuses — this
 * never invents a trigger from parent qty or another leg. Paper off refuses a live
 * venue. Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperBracketApproveRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'entry_blank'
  | 'entry_invalid'
  | 'take_profit_blank'
  | 'take_profit_invalid'
  | 'stop_loss_blank'
  | 'stop_loss_invalid'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperBracketApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperBracketApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperBracketApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'bracket';
  };
  readonly status: 'paper';
  readonly entry: string;
  readonly takeProfit: string;
  readonly stopLoss: string;
};

export type OmsPaperBracketApproveResult = OmsPaperBracketApproveOk | OmsPaperBracketApproveRefusal;

function refuse(reason: OmsPaperBracketApproveRefuseReason, detail: string): OmsPaperBracketApproveRefusal {
  return { ok: false, reason, detail };
}

function parseTrigger(
  raw: string | null | undefined,
  blank: 'entry_blank' | 'take_profit_blank' | 'stop_loss_blank',
  invalid: 'entry_invalid' | 'take_profit_invalid' | 'stop_loss_invalid',
  label: string,
): { ok: true; text: string } | OmsPaperBracketApproveRefusal {
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
 * Approve a paper bracket parent only when all three leg triggers are present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperBracketParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  entry?: string | null;
  takeProfit?: string | null;
  stopLoss?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperBracketApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper bracket approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'bracket') {
    return refuse('not_live', `kind ${String(input.kind)} is not bracket`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const entry = parseTrigger(input.entry, 'entry_blank', 'entry_invalid', 'bracket entry');
  if (!entry.ok) return entry;
  const takeProfit = parseTrigger(input.takeProfit, 'take_profit_blank', 'take_profit_invalid', 'bracket take-profit');
  if (!takeProfit.ok) return takeProfit;
  const stopLoss = parseTrigger(input.stopLoss, 'stop_loss_blank', 'stop_loss_invalid', 'bracket stop-loss');
  if (!stopLoss.ok) return stopLoss;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'bracket' },
    status: 'paper',
    entry: entry.text,
    takeProfit: takeProfit.text,
    stopLoss: stopLoss.text,
  };
}

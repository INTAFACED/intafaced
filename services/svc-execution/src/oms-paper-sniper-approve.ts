/**
 * Approve one paper sniper parent when owner trigger price is present.
 * Trigger price is a ledger amount. Missing/blank/invalid refuses — this
 * never invents a trigger from parent qty. Paper off refuses a live venue.
 * Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperSniperApproveRefuseReason =
  'missing_parent' | 'not_live' | 'trigger_blank' | 'trigger_invalid' | 'paper_gate_unwired' | 'paper_off' | 'missing_operator';

export type OmsPaperSniperApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperSniperApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperSniperApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'sniper';
  };
  readonly status: 'paper';
  readonly triggerPrice: string;
};

export type OmsPaperSniperApproveResult = OmsPaperSniperApproveOk | OmsPaperSniperApproveRefusal;

function refuse(reason: OmsPaperSniperApproveRefuseReason, detail: string): OmsPaperSniperApproveRefusal {
  return { ok: false, reason, detail };
}

function parseTriggerPrice(raw: string | null | undefined): { ok: true; text: string } | OmsPaperSniperApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('trigger_blank', 'sniper trigger price is blank — refuse rather than invent a trigger');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('trigger_blank', 'sniper trigger price is blank — refuse rather than invent a trigger');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('trigger_blank', 'sniper trigger price is blank — refuse rather than invent a trigger');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('trigger_invalid', 'sniper trigger price is not a ledger amount — refusing to invent a trigger');
  }
}

/**
 * Approve a paper sniper parent only when owner trigger price is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperSniperParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  triggerPrice?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperSniperApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper sniper approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'sniper') {
    return refuse('not_live', `kind ${String(input.kind)} is not sniper`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const trigger = parseTriggerPrice(input.triggerPrice);
  if (!trigger.ok) return trigger;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'sniper' },
    status: 'paper',
    triggerPrice: trigger.text,
  };
}

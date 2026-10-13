/**
 * Approve one paper pegged parent when owner offset is present.
 * Offset is a ledger amount. Missing/blank/invalid refuses — this
 * never invents offset from parent qty. Paper off refuses a live venue.
 * Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperPeggedApproveRefuseReason =
  'missing_parent' | 'not_live' | 'offset_blank' | 'offset_invalid' | 'paper_gate_unwired' | 'paper_off' | 'missing_operator';

export type OmsPaperPeggedApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperPeggedApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperPeggedApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'pegged';
  };
  readonly status: 'paper';
  readonly offset: string;
};

export type OmsPaperPeggedApproveResult = OmsPaperPeggedApproveOk | OmsPaperPeggedApproveRefusal;

function refuse(reason: OmsPaperPeggedApproveRefuseReason, detail: string): OmsPaperPeggedApproveRefusal {
  return { ok: false, reason, detail };
}

function parseOffset(raw: string | null | undefined): { ok: true; text: string } | OmsPaperPeggedApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('offset_blank', 'pegged offset is blank — refuse rather than invent offset');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('offset_blank', 'pegged offset is blank — refuse rather than invent offset');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('offset_invalid', 'pegged offset is not a ledger amount — refusing to invent offset');
  }
}

/**
 * Approve a paper pegged parent only when owner offset is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperPeggedParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  offset?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperPeggedApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper pegged approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'pegged') {
    return refuse('not_live', `kind ${String(input.kind)} is not pegged`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const offset = parseOffset(input.offset);
  if (!offset.ok) return offset;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'pegged' },
    status: 'paper',
    offset: offset.text,
  };
}

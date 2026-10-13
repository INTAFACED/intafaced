/**
 * Approve one paper scale-out parent when owner child size is present.
 * Child size is a ledger amount. Missing/blank/invalid refuses — this never
 * invents size from parent qty. Paper off refuses a live venue. Does not start
 * and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperScaleOutApproveRefuseReason =
  'missing_parent' | 'not_live' | 'child_size_blank' | 'child_size_invalid' | 'paper_gate_unwired' | 'paper_off' | 'missing_operator';

export type OmsPaperScaleOutApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperScaleOutApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperScaleOutApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'scale-out';
  };
  readonly status: 'paper';
  readonly childSize: string;
};

export type OmsPaperScaleOutApproveResult = OmsPaperScaleOutApproveOk | OmsPaperScaleOutApproveRefusal;

function refuse(reason: OmsPaperScaleOutApproveRefuseReason, detail: string): OmsPaperScaleOutApproveRefusal {
  return { ok: false, reason, detail };
}

function parseChildSize(raw: string | null | undefined): { ok: true; text: string } | OmsPaperScaleOutApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('child_size_blank', 'scale-out child size is blank — refuse rather than invent size');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('child_size_blank', 'scale-out child size is blank — refuse rather than invent size');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('child_size_invalid', 'scale-out child size must be a positive ledger amount — not invented');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('child_size_invalid', 'scale-out child size is not a ledger amount — refusing to invent size');
  }
}

/**
 * Approve a paper scale-out parent only when owner child size is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperScaleOutParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Child size for each scale-out clip. Blank refuses — never invent from parent amount. */
  childSize?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperScaleOutApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper scale-out approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'scale-out') {
    return refuse('not_live', `kind ${String(input.kind)} is not scale-out`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const size = parseChildSize(input.childSize);
  if (!size.ok) return size;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'scale-out' },
    status: 'paper',
    childSize: size.text,
  };
}

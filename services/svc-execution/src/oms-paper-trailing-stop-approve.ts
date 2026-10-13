/**
 * Approve one paper trailing-stop parent when owner trail offset is present.
 * Trail offset is a ledger amount. Missing/blank/invalid refuses — this
 * never invents trail from parent qty. Paper off refuses a live venue.
 * Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperTrailingStopApproveRefuseReason =
  'missing_parent' | 'not_live' | 'trail_blank' | 'trail_invalid' | 'paper_gate_unwired' | 'paper_off' | 'missing_operator';

export type OmsPaperTrailingStopApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperTrailingStopApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperTrailingStopApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'trailing-stop';
  };
  readonly status: 'paper';
  readonly trailOffset: string;
};

export type OmsPaperTrailingStopApproveResult = OmsPaperTrailingStopApproveOk | OmsPaperTrailingStopApproveRefusal;

function refuse(reason: OmsPaperTrailingStopApproveRefuseReason, detail: string): OmsPaperTrailingStopApproveRefusal {
  return { ok: false, reason, detail };
}

function parseTrailOffset(raw: string | null | undefined): { ok: true; text: string } | OmsPaperTrailingStopApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('trail_blank', 'trailing-stop trail is blank — refuse rather than invent trail');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('trail_blank', 'trailing-stop trail is blank — refuse rather than invent trail');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('trail_invalid', 'trailing-stop trail is not a ledger amount — refusing to invent trail');
  }
}

/**
 * Approve a paper trailing-stop parent only when owner trail offset is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperTrailingStopParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  trailOffset?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperTrailingStopApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper trailing-stop approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'trailing-stop') {
    return refuse('not_live', `kind ${String(input.kind)} is not trailing-stop`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const trail = parseTrailOffset(input.trailOffset);
  if (!trail.ok) return trail;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'trailing-stop' },
    status: 'paper',
    trailOffset: trail.text,
  };
}

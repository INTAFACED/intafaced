/**
 * Approve one paper TWAP parent when owner duration is present.
 * Duration is integer milliseconds. Missing/blank/invalid refuses — this
 * never invents a schedule from slices. Paper off refuses a live venue.
 * Does not start and does not touch matching.
 */
import type { PaperGate } from './oms-paper.js';

export type OmsPaperTwapApproveRefuseReason =
  'missing_parent' | 'not_live' | 'duration_blank' | 'duration_invalid' | 'paper_gate_unwired' | 'paper_off' | 'missing_operator';

export type OmsPaperTwapApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperTwapApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperTwapApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'twap';
  };
  readonly status: 'paper';
  readonly durationMs: number;
};

export type OmsPaperTwapApproveResult = OmsPaperTwapApproveOk | OmsPaperTwapApproveRefusal;

function refuse(reason: OmsPaperTwapApproveRefuseReason, detail: string): OmsPaperTwapApproveRefusal {
  return { ok: false, reason, detail };
}

function parseTwapDurationMs(raw: number | null | undefined): { ok: true; value: number } | OmsPaperTwapApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('duration_blank', 'TWAP duration is blank — refuse rather than invent a schedule');
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    return refuse('duration_invalid', 'TWAP duration must be a positive integer ms — not invented from slices');
  }
  return { ok: true, value: raw };
}

/**
 * Approve a paper TWAP parent only when owner duration is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperTwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  durationMs?: number | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperTwapApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper TWAP approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'twap') {
    return refuse('not_live', `kind ${String(input.kind)} is not twap`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const duration = parseTwapDurationMs(input.durationMs);
  if (!duration.ok) return duration;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'twap' },
    status: 'paper',
    durationMs: duration.value,
  };
}

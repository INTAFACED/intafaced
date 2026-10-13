/**
 * Approve one paper POV parent when owner max participation is present.
 * Max participation is integer bps. Missing/blank/invalid refuses — this
 * never invents a rate. Paper off refuses a live venue. Does not start and
 * does not touch matching.
 */
import type { PaperGate } from './oms-paper.js';

export type OmsPaperPovApproveRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'max_participation_blank'
  | 'max_participation_invalid'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperPovApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperPovApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperPovApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'pov';
  };
  readonly status: 'paper';
  readonly maxParticipationBps: number;
};

export type OmsPaperPovApproveResult = OmsPaperPovApproveOk | OmsPaperPovApproveRefusal;

function refuse(reason: OmsPaperPovApproveRefuseReason, detail: string): OmsPaperPovApproveRefusal {
  return { ok: false, reason, detail };
}

function parseMaxParticipationBps(raw: number | null | undefined): { ok: true; value: number } | OmsPaperPovApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('max_participation_blank', 'max participation is blank — refuse rather than invent a POV rate');
  }
  if (!Number.isInteger(raw) || raw < 0) {
    return refuse('max_participation_invalid', 'max participation must be a non-negative integer bps — not invented');
  }
  return { ok: true, value: raw };
}

/**
 * Approve a paper POV parent only when owner max participation is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperPovParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  maxParticipationBps?: number | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperPovApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper POV approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'pov') {
    return refuse('not_live', `kind ${String(input.kind)} is not pov`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const rate = parseMaxParticipationBps(input.maxParticipationBps);
  if (!rate.ok) return rate;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'pov' },
    status: 'paper',
    maxParticipationBps: rate.value,
  };
}

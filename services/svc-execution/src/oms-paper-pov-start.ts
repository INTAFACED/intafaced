/**
 * Start one already-approved paper POV parent.
 * Paper off refuses. Max participation is the retained rate from paper approve —
 * blank refuses. Never invents a live venue or slices. Does not place children
 * and does not touch matching.
 */
import type { PaperGate } from './oms-paper.js';

export type OmsPaperPovStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_max_participation'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperPovStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperPovStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperPovStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'pov';
  readonly status: 'paper';
  readonly maxParticipationBps: number;
};

export type OmsPaperPovStartResult = OmsPaperPovStartOk | OmsPaperPovStartRefusal;

function refuse(reason: OmsPaperPovStartRefuseReason, detail: string): OmsPaperPovStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedMaxParticipation(raw: number | null | undefined): { ok: true; value: number } | OmsPaperPovStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_max_participation', 'POV max participation is missing — refusing to invent a rate or a live venue');
  }
  if (!Number.isInteger(raw) || raw < 0) {
    return refuse('missing_max_participation', 'POV max participation must be a non-negative integer bps — refusing to invent a rate');
  }
  return { ok: true, value: raw };
}

/**
 * Start an already-approved paper POV parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperPovParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper POV parent. */
  approved?: boolean;
  /** Trimmed 'paper' or 'approved' may start. Trimmed 'running' refuses already_started. Any other present status, including blank, refuses not_approved. Omitted status follows approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained max participation from paper approve. Blank refuses — never invent a rate. */
  maxParticipationBps?: number | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperPovStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper POV start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'pov') {
    return refuse('not_live', `kind ${String(input.kind)} is not pov`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  const startableStatus = status === 'paper' || status === 'approved';
  // Trimmed '' is present. Only an omitted status is undefined and may follow approved.
  if (status !== undefined && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper POV parent`);
  }
  if (input.approved !== true && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper POV parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const rate = parseRetainedMaxParticipation(input.maxParticipationBps);
  if (!rate.ok) return rate;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'pov',
    status: 'paper',
    maxParticipationBps: rate.value,
  };
}

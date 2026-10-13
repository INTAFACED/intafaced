/**
 * Start one already-approved paper TWAP parent.
 * Paper off refuses. Duration is the retained schedule — blank refuses.
 * Never invents a live venue or slices. Does not place children and does not
 * touch matching.
 */
import type { PaperGate } from './oms-paper.js';

export type OmsPaperTwapStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_schedule'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperTwapStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperTwapStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperTwapStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'twap';
  readonly status: 'paper';
  readonly durationMs: number;
};

export type OmsPaperTwapStartResult = OmsPaperTwapStartOk | OmsPaperTwapStartRefusal;

function refuse(reason: OmsPaperTwapStartRefuseReason, detail: string): OmsPaperTwapStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedDuration(raw: number | null | undefined): { ok: true; value: number } | OmsPaperTwapStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_schedule', 'TWAP duration is missing — refusing to invent a schedule');
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    return refuse('missing_schedule', 'TWAP duration must be a positive integer ms — refusing to invent a schedule from slices');
  }
  return { ok: true, value: raw };
}

/**
 * Start an already-approved paper TWAP parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperTwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper TWAP parent. */
  approved?: boolean;
  /** Trimmed before compare. 'running' refuses already_started. A present blank or other non-startable status refuses not_approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained duration from paper approve. Blank refuses — never invent a schedule. */
  durationMs?: number | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperTwapStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper TWAP start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'twap') {
    return refuse('not_live', `kind ${String(input.kind)} is not twap`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  // Trimmed '' is present. Only an omitted status is undefined and may follow approved.
  const startableStatus = status === 'paper' || status === 'approved';
  if (status !== undefined && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper TWAP parent`);
  }
  if (input.approved !== true && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper TWAP parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const duration = parseRetainedDuration(input.durationMs);
  if (!duration.ok) return duration;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'twap',
    status: 'paper',
    durationMs: duration.value,
  };
}

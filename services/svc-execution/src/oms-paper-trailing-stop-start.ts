/**
 * Start one already-approved paper trailing-stop parent.
 * Paper off refuses. Trail offset is the retained leftover from paper approve —
 * blank refuses. Never invents a live venue or slices. Does not place children
 * and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperTrailingStopStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_trail'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperTrailingStopStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperTrailingStopStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperTrailingStopStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'trailing-stop';
  readonly status: 'paper';
  readonly trailOffset: string;
};

export type OmsPaperTrailingStopStartResult = OmsPaperTrailingStopStartOk | OmsPaperTrailingStopStartRefusal;

function refuse(reason: OmsPaperTrailingStopStartRefuseReason, detail: string): OmsPaperTrailingStopStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedTrailOffset(raw: string | null | undefined): { ok: true; text: string } | OmsPaperTrailingStopStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_trail', 'trailing-stop trail is missing — refusing to invent trail or a live venue');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_trail', 'trailing-stop trail is missing — refusing to invent trail or a live venue');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_trail', 'trailing-stop trail is not a ledger amount — refusing to invent trail');
  }
}

/**
 * Start an already-approved paper trailing-stop parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperTrailingStopParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper trailing-stop parent. */
  approved?: boolean;
  /** Trimmed before compare. 'running' refuses already_started. A present blank or other non-startable status refuses not_approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained trail offset from paper approve. Blank refuses — never invent trail. */
  trailOffset?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperTrailingStopStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper trailing-stop start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'trailing-stop') {
    return refuse('not_live', `kind ${String(input.kind)} is not trailing-stop`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  // Trimmed '' is present. Only an omitted status is undefined and may follow approved.
  const startableStatus = status === 'paper' || status === 'approved';
  if (status !== undefined && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper trailing-stop parent`);
  }
  if (input.approved !== true && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper trailing-stop parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const trail = parseRetainedTrailOffset(input.trailOffset);
  if (!trail.ok) return trail;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'trailing-stop',
    status: 'paper',
    trailOffset: trail.text,
  };
}

/**
 * Start one already-approved paper pegged parent.
 * Paper off refuses. Offset is the retained leftover from paper approve —
 * blank refuses. Never invents a live venue or slices. Does not place children
 * and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperPeggedStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_offset'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperPeggedStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperPeggedStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperPeggedStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'pegged';
  readonly status: 'paper';
  readonly offset: string;
};

export type OmsPaperPeggedStartResult = OmsPaperPeggedStartOk | OmsPaperPeggedStartRefusal;

function refuse(reason: OmsPaperPeggedStartRefuseReason, detail: string): OmsPaperPeggedStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedOffset(raw: string | null | undefined): { ok: true; text: string } | OmsPaperPeggedStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_offset', 'pegged offset is missing — refusing to invent offset or a live venue');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_offset', 'pegged offset is missing — refusing to invent offset or a live venue');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_offset', 'pegged offset is not a ledger amount — refusing to invent offset');
  }
}

/**
 * Start an already-approved paper pegged parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperPeggedParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper pegged parent. */
  approved?: boolean;
  /** Paper-approved status is 'paper' or 'approved'. Trimmed 'running' refuses already_started. Stopped and expired refuse not_approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained offset from paper approve. Blank refuses — never invent offset. */
  offset?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperPeggedStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper pegged start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'pegged') {
    return refuse('not_live', `kind ${String(input.kind)} is not pegged`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  if (status === 'stopped' || status === 'expired' || (input.approved !== true && status !== 'paper' && status !== 'approved')) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper pegged parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const offset = parseRetainedOffset(input.offset);
  if (!offset.ok) return offset;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'pegged',
    status: 'paper',
    offset: offset.text,
  };
}

/**
 * Start one already-approved paper scale-out parent.
 * Paper off refuses. Child size is the retained leftover from paper approve —
 * blank refuses. Never invents size from parent qty. Does not place children
 * and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperScaleOutStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_child_size'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperScaleOutStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperScaleOutStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperScaleOutStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'scale-out';
  readonly status: 'paper';
  readonly childSize: string;
};

export type OmsPaperScaleOutStartResult = OmsPaperScaleOutStartOk | OmsPaperScaleOutStartRefusal;

function refuse(reason: OmsPaperScaleOutStartRefuseReason, detail: string): OmsPaperScaleOutStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedChildSize(raw: string | null | undefined): { ok: true; text: string } | OmsPaperScaleOutStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_child_size', 'scale-out child size is missing — refusing to invent size or a live venue');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_child_size', 'scale-out child size is missing — refusing to invent size or a live venue');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('missing_child_size', 'scale-out child size must be a positive ledger amount — refusing to invent size');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('missing_child_size', 'scale-out child size is not a ledger amount — refusing to invent size');
  }
}

/**
 * Start an already-approved paper scale-out parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperScaleOutParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper scale-out parent. */
  approved?: boolean;
  /** Trimmed 'paper' or 'approved' may start. Trimmed 'running' refuses already_started. Any other present status, including blank, refuses not_approved. Omitted status follows approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained child size from paper approve. Blank refuses — never invent size. */
  childSize?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperScaleOutStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper scale-out start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'scale-out') {
    return refuse('not_live', `kind ${String(input.kind)} is not scale-out`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  const startableStatus = status === 'paper' || status === 'approved';
  // Trimmed '' is present. Only an omitted status is undefined and may follow approved.
  if (status !== undefined && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper scale-out parent`);
  }
  if (input.approved !== true && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper scale-out parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const size = parseRetainedChildSize(input.childSize);
  if (!size.ok) return size;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'scale-out',
    status: 'paper',
    childSize: size.text,
  };
}

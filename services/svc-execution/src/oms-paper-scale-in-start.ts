/**
 * Start one already-approved paper scale-in parent.
 * Paper off refuses. Child size is the retained leftover from paper approve —
 * blank refuses. Never invents size from parent qty. Does not place children
 * and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperScaleInStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_child_size'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperScaleInStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperScaleInStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperScaleInStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'scale-in';
  readonly status: 'paper';
  readonly childSize: string;
};

export type OmsPaperScaleInStartResult = OmsPaperScaleInStartOk | OmsPaperScaleInStartRefusal;

function refuse(reason: OmsPaperScaleInStartRefuseReason, detail: string): OmsPaperScaleInStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedChildSize(raw: string | null | undefined): { ok: true; text: string } | OmsPaperScaleInStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_child_size', 'scale-in child size is missing — refusing to invent size or a live venue');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_child_size', 'scale-in child size is missing — refusing to invent size or a live venue');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('missing_child_size', 'scale-in child size must be a positive ledger amount — refusing to invent size');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('missing_child_size', 'scale-in child size is not a ledger amount — refusing to invent size');
  }
}

/**
 * Start an already-approved paper scale-in parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperScaleInParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper scale-in parent. */
  approved?: boolean;
  /** Paper-approved status is 'paper'. Live running refuses already_started. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained child size from paper approve. Blank refuses — never invent size. */
  childSize?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperScaleInStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper scale-in start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'scale-in') {
    return refuse('not_live', `kind ${String(input.kind)} is not scale-in`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  if (
    status === 'stopped' ||
    status === 'expired' ||
    input.approved === false ||
    (input.approved !== true && status !== 'paper' && status !== 'approved')
  ) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper scale-in parent`);
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
    kind: 'scale-in',
    status: 'paper',
    childSize: size.text,
  };
}

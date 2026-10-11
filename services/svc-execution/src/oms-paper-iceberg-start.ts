/**
 * Start one already-approved paper iceberg parent.
 * Paper off refuses. Display qty is the retained leftover from paper approve —
 * blank refuses. Never invents a live venue or slices. Does not place children
 * and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperIcebergStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_display_qty'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperIcebergStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperIcebergStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperIcebergStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'iceberg';
  readonly status: 'paper';
  readonly displayQty: string;
};

export type OmsPaperIcebergStartResult = OmsPaperIcebergStartOk | OmsPaperIcebergStartRefusal;

function refuse(reason: OmsPaperIcebergStartRefuseReason, detail: string): OmsPaperIcebergStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedDisplayQty(raw: string | null | undefined): { ok: true; text: string } | OmsPaperIcebergStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_display_qty', 'iceberg display qty is missing — refusing to invent size or a live venue');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_display_qty', 'iceberg display qty is missing — refusing to invent size or a live venue');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('missing_display_qty', 'iceberg display qty must be a positive ledger amount — refusing to invent size');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('missing_display_qty', 'iceberg display qty is not a ledger amount — refusing to invent size');
  }
}

/**
 * Start an already-approved paper iceberg parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperIcebergParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper iceberg parent. */
  approved?: boolean;
  /** Paper-approved status is 'paper' or 'approved'. Trimmed 'running' refuses already_started. Stopped and expired refuse not_approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained display qty from paper approve. Blank refuses — never invent size. */
  displayQty?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperIcebergStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper iceberg start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'iceberg') {
    return refuse('not_live', `kind ${String(input.kind)} is not iceberg`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  if (status === 'stopped' || status === 'expired' || (input.approved !== true && status !== 'paper' && status !== 'approved')) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper iceberg parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const qty = parseRetainedDisplayQty(input.displayQty);
  if (!qty.ok) return qty;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'iceberg',
    status: 'paper',
    displayQty: qty.text,
  };
}

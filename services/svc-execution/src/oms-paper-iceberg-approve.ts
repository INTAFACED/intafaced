/**
 * Approve one paper iceberg parent when owner display qty is present.
 * Display qty is a ledger amount. Missing/blank/invalid refuses — this
 * never invents size from parent qty. Paper off refuses a live venue.
 * Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperIcebergApproveRefuseReason =
  'missing_parent' | 'not_live' | 'display_qty_blank' | 'display_qty_invalid' | 'paper_gate_unwired' | 'paper_off' | 'missing_operator';

export type OmsPaperIcebergApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperIcebergApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperIcebergApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'iceberg';
  };
  readonly status: 'paper';
  readonly displayQty: string;
};

export type OmsPaperIcebergApproveResult = OmsPaperIcebergApproveOk | OmsPaperIcebergApproveRefusal;

function refuse(reason: OmsPaperIcebergApproveRefuseReason, detail: string): OmsPaperIcebergApproveRefusal {
  return { ok: false, reason, detail };
}

function parseDisplayQty(raw: string | null | undefined): { ok: true; text: string } | OmsPaperIcebergApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('display_qty_blank', 'iceberg display qty is blank — refuse rather than invent size');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('display_qty_blank', 'iceberg display qty is blank — refuse rather than invent size');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('display_qty_invalid', 'iceberg display qty must be a positive ledger amount — not invented');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('display_qty_invalid', 'iceberg display qty is not a ledger amount — refusing to invent size');
  }
}

/**
 * Approve a paper iceberg parent only when owner display qty is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperIcebergParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  displayQty?: string | null;
  amount?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperIcebergApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper iceberg approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'iceberg') {
    return refuse('not_live', `kind ${String(input.kind)} is not iceberg`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const qty = parseDisplayQty(input.displayQty);
  if (!qty.ok) return qty;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'iceberg' },
    status: 'paper',
    displayQty: qty.text,
  };
}

/**
 * Refresh display qty on a live paper iceberg parent.
 * Display qty is a ledger amount. Missing/blank/invalid refuses — this never
 * invents size from parent amount. Paper off refuses. Does not submit to matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperIcebergRefreshDisplayRefuseReason =
  'missing_parent' | 'not_live' | 'display_qty_blank' | 'display_qty_invalid' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperIcebergRefreshDisplayRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperIcebergRefreshDisplayRefuseReason;
  readonly detail: string;
};

export type OmsPaperIcebergRefreshDisplayOk = {
  readonly ok: true;
  readonly refreshed: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'iceberg';
  };
  readonly displayQty: string;
};

export type OmsPaperIcebergRefreshDisplayResult = OmsPaperIcebergRefreshDisplayOk | OmsPaperIcebergRefreshDisplayRefusal;

function refuse(reason: OmsPaperIcebergRefreshDisplayRefuseReason, detail: string): OmsPaperIcebergRefreshDisplayRefusal {
  return { ok: false, reason, detail };
}

function parseDisplayQty(raw: string | null | undefined): { ok: true; text: string } | OmsPaperIcebergRefreshDisplayRefusal {
  if (raw === null || raw === undefined) {
    return refuse('display_qty_blank', 'iceberg display qty is blank — refuse rather than invent size from parent amount');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('display_qty_blank', 'iceberg display qty is blank — refuse rather than invent size from parent amount');
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
 * Refresh display qty on a live paper iceberg parent using caller display qty.
 * Parent amount is ignored for size — never a substitute leftover.
 */
export function refreshPaperIcebergDisplayQty(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  displayQty?: string | null;
  /** Parent amount. Must not be used as display qty. */
  amount?: string | null;
  paper?: PaperGate;
}): OmsPaperIcebergRefreshDisplayResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper iceberg display refresh');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'iceberg') {
    return refuse('not_live', `kind ${String(input.kind)} is not iceberg`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'paper') {
    return refuse('not_live', `parent ${parentClientOrderId} is ${status || 'not paper'} — refresh needs a live paper iceberg parent`);
  }
  const qty = parseDisplayQty(input.displayQty);
  if (!qty.ok) return qty;

  return {
    ok: true,
    refreshed: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'iceberg' },
    displayQty: qty.text,
  };
}

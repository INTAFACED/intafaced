/**
 * Slice one child of a live paper implementation-shortfall parent.
 * Qty is required. Missing/blank/invalid refuses — this never invents
 * size from arrival price. Paper off refuses. Does not submit to matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsIsPaperSliceRefuseReason =
  'missing_parent' | 'not_live' | 'missing_qty' | 'qty_invalid' | 'paper_gate_unwired' | 'paper_off';

export type OmsIsPaperSliceRefusal = {
  readonly ok: false;
  readonly reason: OmsIsPaperSliceRefuseReason;
  readonly detail: string;
};

export type OmsIsPaperSliceOk = {
  readonly ok: true;
  readonly sliced: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly amount: string;
};

export type OmsIsPaperSliceResult = OmsIsPaperSliceOk | OmsIsPaperSliceRefusal;

function refuse(reason: OmsIsPaperSliceRefuseReason, detail: string): OmsIsPaperSliceRefusal {
  return { ok: false, reason, detail };
}

function parseQty(raw: string | null | undefined): { ok: true; text: string } | OmsIsPaperSliceRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_qty', 'slice qty is blank — refuse rather than invent size from arrival');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_qty', 'slice qty is blank — refuse rather than invent size from arrival');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('qty_invalid', 'slice qty must be a positive ledger amount — not invented from arrival');
    }
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('qty_invalid', `slice qty is not a ledger amount: ${message}`);
  }
}

function paperLive(status: string | undefined): boolean {
  return status === 'paper';
}

/**
 * Slice one child of a live paper IS parent using caller qty.
 * Arrival price is ignored for size — never a substitute leftover.
 */
export function slicePaperImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  amount?: string | null;
  /** Retained arrival. Must not be used as qty. */
  arrivalPrice?: string | null;
  paper?: PaperGate;
}): OmsIsPaperSliceResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper slice');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'implementation_shortfall') {
    return refuse('not_live', `kind ${String(input.kind)} is not implementation_shortfall`);
  }
  if (!paperLive(input.status)) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${input.status} — slice needs a live paper IS parent`);
  }
  const qty = parseQty(input.amount);
  if (!qty.ok) return qty;

  return {
    ok: true,
    sliced: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    amount: qty.text,
  };
}

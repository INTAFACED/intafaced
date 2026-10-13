/**
 * Slice one child of a live paper VWAP parent.
 * Qty is required. Missing/blank/invalid refuses — this never invents
 * size from target volume. Paper off refuses. Does not submit to matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperVwapSliceRefuseReason =
  'missing_parent' | 'not_live' | 'missing_qty' | 'qty_invalid' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperVwapSliceRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperVwapSliceRefuseReason;
  readonly detail: string;
};

export type OmsPaperVwapSliceOk = {
  readonly ok: true;
  readonly sliced: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'vwap';
  };
  readonly amount: string;
};

export type OmsPaperVwapSliceResult = OmsPaperVwapSliceOk | OmsPaperVwapSliceRefusal;

function refuse(reason: OmsPaperVwapSliceRefuseReason, detail: string): OmsPaperVwapSliceRefusal {
  return { ok: false, reason, detail };
}

function parseQty(raw: string | null | undefined): { ok: true; text: string } | OmsPaperVwapSliceRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_qty', 'slice qty is blank — refuse rather than invent size from target volume');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_qty', 'slice qty is blank — refuse rather than invent size from target volume');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('qty_invalid', 'slice qty must be a positive ledger amount — not invented from target volume');
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
 * Slice one child of a live paper VWAP parent using caller qty.
 * Target volume is ignored for size — never a substitute leftover.
 */
export function slicePaperVwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  amount?: string | null;
  /** Retained target volume. Must not be used as qty. */
  targetVolume?: string | null;
  paper?: PaperGate;
}): OmsPaperVwapSliceResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper VWAP slice');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'vwap') {
    return refuse('not_live', `kind ${String(input.kind)} is not vwap`);
  }
  if (!paperLive(input.status)) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${input.status} — slice needs a live paper VWAP parent`);
  }
  const qty = parseQty(input.amount);
  if (!qty.ok) return qty;

  return {
    ok: true,
    sliced: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'vwap' },
    amount: qty.text,
  };
}

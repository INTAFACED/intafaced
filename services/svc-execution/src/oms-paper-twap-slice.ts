/**
 * Slice one child of a live paper TWAP parent.
 * Qty is required. Missing/blank/invalid refuses — this never invents
 * size from duration. Paper off refuses. Does not submit to matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperTwapSliceRefuseReason =
  'missing_parent' | 'not_live' | 'missing_qty' | 'qty_invalid' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperTwapSliceRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperTwapSliceRefuseReason;
  readonly detail: string;
};

export type OmsPaperTwapSliceOk = {
  readonly ok: true;
  readonly sliced: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'twap';
  };
  readonly amount: string;
};

export type OmsPaperTwapSliceResult = OmsPaperTwapSliceOk | OmsPaperTwapSliceRefusal;

function refuse(reason: OmsPaperTwapSliceRefuseReason, detail: string): OmsPaperTwapSliceRefusal {
  return { ok: false, reason, detail };
}

function parseQty(raw: string | null | undefined): { ok: true; text: string } | OmsPaperTwapSliceRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_qty', 'slice qty is blank — refuse rather than invent size from duration');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_qty', 'slice qty is blank — refuse rather than invent size from duration');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('qty_invalid', 'slice qty must be a positive ledger amount — not invented from duration');
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
 * Slice one child of a live paper TWAP parent using caller qty.
 * Duration is ignored for size — never a substitute leftover.
 */
export function slicePaperTwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  amount?: string | null;
  /** Retained duration. Must not be used as qty. */
  durationMs?: number | null;
  paper?: PaperGate;
}): OmsPaperTwapSliceResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper TWAP slice');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'twap') {
    return refuse('not_live', `kind ${String(input.kind)} is not twap`);
  }
  if (!paperLive(input.status)) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${input.status} — slice needs a live paper TWAP parent`);
  }
  const qty = parseQty(input.amount);
  if (!qty.ok) return qty;

  return {
    ok: true,
    sliced: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'twap' },
    amount: qty.text,
  };
}

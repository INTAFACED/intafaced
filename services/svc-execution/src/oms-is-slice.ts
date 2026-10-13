/**
 * Slice one child of a live implementation-shortfall parent.
 * Qty is required. Missing/blank/invalid refuses — this never invents
 * size from arrival price. Does not submit to matching.
 */
import { parseAmount } from '@intafaced/ledger-client';

export type OmsIsSliceRefuseReason = 'missing_parent' | 'not_live' | 'missing_qty' | 'qty_invalid';

export type OmsIsSliceRefusal = {
  readonly ok: false;
  readonly reason: OmsIsSliceRefuseReason;
  readonly detail: string;
};

export type OmsIsSliceOk = {
  readonly ok: true;
  readonly sliced: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly amount: string;
};

export type OmsIsSliceResult = OmsIsSliceOk | OmsIsSliceRefusal;

function refuse(reason: OmsIsSliceRefuseReason, detail: string): OmsIsSliceRefusal {
  return { ok: false, reason, detail };
}

function parseQty(raw: string | null | undefined): { ok: true; text: string } | OmsIsSliceRefusal {
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

function liveStatus(status: string | undefined): boolean {
  return status === 'approved' || status === 'running';
}

/**
 * Slice one child of a live IS parent using caller qty.
 * Arrival price is ignored for size — never a substitute leftover.
 */
export function sliceImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  amount?: string | null;
  /** Retained arrival. Must not be used as qty. */
  arrivalPrice?: string | null;
}): OmsIsSliceResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (input.kind !== undefined && input.kind !== 'implementation_shortfall') {
    return refuse('not_live', `kind ${String(input.kind)} is not implementation_shortfall`);
  }
  if (!liveStatus(input.status ?? '')) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${input.status} — slice needs a live (approved or running) IS parent`);
  }
  const qty = parseQty(input.amount);
  if (!qty.ok) return qty;

  return {
    ok: true,
    sliced: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    amount: qty.text,
  };
}

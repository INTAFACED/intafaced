/**
 * Slice one child of a live paper scale-in parent.
 * Child size is a ledger amount. Missing/blank/invalid refuses — this never
 * invents size from parent qty. Paper off refuses. Does not submit to matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperScaleInSliceRefuseReason =
  'missing_parent' | 'not_live' | 'missing_child_size' | 'child_size_invalid' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperScaleInSliceRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperScaleInSliceRefuseReason;
  readonly detail: string;
};

export type OmsPaperScaleInSliceOk = {
  readonly ok: true;
  readonly sliced: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'scale-in';
  };
  readonly childSize: string;
};

export type OmsPaperScaleInSliceResult = OmsPaperScaleInSliceOk | OmsPaperScaleInSliceRefusal;

function refuse(reason: OmsPaperScaleInSliceRefuseReason, detail: string): OmsPaperScaleInSliceRefusal {
  return { ok: false, reason, detail };
}

function parseChildSize(raw: string | null | undefined): { ok: true; text: string } | OmsPaperScaleInSliceRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_child_size', 'scale-in child size is missing — refuse rather than invent size from parent amount');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_child_size', 'scale-in child size is missing — refuse rather than invent size from parent amount');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('child_size_invalid', 'scale-in child size must be a positive ledger amount — not invented from parent amount');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('child_size_invalid', 'scale-in child size is not a ledger amount — refusing to invent size');
  }
}

/**
 * Slice one child of a live paper scale-in parent using retained child size.
 * Parent amount is ignored for size — never a substitute leftover.
 */
export function slicePaperScaleInParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Retained child size from paper approve. Blank refuses — never invent size. */
  childSize?: string | null;
  /** Parent amount. Must not be used as child size. */
  amount?: string | null;
  paper?: PaperGate;
}): OmsPaperScaleInSliceResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper scale-in slice');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'scale-in') {
    return refuse('not_live', `kind ${String(input.kind)} is not scale-in`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'paper') {
    return refuse('not_live', `parent ${parentClientOrderId} is ${status || 'not paper'} — slice needs a live paper scale-in parent`);
  }
  const size = parseChildSize(input.childSize);
  if (!size.ok) return size;

  return {
    ok: true,
    sliced: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'scale-in' },
    childSize: size.text,
  };
}

/**
 * Amend remaining qty on one live paper implementation-shortfall parent.
 * Cancels remaining children first so the previous request does not stay live.
 * Refuse if remaining is blank. Unknown child cancel refuses. Does not submit
 * to matching and never invents a live venue.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsIsPaperAmendChildOutcome = 'stopped' | 'already_stopped' | 'unknown';

export type OmsIsPaperAmendChild = {
  readonly childClientOrderId: string;
  readonly outcome: OmsIsPaperAmendChildOutcome;
};

export type OmsIsPaperAmendRefuseReason =
  'remaining_blank' | 'remaining_invalid' | 'missing_parent' | 'not_live' | 'children_unknown' | 'paper_gate_unwired' | 'paper_off';

export type OmsIsPaperAmendRefusal = {
  readonly ok: false;
  readonly reason: OmsIsPaperAmendRefuseReason;
  readonly detail: string;
};

export type OmsIsPaperAmendOk = {
  readonly ok: true;
  readonly amended: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly children: readonly OmsIsPaperAmendChild[];
  readonly residual: { readonly remaining: string };
};

export type OmsIsPaperAmendResult = OmsIsPaperAmendOk | OmsIsPaperAmendRefusal;

function refuse(reason: OmsIsPaperAmendRefuseReason, detail: string): OmsIsPaperAmendRefusal {
  return { ok: false, reason, detail };
}

function parseRemainingQty(raw: string | null | undefined): { ok: true; text: string } | OmsIsPaperAmendRefusal {
  if (raw === null || raw === undefined) {
    return refuse('remaining_blank', 'remaining qty is blank — refuse rather than invent size');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('remaining_blank', 'remaining qty is blank — refuse rather than invent size');
  }
  try {
    const value = parseAmount(text);
    if (value < 0n) {
      return refuse('remaining_invalid', 'remaining qty must be a non-negative ledger amount — not invented');
    }
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('remaining_invalid', `remaining qty is not a ledger amount: ${message}`);
  }
}

function childrenKnown(children: readonly OmsIsPaperAmendChild[]): boolean {
  return children.every((child) => child.outcome === 'stopped' || child.outcome === 'already_stopped');
}

/**
 * Amend remaining on a live paper IS parent after every child cancel is known.
 */
export function amendRemainingPaperImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  remaining?: string | null;
  children?: readonly OmsIsPaperAmendChild[];
  paper?: PaperGate;
}): OmsIsPaperAmendResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper amend remaining');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'implementation_shortfall') {
    return refuse('not_live', `kind ${String(input.kind)} is not implementation_shortfall`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'paper') {
    return refuse('not_live', `parent ${parentClientOrderId} is ${status || 'not paper'} — amend needs a live paper IS parent`);
  }

  const remaining = parseRemainingQty(input.remaining);
  if (!remaining.ok) return remaining;

  const children = input.children ?? [];
  if (!childrenKnown(children)) {
    return refuse('children_unknown', 'previous request may still be live — refusing to amend remaining until every child cancel is known');
  }

  return {
    ok: true,
    amended: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    children,
    residual: { remaining: remaining.text },
  };
}

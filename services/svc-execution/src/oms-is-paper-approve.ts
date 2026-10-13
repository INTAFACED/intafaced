/**
 * Approve one implementation-shortfall parent in paper.
 * Arrival price is required. Missing/blank/invalid refuses — this never
 * invents a price from a book or a mid. Does not plan slices, does not
 * start live, and does not touch matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsIsPaperApproveRefuseReason =
  'missing_parent' | 'arrival_price_blank' | 'arrival_price_invalid' | 'paper_gate_unwired' | 'paper_off' | 'missing_operator';

export type OmsIsPaperApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsIsPaperApproveRefuseReason;
  readonly detail: string;
};

export type OmsIsPaperApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly status: 'paper';
  readonly arrivalPrice: string;
};

export type OmsIsPaperApproveResult = OmsIsPaperApproveOk | OmsIsPaperApproveRefusal;

function refuse(reason: OmsIsPaperApproveRefuseReason, detail: string): OmsIsPaperApproveRefusal {
  return { ok: false, reason, detail };
}

function parseArrivalPrice(raw: string | null | undefined): { ok: true; text: string } | OmsIsPaperApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('arrival_price_blank', 'arrival price is blank — refuse rather than invent a price from a book');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('arrival_price_blank', 'arrival price is blank — refuse rather than invent a price from a book');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('arrival_price_invalid', 'arrival price must be a positive ledger amount — not invented');
    }
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('arrival_price_invalid', `arrival price is not a ledger amount: ${message}`);
  }
}

/**
 * Approve a paper implementation-shortfall parent when arrival price is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  arrivalPrice?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsIsPaperApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const arrival = parseArrivalPrice(input.arrivalPrice);
  if (!arrival.ok) return arrival;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    status: 'paper',
    arrivalPrice: arrival.text,
  };
}

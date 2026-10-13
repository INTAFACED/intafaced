/**
 * When one sibling of a live paper OCO parent fills, cancel the other.
 * Paper off refuses. Residual stays on the parent. Both sibling triggers are
 * retained leftovers from paper approve — blank refuses. Never invents a
 * trigger from parent qty, the filled sibling, or the other sibling. Does not
 * touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperOcoFilledSibling = 'take_profit' | 'stop_loss';

export type OmsPaperOcoCancelOtherRefuseReason =
  | 'missing_parent'
  | 'not_running'
  | 'already_stopped'
  | 'missing_filled_sibling'
  | 'missing_take_profit'
  | 'missing_stop_loss'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off';

export type OmsPaperOcoCancelOtherRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperOcoCancelOtherRefuseReason;
  readonly detail: string;
};

export type OmsPaperOcoCancelOtherOk = {
  readonly ok: true;
  readonly cancelled: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'oco';
  };
  readonly filled: OmsPaperOcoFilledSibling;
  readonly cancelledSibling: OmsPaperOcoFilledSibling;
  readonly takeProfit: string;
  readonly stopLoss: string;
  readonly residual: { readonly remaining: string | null };
};

export type OmsPaperOcoCancelOtherResult = OmsPaperOcoCancelOtherOk | OmsPaperOcoCancelOtherRefusal;

function refuse(reason: OmsPaperOcoCancelOtherRefuseReason, detail: string): OmsPaperOcoCancelOtherRefusal {
  return { ok: false, reason, detail };
}

function echoRemaining(raw: string | null | undefined): string | null {
  const remaining = raw?.trim() ?? '';
  return remaining || null;
}

function parseRetainedTrigger(
  raw: string | null | undefined,
  missing: 'missing_take_profit' | 'missing_stop_loss',
  label: string,
): { ok: true; text: string } | OmsPaperOcoCancelOtherRefusal {
  if (raw === null || raw === undefined) {
    return refuse(missing, `${label} is missing — refusing to invent a trigger or a live venue`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse(missing, `${label} is missing — refusing to invent a trigger or a live venue`);
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse(missing, `${label} is not a ledger amount — refusing to invent a trigger`);
  }
}

function otherSibling(filled: OmsPaperOcoFilledSibling): OmsPaperOcoFilledSibling {
  return filled === 'take_profit' ? 'stop_loss' : 'take_profit';
}

/**
 * Cancel the other sibling when one sibling of a live paper OCO parent fills.
 * Residual stays. Paper off refuses — no live venue is invented.
 */
export function cancelOtherPaperOcoSiblingOnFill(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Which sibling filled. The other is cancelled. Blank refuses. */
  filled?: string | null;
  /** Retained take-profit from paper approve. Blank refuses — never invent a trigger. */
  takeProfit?: string | null;
  /** Retained stop-loss from paper approve. Blank refuses — never invent a trigger. */
  stopLoss?: string | null;
  amount?: string | null;
  remaining?: string | null;
  paper?: PaperGate;
}): OmsPaperOcoCancelOtherResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper OCO cancel-other');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'oco') {
    return refuse('not_live', `kind ${String(input.kind)} is not oco`);
  }
  const status = input.status?.trim() ?? '';
  if (status === 'stopped') {
    return refuse('already_stopped', `parent ${parentClientOrderId} is already stopped`);
  }
  if (status === 'running') {
    return refuse('not_running', `parent ${parentClientOrderId} is running live — refusing to invent a paper cancel over live`);
  }
  if (status !== 'paper') {
    return refuse('not_running', `parent ${parentClientOrderId} is not a live paper OCO parent`);
  }
  const filledRaw = input.filled?.trim() ?? '';
  if (filledRaw !== 'take_profit' && filledRaw !== 'stop_loss') {
    return refuse('missing_filled_sibling', 'filled sibling is missing — refuse rather than invent which child filled');
  }
  const filled: OmsPaperOcoFilledSibling = filledRaw;
  const takeProfit = parseRetainedTrigger(input.takeProfit, 'missing_take_profit', 'OCO take-profit');
  if (!takeProfit.ok) return takeProfit;
  const stopLoss = parseRetainedTrigger(input.stopLoss, 'missing_stop_loss', 'OCO stop-loss');
  if (!stopLoss.ok) return stopLoss;

  return {
    ok: true,
    cancelled: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'oco' },
    filled,
    cancelledSibling: otherSibling(filled),
    takeProfit: takeProfit.text,
    stopLoss: stopLoss.text,
    residual: { remaining: echoRemaining(input.remaining) },
  };
}

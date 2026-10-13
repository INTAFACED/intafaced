/**
 * When one exit of a live paper bracket parent fills, cancel the other.
 * Exits are take-profit and stop-loss. Entry fill is not this door. Paper off
 * refuses. Residual stays on the parent. Both exit triggers are retained leftovers
 * from paper approve — blank refuses. Never invents a trigger from parent qty,
 * the filled exit, or the other exit. Does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperBracketFilledExit = 'take_profit' | 'stop_loss';

export type OmsPaperBracketCancelOtherRefuseReason =
  | 'missing_parent'
  | 'not_running'
  | 'already_stopped'
  | 'missing_filled_exit'
  | 'missing_take_profit'
  | 'missing_stop_loss'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off';

export type OmsPaperBracketCancelOtherRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperBracketCancelOtherRefuseReason;
  readonly detail: string;
};

export type OmsPaperBracketCancelOtherOk = {
  readonly ok: true;
  readonly cancelled: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'bracket';
  };
  readonly filled: OmsPaperBracketFilledExit;
  readonly cancelledExit: OmsPaperBracketFilledExit;
  readonly takeProfit: string;
  readonly stopLoss: string;
  readonly residual: { readonly remaining: string | null };
};

export type OmsPaperBracketCancelOtherResult = OmsPaperBracketCancelOtherOk | OmsPaperBracketCancelOtherRefusal;

function refuse(reason: OmsPaperBracketCancelOtherRefuseReason, detail: string): OmsPaperBracketCancelOtherRefusal {
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
): { ok: true; text: string } | OmsPaperBracketCancelOtherRefusal {
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

function otherExit(filled: OmsPaperBracketFilledExit): OmsPaperBracketFilledExit {
  return filled === 'take_profit' ? 'stop_loss' : 'take_profit';
}

/**
 * Cancel the other exit when one exit of a live paper bracket parent fills.
 * Residual stays. Paper off refuses — no live venue is invented.
 */
export function cancelOtherPaperBracketExitOnFill(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Which exit filled. The other is cancelled. Entry is not an exit. Blank refuses. */
  filled?: string | null;
  /** Retained take-profit from paper approve. Blank refuses — never invent a trigger. */
  takeProfit?: string | null;
  /** Retained stop-loss from paper approve. Blank refuses — never invent a trigger. */
  stopLoss?: string | null;
  amount?: string | null;
  remaining?: string | null;
  paper?: PaperGate;
}): OmsPaperBracketCancelOtherResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper bracket cancel-other');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'bracket') {
    return refuse('not_live', `kind ${String(input.kind)} is not bracket`);
  }
  const status = input.status?.trim() ?? '';
  if (status === 'stopped') {
    return refuse('already_stopped', `parent ${parentClientOrderId} is already stopped`);
  }
  if (status === 'running') {
    return refuse('not_running', `parent ${parentClientOrderId} is running live — refusing to invent a paper cancel over live`);
  }
  if (status !== 'paper') {
    return refuse('not_running', `parent ${parentClientOrderId} is not a live paper bracket parent`);
  }
  const filledRaw = input.filled?.trim() ?? '';
  if (filledRaw !== 'take_profit' && filledRaw !== 'stop_loss') {
    return refuse('missing_filled_exit', 'filled exit is missing — refuse rather than invent which exit filled');
  }
  const filled: OmsPaperBracketFilledExit = filledRaw;
  const takeProfit = parseRetainedTrigger(input.takeProfit, 'missing_take_profit', 'bracket take-profit');
  if (!takeProfit.ok) return takeProfit;
  const stopLoss = parseRetainedTrigger(input.stopLoss, 'missing_stop_loss', 'bracket stop-loss');
  if (!stopLoss.ok) return stopLoss;

  return {
    ok: true,
    cancelled: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'bracket' },
    filled,
    cancelledExit: otherExit(filled),
    takeProfit: takeProfit.text,
    stopLoss: stopLoss.text,
    residual: { remaining: echoRemaining(input.remaining) },
  };
}

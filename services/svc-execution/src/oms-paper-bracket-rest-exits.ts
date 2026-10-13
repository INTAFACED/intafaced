/**
 * When the entry of a live paper bracket parent fills, rest the take-profit and
 * stop-loss. Paper off refuses. All three leg triggers are retained leftovers from
 * paper approve — blank refuses. Never invents a trigger from parent qty or another
 * leg. Does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperBracketRestExitsRefuseReason =
  | 'missing_parent'
  | 'not_running'
  | 'already_stopped'
  | 'missing_entry'
  | 'missing_take_profit'
  | 'missing_stop_loss'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off';

export type OmsPaperBracketRestExitsRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperBracketRestExitsRefuseReason;
  readonly detail: string;
};

export type OmsPaperBracketRestExitsOk = {
  readonly ok: true;
  readonly rested: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'bracket';
  };
  readonly filled: 'entry';
  readonly restedLegs: readonly ['take_profit', 'stop_loss'];
  readonly entry: string;
  readonly takeProfit: string;
  readonly stopLoss: string;
};

export type OmsPaperBracketRestExitsResult = OmsPaperBracketRestExitsOk | OmsPaperBracketRestExitsRefusal;

function refuse(reason: OmsPaperBracketRestExitsRefuseReason, detail: string): OmsPaperBracketRestExitsRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedTrigger(
  raw: string | null | undefined,
  missing: 'missing_entry' | 'missing_take_profit' | 'missing_stop_loss',
  label: string,
): { ok: true; text: string } | OmsPaperBracketRestExitsRefusal {
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

/**
 * Rest take-profit and stop-loss when the entry of a live paper bracket parent fills.
 * Paper off refuses — no live venue is invented.
 */
export function restPaperBracketExitsOnEntryFill(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Retained entry from paper approve. Blank refuses — never invent a trigger. */
  entry?: string | null;
  /** Retained take-profit from paper approve. Blank refuses — never invent a trigger. */
  takeProfit?: string | null;
  /** Retained stop-loss from paper approve. Blank refuses — never invent a trigger. */
  stopLoss?: string | null;
  amount?: string | null;
  paper?: PaperGate;
}): OmsPaperBracketRestExitsResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper bracket rest-exits');
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
    return refuse('not_running', `parent ${parentClientOrderId} is running live — refusing to invent a paper rest over live`);
  }
  if (status !== 'paper') {
    return refuse('not_running', `parent ${parentClientOrderId} is not a live paper bracket parent`);
  }
  const entry = parseRetainedTrigger(input.entry, 'missing_entry', 'bracket entry');
  if (!entry.ok) return entry;
  const takeProfit = parseRetainedTrigger(input.takeProfit, 'missing_take_profit', 'bracket take-profit');
  if (!takeProfit.ok) return takeProfit;
  const stopLoss = parseRetainedTrigger(input.stopLoss, 'missing_stop_loss', 'bracket stop-loss');
  if (!stopLoss.ok) return stopLoss;

  return {
    ok: true,
    rested: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'bracket' },
    filled: 'entry',
    restedLegs: ['take_profit', 'stop_loss'],
    entry: entry.text,
    takeProfit: takeProfit.text,
    stopLoss: stopLoss.text,
  };
}

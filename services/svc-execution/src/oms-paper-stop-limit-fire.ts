/**
 * Fire the limit child of a live paper stop-limit parent when the stop price is hit.
 * Stop, last, and limit are ledger amounts. Missing/blank/invalid refuses — this never
 * invents a stop from parent qty, last, or the limit. A last that is not the stop refuses.
 * The child is a limit at the retained limit price. Child qty is a ledger amount. Paper
 * off refuses. Does not submit to matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperStopLimitFireRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'missing_stop'
  | 'missing_limit'
  | 'missing_last'
  | 'stop_not_hit'
  | 'missing_qty'
  | 'qty_invalid'
  | 'paper_gate_unwired'
  | 'paper_off';

export type OmsPaperStopLimitFireRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperStopLimitFireRefuseReason;
  readonly detail: string;
};

export type OmsPaperStopLimitFireOk = {
  readonly ok: true;
  readonly fired: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'stop-limit';
  };
  readonly stopPrice: string;
  readonly lastPrice: string;
  readonly child: {
    readonly kind: 'limit';
    readonly limitPrice: string;
    readonly amount: string;
  };
};

export type OmsPaperStopLimitFireResult = OmsPaperStopLimitFireOk | OmsPaperStopLimitFireRefusal;

function refuse(reason: OmsPaperStopLimitFireRefuseReason, detail: string): OmsPaperStopLimitFireRefusal {
  return { ok: false, reason, detail };
}

function parseLedger(
  raw: string | null | undefined,
  missing: 'missing_stop' | 'missing_limit' | 'missing_last',
  label: string,
): { ok: true; text: string; value: bigint } | OmsPaperStopLimitFireRefusal {
  if (raw === null || raw === undefined) {
    return refuse(missing, `${label} is missing — refusing to invent a trigger or a live child`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse(missing, `${label} is missing — refusing to invent a trigger or a live child`);
  }
  try {
    const value = parseAmount(text);
    return { ok: true, text: formatAmount(value), value };
  } catch {
    return refuse(missing, `${label} is not a ledger amount — refusing to invent a trigger`);
  }
}

function parseQty(raw: string | null | undefined): { ok: true; text: string } | OmsPaperStopLimitFireRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_qty', 'child qty is blank — refuse rather than invent size from the stop or the limit');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_qty', 'child qty is blank — refuse rather than invent size from the stop or the limit');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('qty_invalid', 'child qty must be a positive ledger amount — not invented from the stop or the limit');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('qty_invalid', 'child qty is not a ledger amount — refusing to invent size from the stop or the limit');
  }
}

/**
 * Fire the limit child of a live paper stop-limit parent only when last equals the
 * retained stop. Paper off refuses — no live venue is invented.
 */
export function firePaperStopLimitLimitChildOnStop(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Retained stop price from paper approve. Blank refuses — never invent a trigger. */
  stopPrice?: string | null;
  /** Retained limit price from paper approve. Blank refuses — never invent a limit from the stop. */
  limitPrice?: string | null;
  /** Last print. Must equal the stop — never invent a hit. */
  lastPrice?: string | null;
  /** Child qty. Must not be invented from the stop or the limit. */
  amount?: string | null;
  paper?: PaperGate;
}): OmsPaperStopLimitFireResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper stop-limit fire');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'stop-limit') {
    return refuse('not_live', `kind ${String(input.kind)} is not stop-limit`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'paper') {
    return refuse('not_live', `parent ${parentClientOrderId} is ${status || 'not paper'} — fire needs a live paper stop-limit parent`);
  }
  const stop = parseLedger(input.stopPrice, 'missing_stop', 'stop-limit stop price');
  if (!stop.ok) return stop;
  const last = parseLedger(input.lastPrice, 'missing_last', 'stop-limit last price');
  if (!last.ok) return last;
  if (last.value !== stop.value) {
    return refuse('stop_not_hit', 'last is not the stop-limit stop — refusing to invent a hit or a live child');
  }
  const limit = parseLedger(input.limitPrice, 'missing_limit', 'stop-limit limit price');
  if (!limit.ok) return limit;
  const qty = parseQty(input.amount);
  if (!qty.ok) return qty;

  return {
    ok: true,
    fired: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'stop-limit' },
    stopPrice: stop.text,
    lastPrice: last.text,
    child: {
      kind: 'limit',
      limitPrice: limit.text,
      amount: qty.text,
    },
  };
}

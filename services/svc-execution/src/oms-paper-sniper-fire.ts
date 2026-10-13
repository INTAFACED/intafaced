/**
 * Fire one child of a live paper sniper parent when the trigger price is hit.
 * Trigger and last are ledger amounts. Missing/blank/invalid refuses — this never
 * invents a trigger from parent qty or last. A last that is not the trigger refuses.
 * Child qty is a ledger amount. Paper off refuses. Does not submit to matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperSniperFireRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'missing_trigger'
  | 'missing_last'
  | 'trigger_not_hit'
  | 'missing_qty'
  | 'qty_invalid'
  | 'paper_gate_unwired'
  | 'paper_off';

export type OmsPaperSniperFireRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperSniperFireRefuseReason;
  readonly detail: string;
};

export type OmsPaperSniperFireOk = {
  readonly ok: true;
  readonly fired: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'sniper';
  };
  readonly triggerPrice: string;
  readonly lastPrice: string;
  readonly amount: string;
};

export type OmsPaperSniperFireResult = OmsPaperSniperFireOk | OmsPaperSniperFireRefusal;

function refuse(reason: OmsPaperSniperFireRefuseReason, detail: string): OmsPaperSniperFireRefusal {
  return { ok: false, reason, detail };
}

function parseLedger(
  raw: string | null | undefined,
  missing: 'missing_trigger' | 'missing_last' | 'missing_qty',
  label: string,
): { ok: true; text: string; value: bigint } | OmsPaperSniperFireRefusal {
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

function parseQty(raw: string | null | undefined): { ok: true; text: string } | OmsPaperSniperFireRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_qty', 'child qty is blank — refuse rather than invent size from the trigger');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_qty', 'child qty is blank — refuse rather than invent size from the trigger');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('qty_invalid', 'child qty must be a positive ledger amount — not invented from the trigger');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('qty_invalid', 'child qty is not a ledger amount — refusing to invent size from the trigger');
  }
}

/**
 * Fire one child of a live paper sniper parent only when last equals the retained trigger.
 * Paper off refuses — no live venue is invented.
 */
export function firePaperSniperChildOnTrigger(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Retained trigger price from paper approve. Blank refuses — never invent a trigger. */
  triggerPrice?: string | null;
  /** Last print. Must equal the trigger — never invent a hit. */
  lastPrice?: string | null;
  /** Child qty. Must not be invented from the trigger. */
  amount?: string | null;
  paper?: PaperGate;
}): OmsPaperSniperFireResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper sniper fire');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'sniper') {
    return refuse('not_live', `kind ${String(input.kind)} is not sniper`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'paper') {
    return refuse('not_live', `parent ${parentClientOrderId} is ${status || 'not paper'} — fire needs a live paper sniper parent`);
  }
  const trigger = parseLedger(input.triggerPrice, 'missing_trigger', 'sniper trigger price');
  if (!trigger.ok) return trigger;
  const last = parseLedger(input.lastPrice, 'missing_last', 'sniper last price');
  if (!last.ok) return last;
  if (last.value !== trigger.value) {
    return refuse('trigger_not_hit', 'last is not the sniper trigger — refusing to invent a hit or a live child');
  }
  const qty = parseQty(input.amount);
  if (!qty.ok) return qty;

  return {
    ok: true,
    fired: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'sniper' },
    triggerPrice: trigger.text,
    lastPrice: last.text,
    amount: qty.text,
  };
}

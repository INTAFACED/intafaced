/**
 * Amend trail offset on a live paper trailing-stop parent.
 * Trail offset is a ledger amount. Missing/blank/invalid refuses — this never
 * invents trail from parent amount. Paper off refuses. Does not submit to matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperTrailingStopAmendTrailRefuseReason =
  'missing_parent' | 'not_live' | 'trail_blank' | 'trail_invalid' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperTrailingStopAmendTrailRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperTrailingStopAmendTrailRefuseReason;
  readonly detail: string;
};

export type OmsPaperTrailingStopAmendTrailOk = {
  readonly ok: true;
  readonly amended: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'trailing-stop';
  };
  readonly trailOffset: string;
};

export type OmsPaperTrailingStopAmendTrailResult = OmsPaperTrailingStopAmendTrailOk | OmsPaperTrailingStopAmendTrailRefusal;

function refuse(reason: OmsPaperTrailingStopAmendTrailRefuseReason, detail: string): OmsPaperTrailingStopAmendTrailRefusal {
  return { ok: false, reason, detail };
}

function parseTrailOffset(raw: string | null | undefined): { ok: true; text: string } | OmsPaperTrailingStopAmendTrailRefusal {
  if (raw === null || raw === undefined) {
    return refuse('trail_blank', 'trailing-stop trail is blank — refuse rather than invent trail from parent amount');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('trail_blank', 'trailing-stop trail is blank — refuse rather than invent trail from parent amount');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('trail_invalid', 'trailing-stop trail is not a ledger amount — refusing to invent trail');
  }
}

/**
 * Amend trail offset on a live paper trailing-stop parent using caller trail.
 * Parent amount is ignored for trail — never a substitute leftover.
 */
export function amendPaperTrailingStopTrail(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  trailOffset?: string | null;
  /** Parent amount. Must not be used as trail. */
  amount?: string | null;
  paper?: PaperGate;
}): OmsPaperTrailingStopAmendTrailResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper trailing-stop trail amend');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'trailing-stop') {
    return refuse('not_live', `kind ${String(input.kind)} is not trailing-stop`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'paper') {
    return refuse('not_live', `parent ${parentClientOrderId} is ${status || 'not paper'} — amend needs a live paper trailing-stop parent`);
  }
  const trail = parseTrailOffset(input.trailOffset);
  if (!trail.ok) return trail;

  return {
    ok: true,
    amended: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'trailing-stop' },
    trailOffset: trail.text,
  };
}

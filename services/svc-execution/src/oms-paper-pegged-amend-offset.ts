/**
 * Amend offset on a live paper pegged parent.
 * Offset is a ledger amount. Missing/blank/invalid refuses — this never
 * invents offset from parent amount. Paper off refuses. Does not submit to matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperPeggedAmendOffsetRefuseReason =
  'missing_parent' | 'not_live' | 'offset_blank' | 'offset_invalid' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperPeggedAmendOffsetRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperPeggedAmendOffsetRefuseReason;
  readonly detail: string;
};

export type OmsPaperPeggedAmendOffsetOk = {
  readonly ok: true;
  readonly amended: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'pegged';
  };
  readonly offset: string;
};

export type OmsPaperPeggedAmendOffsetResult = OmsPaperPeggedAmendOffsetOk | OmsPaperPeggedAmendOffsetRefusal;

function refuse(reason: OmsPaperPeggedAmendOffsetRefuseReason, detail: string): OmsPaperPeggedAmendOffsetRefusal {
  return { ok: false, reason, detail };
}

function parseOffset(raw: string | null | undefined): { ok: true; text: string } | OmsPaperPeggedAmendOffsetRefusal {
  if (raw === null || raw === undefined) {
    return refuse('offset_blank', 'pegged offset is blank — refuse rather than invent offset from parent amount');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('offset_blank', 'pegged offset is blank — refuse rather than invent offset from parent amount');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('offset_invalid', 'pegged offset is not a ledger amount — refusing to invent offset');
  }
}

/**
 * Amend offset on a live paper pegged parent using caller offset.
 * Parent amount is ignored for offset — never a substitute leftover.
 */
export function amendPaperPeggedOffset(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  offset?: string | null;
  /** Parent amount. Must not be used as offset. */
  amount?: string | null;
  paper?: PaperGate;
}): OmsPaperPeggedAmendOffsetResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper pegged offset amend');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'pegged') {
    return refuse('not_live', `kind ${String(input.kind)} is not pegged`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'paper') {
    return refuse('not_live', `parent ${parentClientOrderId} is ${status || 'not paper'} — amend needs a live paper pegged parent`);
  }
  const offset = parseOffset(input.offset);
  if (!offset.ok) return offset;

  return {
    ok: true,
    amended: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'pegged' },
    offset: offset.text,
  };
}

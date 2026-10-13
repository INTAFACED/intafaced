/**
 * Start one already-approved paper VWAP parent.
 * Paper off refuses. Target volume is the retained leftover from paper approve —
 * blank refuses. Never invents a live venue or slices. Does not place children
 * and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperVwapStartRefuseReason =
  | 'missing_parent'
  | 'not_approved'
  | 'already_started'
  | 'missing_target_volume'
  | 'not_live'
  | 'paper_gate_unwired'
  | 'paper_off'
  | 'missing_operator';

export type OmsPaperVwapStartRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperVwapStartRefuseReason;
  readonly detail: string;
};

export type OmsPaperVwapStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly paper: true;
  readonly parentClientOrderId: string;
  readonly kind: 'vwap';
  readonly status: 'paper';
  readonly targetVolume: string;
};

export type OmsPaperVwapStartResult = OmsPaperVwapStartOk | OmsPaperVwapStartRefusal;

function refuse(reason: OmsPaperVwapStartRefuseReason, detail: string): OmsPaperVwapStartRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedTargetVolume(raw: string | null | undefined): { ok: true; text: string } | OmsPaperVwapStartRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_target_volume', 'VWAP target volume is missing — refusing to invent volume or a live venue');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_target_volume', 'VWAP target volume is missing — refusing to invent volume or a live venue');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('missing_target_volume', 'VWAP target volume must be a positive ledger amount — refusing to invent volume');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('missing_target_volume', 'VWAP target volume is not a ledger amount — refusing to invent volume');
  }
}

/**
 * Start an already-approved paper VWAP parent.
 * Paper off refuses — no live venue is invented.
 */
export function startPaperVwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  /** Must be true — start needs an already-approved paper VWAP parent. */
  approved?: boolean;
  /** Trimmed before compare. 'running' refuses already_started. A present blank or other non-startable status refuses not_approved. */
  status?: 'paper' | 'approved' | 'running' | string;
  /** Retained target volume from paper approve. Blank refuses — never invent volume. */
  targetVolume?: string | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperVwapStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper VWAP start');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'vwap') {
    return refuse('not_live', `kind ${String(input.kind)} is not vwap`);
  }
  const status = input.status?.trim();
  if (status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running live — refusing to invent a paper start over live`);
  }
  // Trimmed '' is present. Only an omitted status is undefined and may follow approved.
  const startableStatus = status === 'paper' || status === 'approved';
  if (status !== undefined && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper VWAP parent`);
  }
  if (input.approved !== true && !startableStatus) {
    return refuse('not_approved', `parent ${parentClientOrderId} is not an approved paper VWAP parent`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const volume = parseRetainedTargetVolume(input.targetVolume);
  if (!volume.ok) return volume;

  return {
    ok: true,
    started: true,
    paper: true,
    parentClientOrderId,
    kind: 'vwap',
    status: 'paper',
    targetVolume: volume.text,
  };
}

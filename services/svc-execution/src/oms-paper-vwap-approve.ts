/**
 * Approve one paper VWAP parent when owner target volume is present.
 * Target volume is a ledger amount. Missing/blank/invalid refuses — this
 * never invents volume from duration or slices. Paper off refuses a live venue.
 * Does not start and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperVwapApproveRefuseReason =
  'missing_parent' | 'not_live' | 'target_volume_blank' | 'target_volume_invalid' | 'paper_gate_unwired' | 'paper_off' | 'missing_operator';

export type OmsPaperVwapApproveRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperVwapApproveRefuseReason;
  readonly detail: string;
};

export type OmsPaperVwapApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'vwap';
  };
  readonly status: 'paper';
  readonly targetVolume: string;
};

export type OmsPaperVwapApproveResult = OmsPaperVwapApproveOk | OmsPaperVwapApproveRefusal;

function refuse(reason: OmsPaperVwapApproveRefuseReason, detail: string): OmsPaperVwapApproveRefusal {
  return { ok: false, reason, detail };
}

function parseTargetVolume(raw: string | null | undefined): { ok: true; text: string } | OmsPaperVwapApproveRefusal {
  if (raw === null || raw === undefined) {
    return refuse('target_volume_blank', 'VWAP target volume is blank — refuse rather than invent volume');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('target_volume_blank', 'VWAP target volume is blank — refuse rather than invent volume');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('target_volume_invalid', 'VWAP target volume must be a positive ledger amount — not invented');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('target_volume_invalid', 'VWAP target volume is not a ledger amount — refusing to invent volume');
  }
}

/**
 * Approve a paper VWAP parent only when owner target volume is present.
 * Paper off refuses — no live venue is invented.
 */
export function approvePaperVwapParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  targetVolume?: string | null;
  durationMs?: number | null;
  operatorId?: string;
  paper?: PaperGate;
}): OmsPaperVwapApproveResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper VWAP approve');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'vwap') {
    return refuse('not_live', `kind ${String(input.kind)} is not vwap`);
  }
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const volume = parseTargetVolume(input.targetVolume);
  if (!volume.ok) return volume;

  return {
    ok: true,
    approved: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'vwap' },
    status: 'paper',
    targetVolume: volume.text,
  };
}

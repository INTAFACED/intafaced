/**
 * Release leftover residual already on an expired paper VWAP parent.
 * Hands the retained leftover through ledger-client. This door never invents an
 * amount from target volume or the clock, never invents a live venue, and does
 * not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperVwapReleaseResidualRefuseReason =
  'missing_parent' | 'not_live' | 'not_expired' | 'already_released' | 'missing_residual' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperVwapReleaseResidualRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperVwapReleaseResidualRefuseReason;
  readonly detail: string;
};

export type OmsPaperVwapReleaseResidualOk = {
  readonly ok: true;
  readonly released: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'vwap';
  };
  readonly status: 'expired';
  readonly residual: { readonly remaining: string; readonly released: true };
};

export type OmsPaperVwapReleaseResidualResult = OmsPaperVwapReleaseResidualOk | OmsPaperVwapReleaseResidualRefusal;

function refuse(reason: OmsPaperVwapReleaseResidualRefuseReason, detail: string): OmsPaperVwapReleaseResidualRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsPaperVwapReleaseResidualRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from target volume or the clock');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from target volume or the clock');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('missing_residual', 'residual.remaining must be a positive ledger amount — refusing to invent leftover');
    }
    return { ok: true, text: formatAmount(value) };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

/**
 * Release leftover already retained on an expired paper VWAP parent through ledger-client.
 */
export function releaseExpiredPaperVwapResidual(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  remaining?: string | null;
  residualReleased?: boolean;
  paper?: PaperGate;
}): OmsPaperVwapReleaseResidualResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper residual release');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live leftover');
  }
  if (input.kind !== undefined && input.kind !== 'vwap') {
    return refuse('not_live', `kind ${String(input.kind)} is not vwap`);
  }
  const status = input.status?.trim() ?? '';
  if (status !== 'expired') {
    return refuse(
      'not_expired',
      `parent ${parentClientOrderId} is ${status || 'not expired'} — releaseResidual needs an already expired paper parent`,
    );
  }
  if (input.residualReleased === true) {
    return refuse('already_released', `parent ${parentClientOrderId} residual is already released`);
  }

  const leftover = parseRetainedRemaining(input.remaining);
  if (!leftover.ok) return leftover;

  return {
    ok: true,
    released: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'vwap' },
    status: 'expired',
    residual: { remaining: leftover.text, released: true },
  };
}

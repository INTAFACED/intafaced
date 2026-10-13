/**
 * Residual-release leftover already on an expired paper stop-limit parent.
 * Hands the retained leftover through ledger-client. This door never invents an
 * amount from stop, limit, or the clock, never invents a live venue, and does
 * not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PaperGate } from './oms-paper.js';

export type OmsPaperStopLimitReleaseResidualRefuseReason =
  'missing_parent' | 'not_live' | 'not_expired' | 'already_released' | 'missing_residual' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperStopLimitReleaseResidualRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperStopLimitReleaseResidualRefuseReason;
  readonly detail: string;
};

export type OmsPaperStopLimitReleaseResidualOk = {
  readonly ok: true;
  readonly released: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'stop-limit';
  };
  readonly status: 'expired';
  readonly residual: { readonly remaining: string; readonly released: true };
};

export type OmsPaperStopLimitReleaseResidualResult = OmsPaperStopLimitReleaseResidualOk | OmsPaperStopLimitReleaseResidualRefusal;

function refuse(reason: OmsPaperStopLimitReleaseResidualRefuseReason, detail: string): OmsPaperStopLimitReleaseResidualRefusal {
  return { ok: false, reason, detail };
}

function parseRetainedRemaining(raw: string | null | undefined): { ok: true; text: string } | OmsPaperStopLimitReleaseResidualRefusal {
  if (raw === null || raw === undefined) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from stop, limit, or the clock');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from stop, limit, or the clock');
  }
  try {
    return { ok: true, text: formatAmount(parseAmount(text)) };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

/**
 * Residual-release leftover already retained on an expired paper stop-limit parent through ledger-client.
 */
export function releaseExpiredPaperStopLimitResidual(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  remaining?: string | null;
  residualReleased?: boolean;
  paper?: PaperGate;
}): OmsPaperStopLimitReleaseResidualResult {
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
  if (input.kind !== undefined && input.kind !== 'stop-limit') {
    return refuse('not_live', `kind ${String(input.kind)} is not stop-limit`);
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
    parent: { parentClientOrderId, kind: 'stop-limit' },
    status: 'expired',
    residual: { remaining: leftover.text, released: true },
  };
}

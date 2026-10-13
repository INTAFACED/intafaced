/**
 * Expire one live paper bracket parent when its window ends. All three legs cancel.
 * Paper off refuses. Residual stays on the parent. This door never invents expireAt
 * from a leg trigger or the wall clock, never invents a live venue, and does
 * not touch matching.
 */
import type { PaperGate } from './oms-paper.js';

export type OmsPaperBracketExpireRefuseReason =
  'missing_parent' | 'not_live' | 'already_expired' | 'already_stopped' | 'missing_expire_at' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperBracketExpireRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperBracketExpireRefuseReason;
  readonly detail: string;
};

export type OmsPaperBracketExpireOk = {
  readonly ok: true;
  readonly expired: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'bracket';
  };
  readonly status: 'expired';
  readonly expireAt: string;
  /** Always all three — bracket expire never leaves a leftover leg. */
  readonly cancelledLegs: readonly ['entry', 'take_profit', 'stop_loss'];
  readonly residual: { readonly remaining: string | null };
};

export type OmsPaperBracketExpireResult = OmsPaperBracketExpireOk | OmsPaperBracketExpireRefusal;

function refuse(reason: OmsPaperBracketExpireRefuseReason, detail: string): OmsPaperBracketExpireRefusal {
  return { ok: false, reason, detail };
}

function echoRemaining(raw: string | null | undefined): string | null {
  const remaining = raw?.trim() ?? '';
  return remaining || null;
}

function retainedExpireAt(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return trimmed;
}

/**
 * Expire a paper bracket parent using expireAt already retained on the window.
 * All three legs cancel. Residual is not released or consumed. Paper off refuses a live venue.
 */
export function expirePaperBracketParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  expireAt?: string | null;
  remaining?: string | null;
  paper?: PaperGate;
  now?: Date;
}): OmsPaperBracketExpireResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper expire');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }
  if (input.kind !== undefined && input.kind !== 'bracket') {
    return refuse('not_live', `kind ${String(input.kind)} is not bracket`);
  }
  const status = input.status?.trim() ?? '';
  if (status === 'expired') {
    return refuse('already_expired', `parent ${parentClientOrderId} is already expired`);
  }
  if (status === 'stopped') {
    return refuse('already_stopped', `parent ${parentClientOrderId} is already stopped`);
  }
  if (status === 'running') {
    return refuse('not_live', `parent ${parentClientOrderId} is running live — refusing to invent a paper expire over live`);
  }
  if (status !== 'paper') {
    return refuse('not_live', `parent ${parentClientOrderId} is not a paper parent`);
  }

  const expireAt = retainedExpireAt(input.expireAt);
  if (!expireAt) {
    return refuse('missing_expire_at', 'expireAt is missing — refusing to invent a window from a leg trigger or the clock');
  }

  return {
    ok: true,
    expired: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'bracket' },
    status: 'expired',
    expireAt,
    cancelledLegs: ['entry', 'take_profit', 'stop_loss'],
    residual: { remaining: echoRemaining(input.remaining) },
  };
}

/**
 * Expire one live paper OCO parent when its window ends. Both siblings cancel.
 * Paper off refuses. Residual stays on the parent. This door never invents expireAt
 * from a sibling trigger or the wall clock, never invents a live venue, and does
 * not touch matching.
 */
import type { PaperGate } from './oms-paper.js';

export type OmsPaperOcoExpireRefuseReason =
  'missing_parent' | 'not_live' | 'already_expired' | 'already_stopped' | 'missing_expire_at' | 'paper_gate_unwired' | 'paper_off';

export type OmsPaperOcoExpireRefusal = {
  readonly ok: false;
  readonly reason: OmsPaperOcoExpireRefuseReason;
  readonly detail: string;
};

export type OmsPaperOcoExpireOk = {
  readonly ok: true;
  readonly expired: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'oco';
  };
  readonly status: 'expired';
  readonly expireAt: string;
  /** Always both — OCO expire never leaves a one-sided leftover. */
  readonly cancelledSiblings: readonly ['take_profit', 'stop_loss'];
  readonly residual: { readonly remaining: string | null };
};

export type OmsPaperOcoExpireResult = OmsPaperOcoExpireOk | OmsPaperOcoExpireRefusal;

function refuse(reason: OmsPaperOcoExpireRefuseReason, detail: string): OmsPaperOcoExpireRefusal {
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
 * Expire a paper OCO parent using expireAt already retained on the window.
 * Both siblings cancel. Residual is not released or consumed. Paper off refuses a live venue.
 */
export function expirePaperOcoParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  expireAt?: string | null;
  remaining?: string | null;
  paper?: PaperGate;
  now?: Date;
}): OmsPaperOcoExpireResult {
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
  if (input.kind !== undefined && input.kind !== 'oco') {
    return refuse('not_live', `kind ${String(input.kind)} is not oco`);
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
    return refuse('missing_expire_at', 'expireAt is missing — refusing to invent a window from a sibling trigger or the clock');
  }

  return {
    ok: true,
    expired: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'oco' },
    status: 'expired',
    expireAt,
    cancelledSiblings: ['take_profit', 'stop_loss'],
    residual: { remaining: echoRemaining(input.remaining) },
  };
}

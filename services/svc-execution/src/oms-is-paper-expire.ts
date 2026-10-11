/**
 * Expire one paper implementation-shortfall parent on the schedule already retained.
 * Paper off refuses. Residual stays on the parent. This door never invents expireAt
 * from duration, arrival, or the wall clock, never invents a live venue, and does
 * not touch matching.
 */
import type { PaperGate } from './oms-paper.js';

export type OmsIsPaperExpireRefuseReason =
  | 'missing_parent'
  | 'not_live'
  | 'already_expired'
  | 'already_stopped'
  | 'missing_expire_at'
  | 'missing_clock'
  | 'not_due'
  | 'paper_gate_unwired'
  | 'paper_off';

export type OmsIsPaperExpireRefusal = {
  readonly ok: false;
  readonly reason: OmsIsPaperExpireRefuseReason;
  readonly detail: string;
};

export type OmsIsPaperExpireOk = {
  readonly ok: true;
  readonly expired: true;
  readonly paper: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly status: 'expired';
  readonly expireAt: string;
  readonly residual: { readonly remaining: string | null };
};

export type OmsIsPaperExpireResult = OmsIsPaperExpireOk | OmsIsPaperExpireRefusal;

function refuse(reason: OmsIsPaperExpireRefuseReason, detail: string): OmsIsPaperExpireRefusal {
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

function injectedNow(now?: Date): Date | null {
  if (!(now instanceof Date)) return null;
  const ms = now.getTime();
  if (!Number.isFinite(ms)) return null;
  return now;
}

/**
 * Expire a paper IS parent using expireAt already retained on the schedule.
 * The caller supplies now. A missing clock or a now before expireAt refuses.
 * Residual is not released or consumed. Paper off refuses a live venue.
 */
export function expirePaperImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  expireAt?: string | null;
  remaining?: string | null;
  paper?: PaperGate;
  now?: Date;
}): OmsIsPaperExpireResult {
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
  if (input.kind !== undefined && input.kind !== 'implementation_shortfall') {
    return refuse('not_live', `kind ${String(input.kind)} is not implementation_shortfall`);
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
    return refuse('missing_expire_at', 'expireAt is missing — refusing to invent a schedule from duration or the clock');
  }
  const now = injectedNow(input.now);
  if (!now) {
    return refuse('missing_clock', 'now is required — refusing to invent a wall clock');
  }
  if (now.getTime() < Date.parse(expireAt)) {
    return refuse('not_due', `parent ${parentClientOrderId} expires at ${expireAt} — injected clock is not past the deadline`);
  }

  return {
    ok: true,
    expired: true,
    paper: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    status: 'expired',
    expireAt,
    residual: { remaining: echoRemaining(input.remaining) },
  };
}

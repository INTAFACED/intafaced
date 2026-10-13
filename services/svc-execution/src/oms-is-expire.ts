/**
 * Expire one implementation-shortfall parent on the schedule already retained.
 * Residual stays on the parent. This door never invents expireAt from duration,
 * arrival, or the wall clock, and does not touch matching.
 */
import type { ApprovedAlgoParentStore } from './oms-start.js';

export type OmsIsExpireRefuseReason = 'missing_parent' | 'not_live' | 'already_expired' | 'already_stopped' | 'missing_expire_at';

export type OmsIsExpireRefusal = {
  readonly ok: false;
  readonly reason: OmsIsExpireRefuseReason;
  readonly detail: string;
};

export type OmsIsExpireOk = {
  readonly ok: true;
  readonly expired: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly status: 'expired';
  readonly expireAt: string;
  readonly residual: { readonly remaining: string | null };
};

export type OmsIsExpireResult = OmsIsExpireOk | OmsIsExpireRefusal;

function refuse(reason: OmsIsExpireRefuseReason, detail: string): OmsIsExpireRefusal {
  return { ok: false, reason, detail };
}

function parentRemaining(parentStore: ApprovedAlgoParentStore | undefined, parentClientOrderId: string): string | null {
  if (!parentStore) return null;
  const remaining = parentStore.get(parentClientOrderId)?.residual?.remaining?.trim() ?? '';
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
 * Expire an IS parent using expireAt already retained on the schedule.
 * Residual is not released or consumed.
 */
export function expireImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  /** Retained schedule expireAt. Blank refuses — never invent from the clock. */
  expireAt?: string | null;
  parentStore?: ApprovedAlgoParentStore;
  now?: Date;
}): OmsIsExpireResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
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

  const expireAt = retainedExpireAt(input.expireAt);
  if (!expireAt) {
    return refuse('missing_expire_at', 'expireAt is missing — refusing to invent a schedule from duration or the clock');
  }

  const remaining = parentRemaining(input.parentStore, parentClientOrderId);
  return {
    ok: true,
    expired: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    status: 'expired',
    expireAt,
    residual: { remaining },
  };
}

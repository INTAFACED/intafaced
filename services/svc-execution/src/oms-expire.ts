/**
 * Expire one TWAP/VWAP/POV parent on the schedule already on the row.
 *
 * Marks a live (approved or running) parent `expired` using expireAt
 * already retained on the schedule. Paper, staged, and abandoned stay
 * as they are — parentStore.expire is not called. This door never
 * invents expireAt from durationMs, startedAt, or the wall clock,
 * never invents a cancel, and does not touch matching.
 */
import type { AlgoKind, ApprovedAlgoParentStore, RetainedAlgoSchedule } from './oms-start.js';

export type OmsExpireOk = {
  readonly ok: true;
  readonly expired: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly status: 'expired';
  readonly schedule: RetainedAlgoSchedule;
  readonly expireAt: string;
};

export type OmsExpireRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_expire_at'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_expired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_stopped'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'undeployed'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_live'; readonly detail: string };

export type OmsExpireResult = OmsExpireOk | OmsExpireRefuse;

function cloneSchedule(schedule: RetainedAlgoSchedule): RetainedAlgoSchedule {
  return {
    durationMs: schedule.durationMs,
    sliceIntervalMs: schedule.sliceIntervalMs,
    slicesPlanned: schedule.slicesPlanned,
    participationBps: schedule.participationBps,
    ...(schedule.expireAt !== undefined ? { expireAt: schedule.expireAt } : {}),
  };
}

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsExpireRefuse['reason'], detail: string): OmsExpireRefuse {
  return { ok: false, reason, detail };
}

function retainedExpireAt(schedule: RetainedAlgoSchedule): string | null {
  const raw = schedule.expireAt;
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return trimmed;
}

export function expireAlgoParent(input: {
  parentClientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
  now?: Date;
}): OmsExpireResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for expire');
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status === 'expired') {
    return refuse('already_expired', `parent ${parentClientOrderId} is already expired`);
  }
  if (existing.status === 'stopped') {
    return refuse('already_stopped', `parent ${parentClientOrderId} is already stopped`);
  }
  if (existing.status === 'undeployed') {
    return refuse('undeployed', `parent ${parentClientOrderId} is undeployed`);
  }
  if (existing.status !== 'approved' && existing.status !== 'running') {
    return refuse('not_live', `parent ${parentClientOrderId} is ${existing.status} — expire needs a live (approved or running) parent`);
  }

  const expireAt = retainedExpireAt(existing.schedule);
  if (!expireAt) {
    return refuse('missing_expire_at', 'schedule.expireAt is missing — refusing to invent expireAt from duration or the clock');
  }

  const expired = input.parentStore.expire(parentClientOrderId);
  if (!expired) {
    return refuse('missing_expire_at', 'schedule.expireAt is missing — refusing to invent expireAt from duration or the clock');
  }

  return {
    ok: true,
    expired: true,
    parent: { parentClientOrderId: expired.parentClientOrderId, kind: expired.kind },
    status: 'expired',
    schedule: cloneSchedule(expired.schedule),
    expireAt,
  };
}

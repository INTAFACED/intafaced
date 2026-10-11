/**
 * Run one approved TWAP/VWAP/POV parent in paper.
 *
 * Marks an approved (or already paper) parent `paper` using the schedule
 * already on the row. This door never submits, places, or invents a child,
 * never invents a venue, never releases residual, and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore, RetainedAlgoSchedule } from './oms-start.js';

export type PaperGate = { readonly enabled: boolean };

export type OmsPaperOk = {
  readonly ok: true;
  readonly paper: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly status: 'paper';
  readonly schedule: RetainedAlgoSchedule;
  readonly children: readonly [];
  readonly residual: { readonly remaining: string; readonly released: false } | null;
};

export type OmsPaperRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper_gate_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper_off'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_schedule'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_residual'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_approved'; readonly detail: string };

export type OmsPaperResult = OmsPaperOk | OmsPaperRefuse;

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

function refuse(reason: OmsPaperRefuse['reason'], detail: string): OmsPaperRefuse {
  return { ok: false, reason, detail };
}

function scheduleMissing(parent: ApprovedAlgoParent): boolean {
  const { durationMs, sliceIntervalMs, slicesPlanned, participationBps } = parent.schedule;
  if (!(durationMs > 0) || !(sliceIntervalMs > 0) || slicesPlanned < 1) return true;
  if (parent.kind === 'pov' && (participationBps === null || !Number.isInteger(participationBps))) return true;
  return false;
}

function retainedRemaining(parent: ApprovedAlgoParent): string | null {
  const residual = parent.residual;
  if (residual == null) return null;
  const raw = residual.remaining;
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function echoRetainedResidual(parent: ApprovedAlgoParent): OmsPaperOk['residual'] | OmsPaperRefuse {
  const remaining = retainedRemaining(parent);
  if (!remaining) return null;
  try {
    return { remaining: formatAmount(parseAmount(remaining)), released: false };
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
}

export function paperRunAlgoParent(input: {
  parentClientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
  paper?: PaperGate;
}): OmsPaperResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for paper');
  }
  if (!input.paper) {
    return refuse('paper_gate_unwired', 'paper gate is required for paper');
  }
  if (input.paper.enabled === false) {
    return refuse('paper_off', 'paper is off — refusing to invent a live venue or a live child');
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status !== 'approved' && existing.status !== 'paper') {
    return refuse('not_approved', `parent ${parentClientOrderId} is not approved`);
  }
  if (scheduleMissing(existing)) {
    return refuse('missing_schedule', 'retained schedule is incomplete — refusing to invent slices');
  }
  if (!input.parentStore.paper) {
    return refuse('parent_store_unwired', 'approved algo parent store.paper is required for paper');
  }

  const residual = echoRetainedResidual(existing);
  if (residual !== null && 'ok' in residual) return residual;

  const papered = input.parentStore.paper(parentClientOrderId);
  if (!papered) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }

  return {
    ok: true,
    paper: true,
    parent: { parentClientOrderId: papered.parentClientOrderId, kind: papered.kind },
    status: 'paper',
    schedule: cloneSchedule(papered.schedule),
    children: [],
    residual,
  };
}

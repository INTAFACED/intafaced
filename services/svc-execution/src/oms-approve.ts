/**
 * Approve one TWAP/VWAP/POV parent so it can start.
 *
 * Records an approved parent from a retained schedule, or re-approves an
 * undeployed parent using the schedule already on the row. This door never
 * plans slices, never starts the parent, never places children, and does
 * not touch matching. Matching halt-all (`venueHalted`) refuses — missing
 * halt source refuses; never invent live.
 */
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';
import type { AlgoJobsGate, AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore, RetainedAlgoSchedule } from './oms-start.js';

export type OmsApproveOk = {
  readonly ok: true;
  readonly approved: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly status: 'approved';
  readonly schedule: RetainedAlgoSchedule;
};

export type OmsApproveRefuse =
  | { readonly ok: false; readonly reason: 'parent_only'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'jobs_gate_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'jobs_off'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_schedule'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_approved'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_started'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_undeployed'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_operator'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_owner'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'venue_halted'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'venue_halt_unavailable'; readonly detail: string };

export type OmsApproveResult = OmsApproveOk | OmsApproveRefuse;

function cloneSchedule(schedule: RetainedAlgoSchedule): RetainedAlgoSchedule {
  return {
    durationMs: schedule.durationMs,
    sliceIntervalMs: schedule.sliceIntervalMs,
    slicesPlanned: schedule.slicesPlanned,
    participationBps: schedule.participationBps,
  };
}

function isAlgoKind(kind: string | undefined): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsApproveRefuse['reason'], detail: string): OmsApproveRefuse {
  return { ok: false, reason, detail };
}

function operatorOf(operatorId?: string): string {
  return operatorId?.trim() ?? '';
}

function ownerOf(parent: ApprovedAlgoParent): string | null {
  const owner = parent.executionOwner?.trim() ?? '';
  return owner || null;
}

function scheduleMissing(kind: AlgoKind, schedule: RetainedAlgoSchedule | undefined): boolean {
  if (!schedule) return true;
  const { durationMs, sliceIntervalMs, slicesPlanned, participationBps } = schedule;
  // Comparisons alone treat NaN, Infinity, and 1.5 as present, and Infinity > 0.
  if (
    !Number.isFinite(durationMs) ||
    !(durationMs > 0) ||
    !Number.isFinite(sliceIntervalMs) ||
    !(sliceIntervalMs > 0) ||
    !Number.isInteger(slicesPlanned) ||
    slicesPlanned < 1
  ) {
    return true;
  }
  if (kind === 'pov' && (participationBps === null || !Number.isInteger(participationBps) || participationBps < 0)) {
    return true;
  }
  return false;
}

export function approveAlgoParent(input: {
  parentClientOrderId?: string;
  executionGroupId?: string;
  operatorId?: string;
  kind?: string;
  schedule?: RetainedAlgoSchedule;
  parentStore?: ApprovedAlgoParentStore;
  jobs?: AlgoJobsGate;
  matchingVenueHalt?: MatchingVenueHalt | null;
}): OmsApproveResult {
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (executionGroupId) {
    return refuse('parent_only', 'approve exactly one parentClientOrderId');
  }
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for approve');
  }
  if (!input.jobs) {
    return refuse('jobs_gate_unwired', 'algo jobs gate is required for approve');
  }
  if (input.jobs.enabled === false) {
    return refuse('jobs_off', 'EXECUTION_ALGO_JOBS_ENABLED is off — refusing to invent an approval');
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (existing) {
    if (!isAlgoKind(existing.kind)) {
      return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
    }
    if (existing.status === 'approved') {
      return refuse('already_approved', `parent ${parentClientOrderId} is already approved`);
    }
    if (existing.status === 'running') {
      return refuse('already_started', `parent ${parentClientOrderId} is already running`);
    }
    if (existing.status !== 'undeployed') {
      return refuse('not_undeployed', `parent ${parentClientOrderId} is ${existing.status} — approve needs undeployed or new`);
    }
    if (scheduleMissing(existing.kind, existing.schedule)) {
      return refuse('missing_schedule', 'retained schedule is incomplete — refusing to invent slices');
    }
    const operatorId = operatorOf(input.operatorId);
    if (!operatorId) {
      return refuse('missing_operator', 'operator id is required — refusing to invent a user');
    }
    const current = ownerOf(existing);
    if (current && current !== operatorId) {
      return refuse('not_owner', `parent ${parentClientOrderId} is owned by ${current} — refusing steal`);
    }
    const haltExisting = matchingVenueHaltRefuse(input.matchingVenueHalt);
    if (haltExisting) return haltExisting;
    const originator = existing.originator?.trim() || operatorId;
    const approved = input.parentStore.approve({
      parentClientOrderId: existing.parentClientOrderId,
      kind: existing.kind,
      status: 'approved',
      schedule: cloneSchedule(existing.schedule),
      startedAt: null,
      executionOwner: operatorId,
      originator,
    });
    return {
      ok: true,
      approved: true,
      parent: { parentClientOrderId: approved.parentClientOrderId, kind: approved.kind },
      status: 'approved',
      schedule: cloneSchedule(approved.schedule),
    };
  }

  if (!isAlgoKind(input.kind)) {
    if (input.kind === undefined || input.kind === '') {
      return refuse('missing_kind', 'kind is required to approve a new parent');
    }
    return refuse('unsupported_kind', `kind ${String(input.kind)} is not twap|vwap|pov`);
  }
  if (scheduleMissing(input.kind, input.schedule)) {
    return refuse('missing_schedule', 'retained schedule is incomplete — refusing to invent slices');
  }
  const operatorId = operatorOf(input.operatorId);
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  const approved = input.parentStore.approve({
    parentClientOrderId,
    kind: input.kind,
    status: 'approved',
    schedule: cloneSchedule(input.schedule!),
    startedAt: null,
    executionOwner: operatorId,
    originator: operatorId,
  });
  return {
    ok: true,
    approved: true,
    parent: { parentClientOrderId: approved.parentClientOrderId, kind: approved.kind },
    status: 'approved',
    schedule: cloneSchedule(approved.schedule),
  };
}

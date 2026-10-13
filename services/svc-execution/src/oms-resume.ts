/**
 * Resume one paused algo — children may take new again.
 *
 * Lifts the pause mark on one parent or group. Existing children stay
 * as EMS recorded them. This door never invents a canceled order and
 * does not touch matching.
 */
import type { EmsOrderEvidence, EmsOrderStore } from './oms-ems-store.js';
import type { AlgoPauseKey, AlgoPauseStore } from './oms-pause.js';

export type OmsResumeInput = {
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly emsStore?: EmsOrderStore;
  readonly pauseStore?: AlgoPauseStore;
};

export type OmsResumeChildOutcome = 'live' | 'unknown' | 'already_stopped';

export type OmsResumeChild = {
  readonly clientOrderId: string;
  readonly venueId: string;
  readonly outcome: OmsResumeChildOutcome;
  readonly status?: string;
  readonly reason?: string;
};

export type OmsResumeOk = {
  readonly ok: true;
  readonly algo: { readonly parentClientOrderId?: string; readonly executionGroupId?: string };
  readonly paused: false;
  readonly children: readonly OmsResumeChild[];
};

export type OmsResumeRefuse =
  | { readonly ok: false; readonly reason: 'missing_algo'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ambiguous_algo'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_paused'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'pause_store_unwired'; readonly detail: string };

export type OmsResumeResult = OmsResumeOk | OmsResumeRefuse;

function alreadyStopped(row: EmsOrderEvidence): boolean {
  return row.state === 'REJECTED' || row.state === 'UNWIRED';
}

function childOutcome(row: EmsOrderEvidence): OmsResumeChild {
  if (alreadyStopped(row)) {
    return {
      clientOrderId: row.clientOrderId,
      venueId: row.venueId,
      outcome: 'already_stopped',
      reason: row.state,
    };
  }
  if (row.state === 'SUBMIT_UNKNOWN' || row.state === 'OUTCOME_UNKNOWN' || row.execution === null) {
    return {
      clientOrderId: row.clientOrderId,
      venueId: row.venueId,
      outcome: 'unknown',
      reason: row.state ?? 'no_execution',
    };
  }
  if (row.execution.status === 'rejected') {
    return {
      clientOrderId: row.clientOrderId,
      venueId: row.venueId,
      outcome: 'already_stopped',
      status: row.execution.status,
    };
  }
  return {
    clientOrderId: row.clientOrderId,
    venueId: row.venueId,
    outcome: 'live',
    status: row.execution.status,
  };
}

export function resumeInFlightAlgo(input: OmsResumeInput): OmsResumeResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (parentClientOrderId && executionGroupId) {
    return { ok: false, reason: 'ambiguous_algo', detail: 'resume exactly one parentClientOrderId or one executionGroupId' };
  }
  if (!parentClientOrderId && !executionGroupId) {
    return { ok: false, reason: 'missing_algo', detail: 'parentClientOrderId or executionGroupId is required' };
  }
  if (!input.emsStore) {
    return { ok: false, reason: 'ems_store_unwired', detail: 'EMS evidence store is required for algo resume' };
  }
  if (!input.pauseStore) {
    return { ok: false, reason: 'pause_store_unwired', detail: 'pause store is required for algo resume' };
  }

  const key: AlgoPauseKey = parentClientOrderId ? { kind: 'parent', id: parentClientOrderId } : { kind: 'group', id: executionGroupId };
  const wasPaused = input.pauseStore.resume(key);
  if (!wasPaused) {
    return { ok: false, reason: 'not_paused', detail: 'algo is not paused — refusing to invent a resume' };
  }

  const rows = input.emsStore.list(parentClientOrderId ? { parentClientOrderId } : { executionGroupId });
  return {
    ok: true,
    algo: parentClientOrderId ? { parentClientOrderId } : { executionGroupId },
    paused: false,
    children: rows.map(childOutcome),
  };
}

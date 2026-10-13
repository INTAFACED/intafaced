/**
 * Pause one in-flight algo — children take no new.
 *
 * Marks the parent or group so execute refuses a new child.
 * Existing children stay as EMS recorded them. This door never
 * invents a canceled order and does not touch matching.
 */
import type { EmsOrderEvidence, EmsOrderStore } from './oms-ems-store.js';

export type AlgoPauseKey = { readonly kind: 'parent'; readonly id: string } | { readonly kind: 'group'; readonly id: string };

export type AlgoPauseIds = {
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
};

export interface AlgoPauseStore {
  pause(key: AlgoPauseKey): boolean;
  resume(key: AlgoPauseKey): boolean;
  isPaused(ids: AlgoPauseIds): boolean;
}

export class InMemoryAlgoPauseStore implements AlgoPauseStore {
  private readonly parents = new Set<string>();
  private readonly groups = new Set<string>();

  pause(key: AlgoPauseKey): boolean {
    const bucket = key.kind === 'parent' ? this.parents : this.groups;
    if (bucket.has(key.id)) return false;
    bucket.add(key.id);
    return true;
  }

  resume(key: AlgoPauseKey): boolean {
    const bucket = key.kind === 'parent' ? this.parents : this.groups;
    return bucket.delete(key.id);
  }

  isPaused(ids: AlgoPauseIds): boolean {
    const parent = ids.parentClientOrderId?.trim() ?? '';
    const group = ids.executionGroupId?.trim() ?? '';
    return (parent !== '' && this.parents.has(parent)) || (group !== '' && this.groups.has(group));
  }
}

export type OmsPauseInput = {
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly emsStore?: EmsOrderStore;
  readonly pauseStore?: AlgoPauseStore;
};

export type OmsPauseChildOutcome = 'live' | 'unknown' | 'already_stopped';

export type OmsPauseChild = {
  readonly clientOrderId: string;
  readonly venueId: string;
  readonly outcome: OmsPauseChildOutcome;
  readonly status?: string;
  readonly reason?: string;
};

export type OmsPauseOk = {
  readonly ok: true;
  readonly algo: { readonly parentClientOrderId?: string; readonly executionGroupId?: string };
  readonly paused: true;
  readonly alreadyPaused: boolean;
  readonly children: readonly OmsPauseChild[];
};

export type OmsPauseRefuse =
  | { readonly ok: false; readonly reason: 'missing_algo'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ambiguous_algo'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'pause_store_unwired'; readonly detail: string };

export type OmsPauseResult = OmsPauseOk | OmsPauseRefuse;

function alreadyStopped(row: EmsOrderEvidence): boolean {
  return row.state === 'REJECTED' || row.state === 'UNWIRED';
}

function childOutcome(row: EmsOrderEvidence): OmsPauseChild {
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
  return {
    clientOrderId: row.clientOrderId,
    venueId: row.venueId,
    outcome: 'live',
    status: row.execution.status,
  };
}

export function pauseInFlightAlgo(input: OmsPauseInput): OmsPauseResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (parentClientOrderId && executionGroupId) {
    return { ok: false, reason: 'ambiguous_algo', detail: 'pause exactly one parentClientOrderId or one executionGroupId' };
  }
  if (!parentClientOrderId && !executionGroupId) {
    return { ok: false, reason: 'missing_algo', detail: 'parentClientOrderId or executionGroupId is required' };
  }
  if (!input.emsStore) {
    return { ok: false, reason: 'ems_store_unwired', detail: 'EMS evidence store is required for algo pause' };
  }
  if (!input.pauseStore) {
    return { ok: false, reason: 'pause_store_unwired', detail: 'pause store is required for algo pause' };
  }

  const key: AlgoPauseKey = parentClientOrderId ? { kind: 'parent', id: parentClientOrderId } : { kind: 'group', id: executionGroupId };
  const newlyPaused = input.pauseStore.pause(key);
  const rows = input.emsStore.list(parentClientOrderId ? { parentClientOrderId } : { executionGroupId });

  return {
    ok: true,
    algo: parentClientOrderId ? { parentClientOrderId } : { executionGroupId },
    paused: true,
    alreadyPaused: !newlyPaused,
    children: rows.map(childOutcome),
  };
}

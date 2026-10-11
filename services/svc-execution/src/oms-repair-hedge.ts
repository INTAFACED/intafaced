/**
 * Repair one failed hedge child — residual stays on the parent.
 *
 * Accepts a failed EMS hedge child under that parent. This door never
 * submits, never plans a replacement hedge, never invents venue/side/
 * amount/price, and does not touch matching.
 */
import { add, formatAmount, type Amount } from '@intafaced/ledger-client';
import { isFailedHedge } from './oms-failed-hedges.js';
import type { EmsOrderEvidence, EmsOrderStore } from './oms-ems-store.js';

export type OmsRepairHedgeInput = {
  readonly parentClientOrderId?: string;
  readonly clientOrderId?: string;
  readonly executionGroupId?: string;
  readonly emsStore?: EmsOrderStore;
};

export type OmsRepairHedgeResidual = {
  readonly filled: string | null;
  readonly remaining: string | null;
};

export type OmsRepairHedgeOk = {
  readonly ok: true;
  readonly repaired: true;
  readonly parent: { readonly parentClientOrderId: string };
  readonly child: {
    readonly clientOrderId: string;
    readonly venueId: string;
    readonly outcome: 'repaired';
    readonly reason: string;
  };
  readonly residual: OmsRepairHedgeResidual;
};

export type OmsRepairHedgeRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_child'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_only'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'no_ems_evidence'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_parent_child'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_failed'; readonly detail: string };

export type OmsRepairHedgeResult = OmsRepairHedgeOk | OmsRepairHedgeRefuse;

function refuse(reason: OmsRepairHedgeRefuse['reason'], detail: string): OmsRepairHedgeRefuse {
  return { ok: false, reason, detail };
}

function failureReason(row: EmsOrderEvidence): string {
  if (row.state === 'REJECTED' || row.state === 'UNWIRED') return row.state;
  if (row.execution?.status === 'rejected') return 'rejected';
  if (row.commandOutcome?.outcome === 'REFUSED') return 'REFUSED';
  return row.state ?? 'failed';
}

function parentResidual(rows: readonly EmsOrderEvidence[]): OmsRepairHedgeResidual {
  let filled: Amount | null = null;
  for (const row of rows) {
    if (row.state === 'SUBMIT_UNKNOWN' || row.state === 'OUTCOME_UNKNOWN' || row.execution === null) {
      continue;
    }
    const amount = row.execution.filledAmount;
    filled = filled === null ? amount : add(filled, amount);
  }
  if (filled === null) return { filled: null, remaining: null };
  return { filled: formatAmount(filled), remaining: null };
}

export function repairFailedHedgeChild(input: OmsRepairHedgeInput): OmsRepairHedgeResult {
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (executionGroupId) {
    return refuse('parent_only', 'repair exactly one failed hedge child on one parentClientOrderId');
  }
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  const clientOrderId = input.clientOrderId?.trim() ?? '';
  if (!clientOrderId) {
    return refuse('missing_child', 'clientOrderId of the failed hedge child is required');
  }
  if (!input.emsStore) {
    return refuse('ems_store_unwired', 'EMS evidence store is required to repair a failed hedge child');
  }

  const child = input.emsStore.get(clientOrderId);
  if (!child) {
    return refuse('no_ems_evidence', 'no EMS journal row for this hedge child — refusing to invent a hedge');
  }
  if (child.parentClientOrderId !== parentClientOrderId) {
    return refuse('not_parent_child', `child ${clientOrderId} is not under parent ${parentClientOrderId}`);
  }
  if (!isFailedHedge(child)) {
    return refuse(
      'not_failed',
      `child ${clientOrderId} is ${child.state ?? child.execution?.status ?? 'unknown'} — repair needs a failed hedge child`,
    );
  }

  const siblings = input.emsStore.list({ parentClientOrderId });
  return {
    ok: true,
    repaired: true,
    parent: { parentClientOrderId },
    child: {
      clientOrderId: child.clientOrderId,
      venueId: child.venueId,
      outcome: 'repaired',
      reason: failureReason(child),
    },
    residual: parentResidual(siblings),
  };
}

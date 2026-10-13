/**
 * Attribute child fills to one parent — the parent residual updates.
 *
 * Sums confirmed EMS child fills onto that parent. No parent quantity
 * is loaded, so remaining stays unknown: a full child set is not a
 * finished parent, and a rejected child with no execution is not a
 * zero leftover. Partial and unknown children stay unknown too.
 * This door never invents a fill and does not touch matching.
 */
import { add, formatAmount, ZERO, type Amount } from '@intafaced/ledger-client';
import type { EmsOrderEvidence, EmsOrderStore } from './oms-ems-store.js';

export type OmsAttributeInput = {
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly emsStore?: EmsOrderStore;
};

export type OmsAttributeChildOutcome = 'attributed' | 'unknown' | 'already_stopped';

export type OmsAttributeChild = {
  readonly clientOrderId: string;
  readonly venueId: string;
  readonly outcome: OmsAttributeChildOutcome;
  readonly filled?: string;
  readonly status?: string;
  readonly reason?: string;
};

export type OmsAttributeResidual = {
  readonly filled: string;
  readonly remaining: string | null;
};

export type OmsAttributeOk = {
  readonly ok: true;
  readonly parent: { readonly parentClientOrderId: string };
  readonly children: readonly OmsAttributeChild[];
  readonly residual: OmsAttributeResidual;
};

export type OmsAttributeRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_only'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'no_ems_evidence'; readonly detail: string };

export type OmsAttributeResult = OmsAttributeOk | OmsAttributeRefuse;

function alreadyStopped(row: EmsOrderEvidence): boolean {
  return row.state === 'REJECTED' || row.state === 'UNWIRED';
}

export function attributeChildFillsToParent(input: OmsAttributeInput): OmsAttributeResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (executionGroupId) {
    return {
      ok: false,
      reason: 'parent_only',
      detail: 'attribute child fills to exactly one parentClientOrderId',
    };
  }
  if (!parentClientOrderId) {
    return { ok: false, reason: 'missing_parent', detail: 'parentClientOrderId is required' };
  }
  if (!input.emsStore) {
    return { ok: false, reason: 'ems_store_unwired', detail: 'EMS evidence store is required for parent fill attribution' };
  }

  const rows = input.emsStore.list({ parentClientOrderId });
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'no_ems_evidence',
      detail: 'no EMS journal rows for this parent — refusing to invent fills',
    };
  }

  const children: OmsAttributeChild[] = [];
  let filled: Amount = ZERO;
  let unknown = false;

  for (const row of rows) {
    if (alreadyStopped(row)) {
      children.push({
        clientOrderId: row.clientOrderId,
        venueId: row.venueId,
        outcome: 'already_stopped',
        reason: row.state,
      });
      continue;
    }
    if (row.state === 'SUBMIT_UNKNOWN' || row.state === 'OUTCOME_UNKNOWN' || row.execution === null) {
      unknown = true;
      children.push({
        clientOrderId: row.clientOrderId,
        venueId: row.venueId,
        outcome: 'unknown',
        reason: row.state ?? 'no_execution',
      });
      continue;
    }
    if (row.execution.status === 'rejected') {
      children.push({
        clientOrderId: row.clientOrderId,
        venueId: row.venueId,
        outcome: 'already_stopped',
        status: row.execution.status,
      });
      continue;
    }
    if (row.execution.status === 'partial') {
      unknown = true;
    }
    filled = add(filled, row.execution.filledAmount);
    children.push({
      clientOrderId: row.clientOrderId,
      venueId: row.venueId,
      outcome: 'attributed',
      filled: formatAmount(row.execution.filledAmount),
      status: row.execution.status,
    });
  }

  const filledText = formatAmount(filled);
  if (unknown) {
    return {
      ok: true,
      parent: { parentClientOrderId },
      children,
      residual: { filled: filledText, remaining: null },
    };
  }
  // No parent quantity was loaded. Do not invent a zero leftover.
  return {
    ok: true,
    parent: { parentClientOrderId },
    children,
    residual: { filled: filledText, remaining: null },
  };
}

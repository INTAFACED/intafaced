/**
 * List orphaned EMS child fills and assign one to a live TWAP/VWAP/POV parent.
 *
 * Desk recovery door. Fill facts come from EMS only — this never invents a
 * print, never posts ledger, never touches matching, and never auto-confirms.
 * Assignment is one-shot: a child that already has a parent in the approved
 * store refuses. Parent remaining is a hard cap — missing leftover refuses
 * rather than inventing unlimited size. Manual prints are a separate book
 * and stay off this list.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { EmsOrderStore } from './oms-ems-store.js';
import { fillFacts, type ChildFillFacts } from './oms-fill-confirm.js';
import { capAgainstParentRemaining, consumeCappedRemaining } from './oms-parent-cap.js';
import type { AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';

export type OrphanedChildFill = ChildFillFacts & {
  readonly parentClientOrderId: string | null;
};

export type OmsOrphanedOk = {
  readonly ok: true;
  readonly fills: readonly OrphanedChildFill[];
};

export type OmsOrphanedRefuse =
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string };

export type OmsOrphanedResult = OmsOrphanedOk | OmsOrphanedRefuse;

export type OmsAssignOk = {
  readonly ok: true;
  readonly assigned: true;
  readonly confirmed: false;
  readonly clientAccepted: false;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: AlgoKind;
    readonly status: 'approved' | 'running';
  };
  readonly child: { readonly clientOrderId: string };
  readonly fill: ChildFillFacts;
  readonly operatorId: string;
  readonly residual: { readonly remaining: string };
};

export type OmsAssignRefuse =
  | { readonly ok: false; readonly reason: 'missing_operator'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_live'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_child'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_fill'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_assigned'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_residual'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'exceeds_remaining'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'non_positive_qty'; readonly detail: string };

export type OmsAssignResult = OmsAssignOk | OmsAssignRefuse;

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function liveStatus(status: string): status is 'approved' | 'running' {
  return status === 'approved' || status === 'running';
}

function refuse<R extends string>(reason: R, detail: string): { ok: false; reason: R; detail: string } {
  return { ok: false, reason, detail };
}

function parentIdOf(value: string | undefined): string {
  return value?.trim() ?? '';
}

function liveParentInStore(parentStore: ApprovedAlgoParentStore, parentClientOrderId: string): boolean {
  const id = parentIdOf(parentClientOrderId);
  if (!id) return false;
  return parentStore.get(id) != null;
}

export function listOrphanedChildFills(input: { parentStore?: ApprovedAlgoParentStore; emsStore?: EmsOrderStore }): OmsOrphanedResult {
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for orphaned list');
  }
  if (!input.emsStore || typeof input.emsStore.list !== 'function') {
    return refuse('ems_store_unwired', 'EMS evidence store.list is required for orphaned list');
  }

  const fills: OrphanedChildFill[] = [];
  for (const row of input.emsStore.list()) {
    const facts = fillFacts(row);
    if (!facts) continue;
    const owner = parentIdOf(row.parentClientOrderId);
    if (owner && liveParentInStore(input.parentStore, owner)) continue;
    fills.push({
      ...facts,
      parentClientOrderId: owner || null,
    });
  }
  fills.sort((a, b) => (a.clientOrderId < b.clientOrderId ? -1 : a.clientOrderId > b.clientOrderId ? 1 : 0));
  return { ok: true, fills };
}

export function assignOrphanedChildFill(input: {
  parentClientOrderId?: string;
  clientOrderId?: string;
  operatorId?: string;
  parentStore?: ApprovedAlgoParentStore;
  emsStore?: EmsOrderStore;
}): OmsAssignResult {
  const operatorId = input.operatorId?.trim() ?? '';
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const parentClientOrderId = parentIdOf(input.parentClientOrderId);
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for fill assign');
  }
  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status === 'paper') {
    return refuse('paper', `parent ${parentClientOrderId} is paper — refusing to assign a paper child fill`);
  }
  if (!liveStatus(existing.status)) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${existing.status} — assign needs a live (approved or running) parent`);
  }

  const clientOrderId = input.clientOrderId?.trim() ?? '';
  if (!clientOrderId) {
    return refuse('missing_child', 'clientOrderId is required — refusing to invent a child fill');
  }
  if (!input.emsStore) {
    return refuse('ems_store_unwired', 'EMS evidence store is required for fill assign');
  }
  const row = input.emsStore.get(clientOrderId);
  const facts = row ? fillFacts(row) : null;
  if (!row || !facts) {
    return refuse('missing_fill', `no child fill evidence for ${clientOrderId} — refusing to invent a fill from residual or schedule`);
  }

  const currentOwner = parentIdOf(row.parentClientOrderId);
  if (currentOwner && liveParentInStore(input.parentStore, currentOwner)) {
    return refuse(
      'already_assigned',
      `child fill ${clientOrderId} already belongs to ${currentOwner} — refusing to rewrite the parent trail`,
    );
  }

  let filledAmt;
  try {
    filledAmt = parseAmount(facts.filledAmount);
  } catch {
    return refuse('missing_fill', `no child fill evidence for ${clientOrderId} — refusing to invent a fill from residual or schedule`);
  }
  const cap = capAgainstParentRemaining(existing, filledAmt, 'fill');
  if (!cap.ok) return cap;
  const consumed = consumeCappedRemaining(input.parentStore, parentClientOrderId, cap.nextRemaining);
  if (!consumed.ok) return consumed;

  input.emsStore.record({
    ...row,
    parentClientOrderId,
  });

  return {
    ok: true,
    assigned: true,
    confirmed: false,
    clientAccepted: false,
    parent: {
      parentClientOrderId: existing.parentClientOrderId,
      kind: existing.kind,
      status: existing.status,
    },
    child: { clientOrderId: facts.clientOrderId },
    fill: facts,
    operatorId,
    residual: { remaining: consumed.remaining },
  };
}

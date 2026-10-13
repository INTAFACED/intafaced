/**
 * List unconfirmed EMS child fills on a live TWAP/VWAP/POV parent.
 *
 * Desk dashboard door. EMS fill evidence must already exist — this never
 * invents a fill, never posts ledger, never touches matching, and never
 * auto-confirms. Manual prints are a separate book and stay off this list.
 * Originator/owner are copied from the parent as stored, never invented.
 */
import type { EmsOrderStore } from './oms-ems-store.js';
import { fillFacts, type ChildFillFacts, type FillConfirmStore } from './oms-fill-confirm.js';
import type { AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';

export type UnconfirmedChildFill = ChildFillFacts & {
  readonly confirmed: false;
  readonly clientAccepted: false;
  readonly confirmerId: null;
  readonly confirmedAt: null;
};

export type OmsUnconfirmedOk = {
  readonly ok: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: AlgoKind;
    readonly status: 'approved' | 'running';
    readonly executionOwner: string | null;
    readonly originator: string | null;
  };
  readonly fills: readonly UnconfirmedChildFill[];
};

export type OmsUnconfirmedRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_live'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'fill_store_unwired'; readonly detail: string };

export type OmsUnconfirmedResult = OmsUnconfirmedOk | OmsUnconfirmedRefuse;

export type OmsUnconfirmedHandoffRefuse =
  OmsUnconfirmedRefuse | { readonly ok: false; readonly reason: 'unconfirmed_fills'; readonly detail: string };

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function liveStatus(status: string): status is 'approved' | 'running' {
  return status === 'approved' || status === 'running';
}

function refuse(reason: OmsUnconfirmedRefuse['reason'], detail: string): OmsUnconfirmedRefuse {
  return { ok: false, reason, detail };
}

function ownerOf(parent: ApprovedAlgoParent): string | null {
  const owner = parent.executionOwner?.trim() ?? '';
  return owner || null;
}

function originatorOf(parent: ApprovedAlgoParent): string | null {
  const originator = parent.originator?.trim() ?? '';
  return originator || null;
}

export function listUnconfirmedChildFills(input: {
  parentClientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
  emsStore?: EmsOrderStore;
  fillConfirmStore?: FillConfirmStore;
}): OmsUnconfirmedResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for unconfirmed list');
  }
  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status === 'paper') {
    return refuse('paper', `parent ${parentClientOrderId} is paper — refusing to list paper child fills`);
  }
  if (!liveStatus(existing.status)) {
    return refuse(
      'not_live',
      `parent ${parentClientOrderId} is ${existing.status} — unconfirmed list needs a live (approved or running) parent`,
    );
  }
  if (!input.emsStore || typeof input.emsStore.list !== 'function') {
    return refuse('ems_store_unwired', 'EMS evidence store.list is required for unconfirmed list');
  }
  if (!input.fillConfirmStore || typeof input.fillConfirmStore.get !== 'function') {
    return refuse('fill_store_unwired', 'fill confirm store is required for unconfirmed list');
  }

  const fills: UnconfirmedChildFill[] = [];
  for (const row of input.emsStore.list({ parentClientOrderId })) {
    const facts = fillFacts(row);
    if (!facts) continue;
    const owner = row.parentClientOrderId?.trim() ?? '';
    if (owner !== parentClientOrderId) continue;
    if (input.fillConfirmStore.get(facts.clientOrderId)) continue;
    fills.push({
      ...facts,
      confirmed: false,
      clientAccepted: false,
      confirmerId: null,
      confirmedAt: null,
    });
  }
  fills.sort((a, b) => (a.clientOrderId < b.clientOrderId ? -1 : a.clientOrderId > b.clientOrderId ? 1 : 0));
  return {
    ok: true,
    parent: {
      parentClientOrderId: existing.parentClientOrderId,
      kind: existing.kind,
      status: existing.status,
      executionOwner: ownerOf(existing),
      originator: originatorOf(existing),
    },
    fills,
  };
}

/** Same EMS+confirm book as the unconfirmed list. Never invents a fill or a confirm. */
export function refuseUnconfirmedHandoff(
  input: {
    parentClientOrderId?: string;
    parentStore?: ApprovedAlgoParentStore;
    emsStore?: EmsOrderStore;
    fillConfirmStore?: FillConfirmStore;
  },
  action: 'pass' | 'shift' | 'accept',
): { readonly ok: true } | OmsUnconfirmedHandoffRefuse {
  const listed = listUnconfirmedChildFills(input);
  if (!listed.ok) return listed;
  if (listed.fills.length === 0) return { ok: true };
  return {
    ok: false,
    reason: 'unconfirmed_fills',
    detail: `parent ${listed.parent.parentClientOrderId} has unconfirmed EMS child fills — confirm them before ${action}`,
  };
}

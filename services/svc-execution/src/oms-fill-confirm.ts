/**
 * Confirm one child fill on a live TWAP/VWAP/POV parent.
 *
 * Operator door with an append-only confirmer trail. EMS fill evidence
 * must already exist — this door never invents a fill from residual,
 * duration, or slicesPlanned, never posts ledger value, and does not
 * touch matching. An unconfirmed child fill is never client-accepted.
 */
import { formatAmount, isNegative, isZero } from '@intafaced/ledger-client';
import type { EmsOrderEvidence, EmsOrderStore } from './oms-ems-store.js';
import type { AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';

export type ChildFillConfirmation = {
  readonly clientOrderId: string;
  readonly parentClientOrderId: string;
  readonly confirmerId: string;
  readonly confirmedAt: string;
};

export interface FillConfirmStore {
  get(clientOrderId: string): ChildFillConfirmation | null;
  /** Append-only. Returns null when that child fill is already confirmed. */
  confirm(row: ChildFillConfirmation): ChildFillConfirmation | null;
}

export class InMemoryFillConfirmStore implements FillConfirmStore {
  private readonly byClientOrderId = new Map<string, ChildFillConfirmation>();

  get(clientOrderId: string): ChildFillConfirmation | null {
    const id = clientOrderId.trim();
    if (!id) return null;
    return this.byClientOrderId.get(id) ?? null;
  }

  confirm(row: ChildFillConfirmation): ChildFillConfirmation | null {
    const id = row.clientOrderId.trim();
    if (!id) return null;
    if (this.byClientOrderId.has(id)) return null;
    const next: ChildFillConfirmation = {
      clientOrderId: id,
      parentClientOrderId: row.parentClientOrderId,
      confirmerId: row.confirmerId,
      confirmedAt: row.confirmedAt,
    };
    this.byClientOrderId.set(id, next);
    return { ...next };
  }
}

export type ChildFillFacts = {
  readonly clientOrderId: string;
  readonly childOrderId: string | null;
  readonly venueId: string;
  readonly venueOrderId: string;
  readonly filledAmount: string;
  readonly averagePrice: string;
  readonly feeAmount: string;
  readonly feeAsset: string;
  readonly status: 'filled' | 'partial';
};

export type OmsFillConfirmOk = {
  readonly ok: true;
  readonly confirmed: true;
  readonly clientAccepted: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly child: { readonly clientOrderId: string };
  readonly fill: ChildFillFacts;
  readonly confirmerId: string;
  readonly confirmedAt: string;
};

export type OmsFillViewOk = {
  readonly ok: true;
  readonly confirmed: boolean;
  readonly clientAccepted: boolean;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly child: { readonly clientOrderId: string };
  readonly fill: ChildFillFacts;
  readonly confirmerId: string | null;
  readonly confirmedAt: string | null;
};

export type OmsFillConfirmRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_live'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_confirmer'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_child'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'fill_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_fill'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_mismatch'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_confirmed'; readonly detail: string };

export type OmsFillConfirmResult = OmsFillConfirmOk | OmsFillConfirmRefuse;
export type OmsFillViewResult = OmsFillViewOk | OmsFillConfirmRefuse;

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsFillConfirmRefuse['reason'], detail: string): OmsFillConfirmRefuse {
  return { ok: false, reason, detail };
}

function liveStatus(status: string): boolean {
  return status === 'approved' || status === 'running';
}

function confirmerOf(confirmerId?: string): string {
  return confirmerId?.trim() ?? '';
}

/** Venue filled|partial evidence only. A zero or negative amount or price is not a fill. */
export function fillFacts(row: EmsOrderEvidence): ChildFillFacts | null {
  const execution = row.execution;
  if (!execution) return null;
  if (execution.status !== 'filled' && execution.status !== 'partial') return null;
  if (isZero(execution.filledAmount) || isNegative(execution.filledAmount)) return null;
  if (execution.averagePrice === null) return null;
  if (isZero(execution.averagePrice) || isNegative(execution.averagePrice)) return null;
  return {
    clientOrderId: row.clientOrderId,
    childOrderId: row.childOrderId ?? null,
    venueId: execution.venueId,
    venueOrderId: execution.venueOrderId,
    filledAmount: formatAmount(execution.filledAmount),
    averagePrice: formatAmount(execution.averagePrice),
    feeAmount: formatAmount(execution.feeAmount),
    feeAsset: execution.feeAsset,
    status: execution.status,
  };
}

function locateParent(input: {
  parentClientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
  requireLive: boolean;
}): { ok: true; parent: ApprovedAlgoParent } | OmsFillConfirmRefuse {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for fill confirm');
  }
  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (input.requireLive) {
    if (existing.status === 'paper') {
      return refuse('paper', `parent ${parentClientOrderId} is paper — refusing to confirm a paper child fill`);
    }
    if (!liveStatus(existing.status)) {
      return refuse(
        'not_live',
        `parent ${parentClientOrderId} is ${existing.status} — fill confirm needs a live (approved or running) parent`,
      );
    }
  }
  return { ok: true, parent: existing };
}

function locateChildFill(input: {
  parentClientOrderId: string;
  clientOrderId?: string;
  emsStore?: EmsOrderStore;
}): { ok: true; facts: ChildFillFacts } | OmsFillConfirmRefuse {
  const clientOrderId = input.clientOrderId?.trim() ?? '';
  if (!clientOrderId) {
    return refuse('missing_child', 'clientOrderId is required — refusing to invent a child fill');
  }
  if (!input.emsStore) {
    return refuse('ems_store_unwired', 'EMS evidence store is required for fill confirm');
  }
  const row = input.emsStore.get(clientOrderId);
  const facts = row ? fillFacts(row) : null;
  if (!row || !facts) {
    return refuse('missing_fill', `no child fill evidence for ${clientOrderId} — refusing to invent a fill from residual or schedule`);
  }
  const owner = row.parentClientOrderId?.trim() ?? '';
  if (owner !== input.parentClientOrderId) {
    return refuse(
      'parent_mismatch',
      `child fill ${clientOrderId} belongs to ${owner || 'no parent'} — refusing to confirm it on ${input.parentClientOrderId}`,
    );
  }
  return { ok: true, facts };
}

export function readChildFillConfirmation(input: {
  parentClientOrderId?: string;
  clientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
  emsStore?: EmsOrderStore;
  fillConfirmStore?: FillConfirmStore;
}): OmsFillViewResult {
  const located = locateParent({
    parentClientOrderId: input.parentClientOrderId,
    parentStore: input.parentStore,
    requireLive: false,
  });
  if (!located.ok) return located;
  const child = locateChildFill({
    parentClientOrderId: located.parent.parentClientOrderId,
    clientOrderId: input.clientOrderId,
    emsStore: input.emsStore,
  });
  if (!child.ok) return child;
  if (!input.fillConfirmStore) {
    return refuse('fill_store_unwired', 'fill confirm store is required to read confirmation');
  }
  const confirmation = input.fillConfirmStore.get(child.facts.clientOrderId);
  const confirmed = confirmation !== null;
  return {
    ok: true,
    confirmed,
    clientAccepted: confirmed,
    parent: { parentClientOrderId: located.parent.parentClientOrderId, kind: located.parent.kind },
    child: { clientOrderId: child.facts.clientOrderId },
    fill: child.facts,
    confirmerId: confirmation?.confirmerId ?? null,
    confirmedAt: confirmation?.confirmedAt ?? null,
  };
}

export function confirmChildFill(input: {
  parentClientOrderId?: string;
  clientOrderId?: string;
  confirmerId?: string;
  parentStore?: ApprovedAlgoParentStore;
  emsStore?: EmsOrderStore;
  fillConfirmStore?: FillConfirmStore;
  now?: Date;
}): OmsFillConfirmResult {
  const confirmerId = confirmerOf(input.confirmerId);
  if (!confirmerId) {
    return refuse('missing_confirmer', 'confirmer id is required — refusing to invent a user');
  }
  const located = locateParent({
    parentClientOrderId: input.parentClientOrderId,
    parentStore: input.parentStore,
    requireLive: true,
  });
  if (!located.ok) return located;
  const child = locateChildFill({
    parentClientOrderId: located.parent.parentClientOrderId,
    clientOrderId: input.clientOrderId,
    emsStore: input.emsStore,
  });
  if (!child.ok) return child;
  if (!input.fillConfirmStore) {
    return refuse('fill_store_unwired', 'fill confirm store is required for fill confirm');
  }
  const existing = input.fillConfirmStore.get(child.facts.clientOrderId);
  if (existing) {
    return refuse(
      'already_confirmed',
      `child fill ${child.facts.clientOrderId} is already confirmed by ${existing.confirmerId} — refusing to rewrite the trail`,
    );
  }
  const confirmedAt = (input.now ?? new Date()).toISOString();
  const recorded = input.fillConfirmStore.confirm({
    clientOrderId: child.facts.clientOrderId,
    parentClientOrderId: located.parent.parentClientOrderId,
    confirmerId,
    confirmedAt,
  });
  if (!recorded) {
    return refuse('already_confirmed', `child fill ${child.facts.clientOrderId} is already confirmed — refusing to rewrite the trail`);
  }
  return {
    ok: true,
    confirmed: true,
    clientAccepted: true,
    parent: { parentClientOrderId: located.parent.parentClientOrderId, kind: located.parent.kind },
    child: { clientOrderId: child.facts.clientOrderId },
    fill: child.facts,
    confirmerId: recorded.confirmerId,
    confirmedAt: recorded.confirmedAt,
  };
}

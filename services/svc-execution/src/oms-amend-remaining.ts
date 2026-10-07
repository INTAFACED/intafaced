/**
 * Amend remaining qty on one live TWAP/VWAP/POV parent.
 *
 * Cancels remaining children first so the previous request does not stay
 * live. Then writes owner remaining onto the parent. Refuse if remaining
 * is blank. Unknown child cancel refuses — leftover unchanged, no invented
 * size. Does not submit to matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { VenueKind } from '@intafaced/venue-adapter';
import { cancelRemainingParentChildren } from './oms-cancel-remaining.js';
import type { OmsDrainChild } from './oms-drain.js';
import type { OmsCancelFn } from './oms-cancel.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import { consumeCappedRemaining, parentRemainingWriterWired } from './oms-parent-cap.js';
import type { AlgoKind, ApprovedAlgoParentStore } from './oms-start.js';

export type OmsAmendRemainingRefuseReason =
  | 'remaining_blank'
  | 'remaining_invalid'
  | 'missing_parent'
  | 'parent_only'
  | 'parent_store_unwired'
  | 'ems_store_unwired'
  | 'not_found'
  | 'unsupported_kind'
  | 'not_live'
  | 'missing_residual'
  | 'exceeds_remaining'
  | 'non_positive_qty'
  | 'children_unknown';

export type OmsAmendRemainingRefusal = {
  readonly ok: false;
  readonly reason: OmsAmendRemainingRefuseReason;
  readonly detail: string;
};

export type OmsAmendRemainingOk = {
  readonly ok: true;
  readonly amended: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly children: readonly OmsDrainChild[];
  readonly residual: { readonly remaining: string };
};

export type OmsAmendRemainingResult = OmsAmendRemainingOk | OmsAmendRemainingRefusal;

const LIVE = new Set(['approved', 'running']);

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsAmendRemainingRefuseReason, detail: string): OmsAmendRemainingRefusal {
  return { ok: false, reason, detail };
}

function parseRemainingQty(raw: string | null | undefined): { ok: true; text: string } | OmsAmendRemainingRefusal {
  if (raw === null || raw === undefined) {
    return refuse('remaining_blank', 'remaining qty is blank — refuse rather than invent size');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('remaining_blank', 'remaining qty is blank — refuse rather than invent size');
  }
  try {
    const value = parseAmount(text);
    if (value < 0n) {
      return refuse('remaining_invalid', 'remaining qty must be a non-negative ledger amount — not invented');
    }
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('remaining_invalid', `remaining qty is not a ledger amount: ${message}`);
  }
}

function childrenKnown(children: readonly OmsDrainChild[]): boolean {
  return children.every((child) => child.outcome === 'stopped' || child.outcome === 'already_stopped');
}

export async function amendRemainingLiveAlgoParent(input: {
  parentClientOrderId?: string;
  executionGroupId?: string;
  remaining?: string | null;
  parentStore?: ApprovedAlgoParentStore;
  emsStore?: EmsOrderStore;
  cancelByVenue?: Readonly<Record<string, OmsCancelFn>>;
  kindsByVenue?: Readonly<Record<string, VenueKind>>;
}): Promise<OmsAmendRemainingResult> {
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (executionGroupId) {
    return refuse('parent_only', 'amend remaining of exactly one parentClientOrderId');
  }
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for amend remaining');
  }

  const remaining = parseRemainingQty(input.remaining);
  if (!remaining.ok) return remaining;

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (!LIVE.has(existing.status)) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${existing.status} — amend needs a live (approved or running) parent`);
  }

  const writer = parentRemainingWriterWired(input.parentStore);
  if (!writer.ok) return writer;

  const cancelled = await cancelRemainingParentChildren({
    parentClientOrderId,
    cancelByVenue: input.cancelByVenue,
    emsStore: input.emsStore,
    kindsByVenue: input.kindsByVenue,
  });
  if (!cancelled.ok) {
    return { ok: false, reason: cancelled.reason, detail: cancelled.detail };
  }
  if (!childrenKnown(cancelled.children)) {
    return refuse('children_unknown', 'previous request may still be live — refusing to amend remaining until every child cancel is known');
  }

  const consumed = consumeCappedRemaining(input.parentStore, parentClientOrderId, remaining.text);
  if (!consumed.ok) return consumed;

  return {
    ok: true,
    amended: true,
    parent: { parentClientOrderId: existing.parentClientOrderId, kind: existing.kind },
    children: cancelled.children,
    residual: { remaining: consumed.remaining },
  };
}

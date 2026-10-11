/**
 * Promote one paper parent to live.
 *
 * Marks an already-paper parent `approved` so start can pick it up
 * (start still requires jobs-on). This door never invents leftover,
 * never invents a venue, never places a live child, and does not
 * touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { AlgoJobsGate, AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';

export type OmsPromoteOk = {
  readonly ok: true;
  readonly promoted: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly status: 'approved';
  readonly residual: { readonly remaining: string; readonly released: false };
};

export type OmsPromoteRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_paper'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_residual'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'promote_rejected'; readonly detail: string };

export type OmsPromoteResult = OmsPromoteOk | OmsPromoteRefuse;

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsPromoteRefuse['reason'], detail: string): OmsPromoteRefuse {
  return { ok: false, reason, detail };
}

function retainedRemaining(parent: ApprovedAlgoParent): string | null {
  const residual = parent.residual;
  if (residual == null) return null;
  if (residual.released === true) return null;
  const raw = residual.remaining;
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function promotePaperParentToLive(input: {
  parentClientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
  jobs?: AlgoJobsGate;
}): OmsPromoteResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for promote');
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status !== 'paper') {
    return refuse('not_paper', `parent ${parentClientOrderId} is ${existing.status} — promote needs an already paper parent`);
  }

  const remaining = retainedRemaining(existing);
  if (!remaining) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration, slices, or a venue');
  }

  let echoed: string;
  try {
    echoed = formatAmount(parseAmount(remaining));
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }

  if (!input.parentStore.promote) {
    return refuse('parent_store_unwired', 'approved algo parent store.promote is required for promote');
  }

  const promoted = input.parentStore.promote(parentClientOrderId);
  if (!promoted) {
    const again = input.parentStore.get(parentClientOrderId);
    if (!again) {
      return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
    }
    if (again.status !== 'paper') {
      return refuse('not_paper', `parent ${parentClientOrderId} is ${again.status} — promote needs an already paper parent`);
    }
    const againRemaining = retainedRemaining(again);
    if (!againRemaining) {
      return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration, slices, or a venue');
    }
    try {
      formatAmount(parseAmount(againRemaining));
    } catch {
      return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
    }
    return refuse('promote_rejected', 'the store did not promote this parent');
  }

  return {
    ok: true,
    promoted: true,
    parent: { parentClientOrderId: promoted.parentClientOrderId, kind: promoted.kind },
    status: 'approved',
    residual: { remaining: echoed, released: false },
  };
}

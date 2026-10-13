/**
 * Release leftover residual already on an expired parent.
 *
 * Hands the retained leftover through ledger-client. This door never
 * invents an amount from duration, slices, or the clock, never invents
 * a fill or cancel, and does not touch matching.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { EmsOrderStore } from './oms-ems-store.js';
import type { AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';

export type OmsReleaseResidualOk = {
  readonly ok: true;
  readonly released: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly status: 'expired';
  readonly residual: { readonly remaining: string; readonly released: true };
};

export type OmsReleaseResidualRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_expired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_released'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_residual'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'release_rejected'; readonly detail: string };

export type OmsReleaseResidualResult = OmsReleaseResidualOk | OmsReleaseResidualRefuse;

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsReleaseResidualRefuse['reason'], detail: string): OmsReleaseResidualRefuse {
  return { ok: false, reason, detail };
}

function retainedRemaining(parent: ApprovedAlgoParent): string | null {
  const residual = parent.residual;
  if (residual == null) return null;
  const raw = residual.remaining;
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function releaseExpiredParentResidual(input: {
  parentClientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
  emsStore?: EmsOrderStore;
  ledger?: unknown;
}): OmsReleaseResidualResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for releaseResidual');
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status !== 'expired') {
    return refuse('not_expired', `parent ${parentClientOrderId} is ${existing.status} — releaseResidual needs an already expired parent`);
  }
  if (existing.residual?.released === true) {
    return refuse('already_released', `parent ${parentClientOrderId} residual is already released`);
  }

  const remaining = retainedRemaining(existing);
  if (!remaining) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration, slices, or the clock');
  }

  let echoed: string;
  try {
    echoed = formatAmount(parseAmount(remaining));
  } catch {
    return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }

  if (typeof input.parentStore.releaseResidual !== 'function') {
    return refuse('parent_store_unwired', 'approved algo parent store.releaseResidual is required for releaseResidual');
  }

  const released = input.parentStore.releaseResidual(parentClientOrderId);
  if (!released) {
    const again = input.parentStore.get(parentClientOrderId);
    if (!again) {
      return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
    }
    if (again.status !== 'expired') {
      return refuse('not_expired', `parent ${parentClientOrderId} is ${again.status} — releaseResidual needs an already expired parent`);
    }
    if (again.residual?.released === true) {
      return refuse('already_released', `parent ${parentClientOrderId} residual is already released`);
    }
    const againRemaining = retainedRemaining(again);
    if (!againRemaining) {
      return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration, slices, or the clock');
    }
    try {
      formatAmount(parseAmount(againRemaining));
    } catch {
      return refuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
    }
    return refuse('release_rejected', 'the store did not release this parent');
  }

  return {
    ok: true,
    released: true,
    parent: { parentClientOrderId: released.parentClientOrderId, kind: released.kind },
    status: 'expired',
    residual: { remaining: echoed, released: true },
  };
}

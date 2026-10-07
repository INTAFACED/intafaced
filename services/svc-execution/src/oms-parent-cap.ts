/**
 * Parent residual.remaining is the hard qty cap for children.
 * Caller-supplied parentCap on the child door is the hard price-discretion
 * cap — a worse child limit/print refuses. Missing cap refuses; this never
 * invents ticks from a book or a schedule.
 *
 * The leftover must already be a ledger amount. Missing remaining refuses —
 * this never invents a cap from duration, slicesPlanned, or a book.
 */
import { compare, formatAmount, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client';
import type { ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';

export type ParentRemainingCapOk = { readonly ok: true; readonly nextRemaining: string };

export type ParentRemainingCapRefuse =
  | { readonly ok: false; readonly reason: 'missing_residual'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'exceeds_remaining'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'non_positive_qty'; readonly detail: string };

export type ParentPriceCapOk = { readonly ok: true };

export type ParentPriceCapRefuse =
  | { readonly ok: false; readonly reason: 'missing_price_cap'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'worse_than_cap'; readonly detail: string };

function remainingRefuse(reason: ParentRemainingCapRefuse['reason'], detail: string): ParentRemainingCapRefuse {
  return { ok: false, reason, detail };
}

function priceRefuse(reason: ParentPriceCapRefuse['reason'], detail: string): ParentPriceCapRefuse {
  return { ok: false, reason, detail };
}

/** Buy paying more, or sell receiving less, is worse than the parent cap. */
export function capAgainstParentPrice(
  side: 'buy' | 'sell',
  childLimit: Amount,
  parentCapRaw: string | undefined,
  label: string,
): ParentPriceCapOk | ParentPriceCapRefuse {
  const raw = parentCapRaw?.trim() ?? '';
  if (!raw) {
    return priceRefuse('missing_price_cap', 'parentCap is required — refusing to invent ticks');
  }
  let capAmt;
  try {
    capAmt = parseAmount(raw);
  } catch {
    return priceRefuse('missing_price_cap', 'parentCap is not a ledger amount — refusing to invent ticks');
  }
  if (capAmt <= ZERO) {
    return priceRefuse('missing_price_cap', 'parentCap must be a positive ledger amount — refusing to invent ticks');
  }
  const worse = side === 'buy' ? compare(childLimit, capAmt) > 0 : compare(childLimit, capAmt) < 0;
  if (worse) {
    return priceRefuse('worse_than_cap', `${side} ${label} ${formatAmount(childLimit)} is worse than parentCap ${formatAmount(capAmt)}`);
  }
  return { ok: true };
}

export function retainedRemaining(parent: ApprovedAlgoParent): string | null {
  const residual = parent.residual;
  if (residual == null) return null;
  if (residual.released === true) return null;
  const raw = residual.remaining;
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function capAgainstParentRemaining(
  parent: ApprovedAlgoParent,
  childQty: Amount,
  label: string,
): ParentRemainingCapOk | ParentRemainingCapRefuse {
  const remainingRaw = retainedRemaining(parent);
  if (!remainingRaw) {
    return remainingRefuse(
      'missing_residual',
      'residual.remaining is missing — refusing to invent leftover from duration or slicesPlanned',
    );
  }
  let remainingAmt;
  try {
    remainingAmt = parseAmount(remainingRaw);
  } catch {
    return remainingRefuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
  if (remainingAmt < ZERO) {
    return remainingRefuse('missing_residual', 'residual.remaining is not a ledger amount — refusing to invent leftover');
  }
  if (compare(childQty, ZERO) <= 0) {
    return remainingRefuse(
      'non_positive_qty',
      `${label} ${formatAmount(childQty)} is not a positive child quantity — refusing to grow residual.remaining`,
    );
  }
  if (compare(childQty, remainingAmt) > 0) {
    return remainingRefuse(
      'exceeds_remaining',
      `${label} ${formatAmount(childQty)} exceeds residual.remaining ${formatAmount(remainingAmt)}`,
    );
  }
  return { ok: true, nextRemaining: formatAmount(sub(remainingAmt, childQty)) };
}

export function parentRemainingWriterWired(parentStore: ApprovedAlgoParentStore): ParentRemainingCapRefuse | { readonly ok: true } {
  if (typeof parentStore.consumeResidual !== 'function') {
    return remainingRefuse(
      'missing_residual',
      'residual.remaining is missing — refusing to invent leftover from duration or slicesPlanned',
    );
  }
  return { ok: true };
}

export function consumeCappedRemaining(
  parentStore: ApprovedAlgoParentStore,
  parentClientOrderId: string,
  nextRemaining: string,
  expectedRemaining?: string,
): ParentRemainingCapRefuse | { readonly ok: true; readonly remaining: string } {
  const wired = parentRemainingWriterWired(parentStore);
  if (!wired.ok) return wired;
  const consumed = parentStore.consumeResidual!(parentClientOrderId, nextRemaining, expectedRemaining);
  if (!consumed) {
    return remainingRefuse(
      'missing_residual',
      'residual.remaining is missing — refusing to invent leftover from duration or slicesPlanned',
    );
  }
  return { ok: true, remaining: nextRemaining };
}

/**
 * Submit one child slice of a live TWAP/VWAP/POV parent.
 *
 * Uses the existing trade-submit bridge. Qty, venue, symbol, side, and
 * limit price and parentCap must already be on the request — this door
 * never invents them from duration, slicesPlanned, ticks, or a venue
 * book, and does not touch matching. A child limit worse than parentCap
 * refuses. Paper and non-live parents refuse. Remaining on the parent
 * must already be a ledger amount; a successful slice subtracts the
 * submitted qty and never invents leftover.
 */
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { VenueExecution } from '@intafaced/venue-adapter';
import { childIds } from './oms-execute.js';
import type { AlgoPauseStore } from './oms-pause.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import {
  capAgainstParentPrice,
  capAgainstParentRemaining,
  consumeCappedRemaining,
  parentRemainingWriterWired,
  retainedRemaining,
} from './oms-parent-cap.js';
import type { AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';

export type OmsSliceOk = {
  readonly ok: true;
  readonly sliced: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly child: {
    readonly clientOrderId: string;
    readonly childOrderId: string;
    readonly venueId: string;
  };
  readonly execution: VenueExecution;
  readonly residual: { readonly remaining: string };
};

export type OmsSliceRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'staged'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_live'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unattended'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'algo_paused'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_qty'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_residual'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'exceeds_remaining'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'non_positive_qty'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_venue'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_symbol'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_side'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_price'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_price_cap'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'worse_than_cap'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'submit_unwired'; readonly detail: string };

export type OmsSliceResult = OmsSliceOk | OmsSliceRefuse;

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsSliceRefuse['reason'], detail: string): OmsSliceRefuse {
  return { ok: false, reason, detail };
}

function liveStatus(status: string): boolean {
  return status === 'approved' || status === 'running';
}

function ownerOf(parent: ApprovedAlgoParent): string | null {
  const owner = parent.executionOwner?.trim() ?? '';
  return owner || null;
}

export async function sliceLiveAlgoParent(input: {
  parentClientOrderId?: string;
  amount?: string;
  venueId?: string;
  symbol?: string;
  side?: 'buy' | 'sell';
  limitPrice?: string;
  parentCap?: string;
  parentStore?: ApprovedAlgoParentStore;
  submit?: OmsSubmitFn;
  submitByVenue?: Readonly<Record<string, OmsSubmitFn>>;
  pauseStore?: AlgoPauseStore;
  emsStore?: EmsOrderStore;
}): Promise<OmsSliceResult> {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for slice');
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status === 'paper') {
    return refuse('paper', `parent ${parentClientOrderId} is paper — refusing to submit a live child`);
  }
  if (existing.status === 'staged') {
    return refuse('staged', `parent ${parentClientOrderId} is staged — refusing to submit a live child until released`);
  }
  if (!liveStatus(existing.status)) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${existing.status} — slice needs a live (approved or running) parent`);
  }
  if (!ownerOf(existing)) {
    return refuse(
      'unattended',
      `parent ${parentClientOrderId} is unattended (no execution owner) — refusing to submit a child until claimed`,
    );
  }
  if (input.pauseStore?.isPaused({ parentClientOrderId })) {
    return refuse('algo_paused', 'paused algo takes no new children');
  }

  const qtyRaw = input.amount?.trim() ?? '';
  if (!qtyRaw) {
    return refuse('missing_qty', 'slice amount is required — refusing to invent size from duration or slicesPlanned');
  }
  let amount;
  try {
    amount = parseAmount(qtyRaw);
  } catch {
    return refuse('missing_qty', 'slice amount is not a ledger amount — refusing to invent size');
  }
  if (amount <= ZERO) {
    return refuse('missing_qty', 'slice amount must be a positive ledger amount — refusing to invent size');
  }

  const venueId = input.venueId?.trim() ?? '';
  if (!venueId) {
    return refuse('missing_venue', 'venueId is required — refusing to invent a venue');
  }
  const symbol = input.symbol?.trim() ?? '';
  if (!symbol) {
    return refuse('missing_symbol', 'symbol is required — refusing to invent an instrument');
  }
  const side = input.side;
  if (side !== 'buy' && side !== 'sell') {
    return refuse('missing_side', 'side is required — refusing to invent buy or sell');
  }
  const priceRaw = input.limitPrice?.trim() ?? '';
  if (!priceRaw) {
    return refuse('missing_price', 'limitPrice is required — refusing to invent a price');
  }
  let limitPrice;
  try {
    limitPrice = parseAmount(priceRaw);
  } catch {
    return refuse('missing_price', 'limitPrice is not a ledger amount — refusing to invent a price');
  }
  if (limitPrice <= ZERO) {
    return refuse('missing_price', 'limitPrice must be a positive ledger amount — refusing to invent a price');
  }

  const priceCap = capAgainstParentPrice(side, limitPrice, input.parentCap, 'limit');
  if (!priceCap.ok) return priceCap;

  const submit = input.submit ?? input.submitByVenue?.[venueId];
  if (!submit) {
    return refuse('submit_unwired', `venue ${venueId} is not wired for submit`);
  }

  const cap = capAgainstParentRemaining(existing, amount, 'slice');
  if (!cap.ok) return cap;
  const writer = parentRemainingWriterWired(input.parentStore);
  if (!writer.ok) return writer;
  const priorRemaining = retainedRemaining(existing);
  if (!priorRemaining) {
    return refuse(
      'missing_residual',
      'residual.remaining is missing — refusing to invent leftover from duration or slicesPlanned',
    );
  }

  const consumed = consumeCappedRemaining(input.parentStore, parentClientOrderId, cap.nextRemaining, priorRemaining);
  if (!consumed.ok) return consumed;

  const occurrence = input.emsStore?.list({ parentClientOrderId }).length ?? 0;
  const ids = childIds({ parentClientOrderId, executionGroupId: parentClientOrderId }, occurrence, occurrence, venueId);

  let execution: VenueExecution;
  try {
    execution = await submit({
      symbol,
      side,
      amount,
      limitPrice,
      clientOrderId: ids.clientOrderId,
    });
  } catch (err) {
    input.parentStore.consumeResidual?.(parentClientOrderId, priorRemaining, consumed.remaining);
    throw err;
  }

  let remaining = consumed.remaining;
  if (execution.status === 'rejected') {
    const restored = input.parentStore.consumeResidual?.(parentClientOrderId, priorRemaining, consumed.remaining);
    remaining = restored?.residual?.remaining ?? consumed.remaining;
  }

  return {
    ok: true,
    sliced: true,
    parent: { parentClientOrderId: existing.parentClientOrderId, kind: existing.kind },
    child: {
      clientOrderId: ids.clientOrderId,
      childOrderId: ids.childOrderId,
      venueId,
    },
    execution,
    residual: { remaining },
  };
}

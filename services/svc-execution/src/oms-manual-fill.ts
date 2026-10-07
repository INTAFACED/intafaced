/**
 * Record one operator-entered child fill on a live TWAP/VWAP/POV parent.
 *
 * One door: the operator who enters the print is the confirmer. Confirm
 * stays the venue-EMS path — this never invents a venue ack. Qty and
 * price are ledger decimal strings; missing qty/price/operator refuses
 * rather than inventing a print from residual or schedule. Parent
 * remaining is a hard cap: missing leftover refuses, oversized qty
 * refuses exceeds_remaining. Caller-supplied parentCap is required —
 * a worse print refuses; this never invents ticks. Append-only trail.
 * Does not post ledger value, does not touch matching.
 */
import { formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client';
import { capAgainstParentPrice, capAgainstParentRemaining, consumeCappedRemaining } from './oms-parent-cap.js';
import type { AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';

export type ManualChildFill = {
  readonly clientOrderId: string;
  readonly parentClientOrderId: string;
  readonly filledAmount: string;
  readonly averagePrice: string;
  readonly confirmerId: string;
  readonly confirmedAt: string;
};

export interface ManualFillStore {
  get(clientOrderId: string): ManualChildFill | null;
  /** Append-only. Returns null when that child fill is already recorded. */
  record(row: ManualChildFill): ManualChildFill | null;
}

export class InMemoryManualFillStore implements ManualFillStore {
  private readonly byClientOrderId = new Map<string, ManualChildFill>();

  get(clientOrderId: string): ManualChildFill | null {
    const id = clientOrderId.trim();
    if (!id) return null;
    return this.byClientOrderId.get(id) ?? null;
  }

  record(row: ManualChildFill): ManualChildFill | null {
    const id = row.clientOrderId.trim();
    if (!id) return null;
    if (this.byClientOrderId.has(id)) return null;
    const next: ManualChildFill = {
      clientOrderId: id,
      parentClientOrderId: row.parentClientOrderId,
      filledAmount: row.filledAmount,
      averagePrice: row.averagePrice,
      confirmerId: row.confirmerId,
      confirmedAt: row.confirmedAt,
    };
    this.byClientOrderId.set(id, next);
    return { ...next };
  }
}

export type OmsManualFillOk = {
  readonly ok: true;
  readonly recorded: true;
  readonly confirmed: true;
  readonly clientAccepted: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly child: { readonly clientOrderId: string };
  readonly fill: { readonly filledAmount: string; readonly averagePrice: string };
  readonly residual: { readonly remaining: string };
  readonly confirmerId: string;
  readonly confirmedAt: string;
};

export type OmsManualFillRefuse =
  | { readonly ok: false; readonly reason: 'missing_confirmer'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_live'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_child'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_qty'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_price'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_side'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_price_cap'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'worse_than_cap'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_residual'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'exceeds_remaining'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'non_positive_qty'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'fill_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_recorded'; readonly detail: string };

export type OmsManualFillResult = OmsManualFillOk | OmsManualFillRefuse;

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsManualFillRefuse['reason'], detail: string): OmsManualFillRefuse {
  return { ok: false, reason, detail };
}

function liveStatus(status: string): boolean {
  return status === 'approved' || status === 'running';
}

function confirmerOf(confirmerId?: string): string {
  return confirmerId?.trim() ?? '';
}

function locateParent(input: {
  parentClientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
}): { ok: true; parent: ApprovedAlgoParent } | OmsManualFillRefuse {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for manual fill');
  }
  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status === 'paper') {
    return refuse('paper', `parent ${parentClientOrderId} is paper — refusing to record a paper child fill`);
  }
  if (!liveStatus(existing.status)) {
    return refuse(
      'not_live',
      `parent ${parentClientOrderId} is ${existing.status} — manual fill needs a live (approved or running) parent`,
    );
  }
  return { ok: true, parent: existing };
}

function ledgerQty(raw?: string): { ok: true; formatted: string; amount: Amount } | OmsManualFillRefuse {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    return refuse('missing_qty', 'qty is required — refusing to invent a print from residual or schedule');
  }
  let amount;
  try {
    amount = parseAmount(trimmed);
  } catch {
    return refuse('missing_qty', 'qty is not a ledger amount — refusing to invent a print');
  }
  if (amount <= ZERO) {
    return refuse('missing_qty', 'qty must be a positive ledger amount — refusing to invent a print');
  }
  return { ok: true, formatted: formatAmount(amount), amount };
}

function ledgerPrice(raw?: string): { ok: true; formatted: string; amount: Amount } | OmsManualFillRefuse {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    return refuse('missing_price', 'price is required — refusing to invent a print');
  }
  let price;
  try {
    price = parseAmount(trimmed);
  } catch {
    return refuse('missing_price', 'price is not a ledger amount — refusing to invent a print');
  }
  if (price <= ZERO) {
    return refuse('missing_price', 'price must be a positive ledger amount — refusing to invent a print');
  }
  return { ok: true, formatted: formatAmount(price), amount: price };
}

export function recordManualChildFill(input: {
  parentClientOrderId?: string;
  clientOrderId?: string;
  amount?: string;
  price?: string;
  side?: 'buy' | 'sell';
  parentCap?: string;
  confirmerId?: string;
  parentStore?: ApprovedAlgoParentStore;
  manualFillStore?: ManualFillStore;
  now?: Date;
}): OmsManualFillResult {
  const confirmerId = confirmerOf(input.confirmerId);
  if (!confirmerId) {
    return refuse('missing_confirmer', 'confirmer id is required — refusing to invent a user');
  }
  const located = locateParent({
    parentClientOrderId: input.parentClientOrderId,
    parentStore: input.parentStore,
  });
  if (!located.ok) return located;
  const parentStore = input.parentStore;
  if (!parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for manual fill');
  }
  const clientOrderId = input.clientOrderId?.trim() ?? '';
  if (!clientOrderId) {
    return refuse('missing_child', 'clientOrderId is required — refusing to invent a child fill');
  }
  const qty = ledgerQty(input.amount);
  if (!qty.ok) return qty;
  const px = ledgerPrice(input.price);
  if (!px.ok) return px;
  const side = input.side;
  if (side !== 'buy' && side !== 'sell') {
    return refuse('missing_side', 'side is required — refusing to invent buy or sell');
  }
  const priceCap = capAgainstParentPrice(side, px.amount, input.parentCap, 'fill');
  if (!priceCap.ok) return priceCap;
  const cap = capAgainstParentRemaining(located.parent, qty.amount, 'fill');
  if (!cap.ok) return cap;
  if (!input.manualFillStore) {
    return refuse('fill_store_unwired', 'manual fill store is required for manual fill');
  }
  const existing = input.manualFillStore.get(clientOrderId);
  if (existing) {
    return refuse(
      'already_recorded',
      `child fill ${clientOrderId} is already recorded by ${existing.confirmerId} — refusing to rewrite the trail`,
    );
  }
  const consumed = consumeCappedRemaining(parentStore, located.parent.parentClientOrderId, cap.nextRemaining);
  if (!consumed.ok) return consumed;
  const confirmedAt = (input.now ?? new Date()).toISOString();
  const recorded = input.manualFillStore.record({
    clientOrderId,
    parentClientOrderId: located.parent.parentClientOrderId,
    filledAmount: qty.formatted,
    averagePrice: px.formatted,
    confirmerId,
    confirmedAt,
  });
  if (!recorded) {
    return refuse('already_recorded', `child fill ${clientOrderId} is already recorded — refusing to rewrite the trail`);
  }
  return {
    ok: true,
    recorded: true,
    confirmed: true,
    clientAccepted: true,
    parent: { parentClientOrderId: located.parent.parentClientOrderId, kind: located.parent.kind },
    child: { clientOrderId: recorded.clientOrderId },
    fill: { filledAmount: recorded.filledAmount, averagePrice: recorded.averagePrice },
    residual: { remaining: consumed.remaining },
    confirmerId: recorded.confirmerId,
    confirmedAt: recorded.confirmedAt,
  };
}

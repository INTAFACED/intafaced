import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { AlgoProgressView, TwapParent } from './types.js';

/**
 * Progress is a sum over real fills — or nothing.
 * The parent never stores filledQty; this view is derived at read time.
 */
export function presentAlgoProgress(parent: TwapParent, filledFromChildren: Amount): AlgoProgressView {
  const view: AlgoProgressView = {
    parentId: parent.id,
    status: parent.status,
    haltReason: parent.haltReason,
    childrenEmitted: parent.children.length,
    missesRecorded: parent.misses.length,
    slicesPlanned: parent.slicesPlanned,
    nextSliceIndex: parent.nextSliceIndex,
    filledQty: formatAmount(filledFromChildren),
    totalQty: formatAmount(parent.totalQty),
  };
  assertProgressHasNoInventedFills(view, filledFromChildren);
  return view;
}

/**
 * Sum real child fill quantities only (TradeService.algoProgress / ledger fills).
 * Never use schedule qty, childrenEmitted, or nextSliceIndex as a substitute.
 */
export function sumChildFillQtys(fills: ReadonlyArray<{ readonly qty: Amount }>): Amount {
  let total = 0n;
  for (const f of fills) total += f.qty;
  return total;
}

/** Keys that must NEVER appear on a parent object (fabrication surface). */
export const FORBIDDEN_PARENT_MONEY_KEYS = [
  'filledQty',
  'avgPrice',
  'averagePrice',
  'holdAmount',
  'holdAsset',
  'pnl',
  'realizedPnl',
  'progressPct',
  'progressPercent',
  'balance',
  'notional',
] as const;

export function assertParentHasNoMoneyFields(parent: TwapParent): void {
  const keys = Object.keys(parent);
  for (const bad of FORBIDDEN_PARENT_MONEY_KEYS) {
    if (keys.includes(bad)) {
      throw new Error(`algo parent must not carry money field "${bad}"`);
    }
  }
}

/**
 * D26-P1-T4 / ADR honesty: a progress view must never report filled qty when
 * no child fills were supplied. Children emitted ≠ filled.
 */
export interface AlgoChildView {
  readonly orderId: string;
  readonly sliceIndex: number;
  readonly time: string;
}

export interface AlgoMissView {
  readonly sliceIndex: number;
  readonly time: string;
  readonly code: string;
}

/**
 * algo.get body. `filledQty` is the caller's sum of child fills.
 * Children and misses are the stored lists. children.length is not a fill.
 */
export function presentAlgoDesk(
  parent: TwapParent,
  filledQty: string,
): {
  children: AlgoChildView[];
  misses: AlgoMissView[];
  filledQty: string;
} {
  if (filledQty.trim() === '') {
    throw new Error('algo get filledQty is blank — refuse to invent one from childrenEmitted');
  }
  return {
    children: parent.children.map((child) => ({
      orderId: child.orderId,
      sliceIndex: child.sliceIndex,
      time: child.placedAt.toISOString(),
    })),
    misses: parent.misses.map((miss) => ({
      sliceIndex: miss.sliceIndex,
      time: miss.at.toISOString(),
      code: miss.code,
    })),
    filledQty,
  };
}

export function assertProgressHasNoInventedFills(view: AlgoProgressView, filledFromChildren: Amount): void {
  if (filledFromChildren === 0n && view.filledQty !== '0' && view.filledQty !== '0.0') {
    throw new Error(`algo progress invented filledQty=${view.filledQty} with zero child fills`);
  }
  if (view.childrenEmitted > 0 && filledFromChildren === 0n && view.filledQty !== '0' && view.filledQty !== '0.0') {
    throw new Error('algo progress must not treat childrenEmitted as fills');
  }
}

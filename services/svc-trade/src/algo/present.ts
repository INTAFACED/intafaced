import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { AlgoSchedulerView } from './scheduler-heartbeat.js';
import { algoStopReason } from './stop-reason.js';
import { awaitingTrigger, type AlgoProgressView, type AlgoStatus, type TwapParent } from './types.js';

/**
 * Shipped default of TRADE_ALGO_JOBS_ENABLED is off. Callers that have read
 * the flag and the heartbeat pass that reading. Callers that have not
 * (engine unit tests, the memory public-door façade) get this view, which
 * is the flag's default, not a guess that the loop is up.
 */
export const SCHEDULER_FLAG_OFF: AlgoSchedulerView = { running: false, reason: 'jobs_disabled' };

/** Next due time only while the schedule is active. A stored time on a finished parent is not a next slice. */
export function nextSliceAtIso(status: AlgoStatus, nextDueAt: Date | null): string | null {
  if (status !== 'active' || nextDueAt == null) return null;
  return nextDueAt.toISOString();
}

export function presentScheduleHonesty(
  parent: {
    readonly status: AlgoStatus;
    readonly nextDueAt: Date;
    readonly triggerPrice?: Amount | null;
    readonly triggeredAt?: Date | null;
  },
  scheduler: AlgoSchedulerView,
): { nextSliceAt: string | null; scheduler: AlgoSchedulerView } {
  // A schedule waiting for its trigger price has no next slice time until the price is reached.
  if (awaitingTrigger({ triggerPrice: parent.triggerPrice ?? null, triggeredAt: parent.triggeredAt ?? null }))
    return { nextSliceAt: null, scheduler };
  return { nextSliceAt: nextSliceAtIso(parent.status, parent.nextDueAt), scheduler };
}

/**
 * Progress is a sum over real fills — or nothing.
 * The parent never stores filledQty; this view is derived at read time.
 */
export function presentAlgoProgress(
  parent: TwapParent,
  filledFromChildren: Amount,
  scheduler: AlgoSchedulerView = SCHEDULER_FLAG_OFF,
): AlgoProgressView {
  const view: AlgoProgressView = {
    parentId: parent.id,
    status: parent.status,
    haltReason: parent.haltReason,
    stopReason: algoStopReason(parent),
    childrenEmitted: parent.children.length,
    missesRecorded: parent.misses.length,
    slicesPlanned: parent.slicesPlanned,
    nextSliceIndex: parent.nextSliceIndex,
    filledQty: formatAmount(filledFromChildren),
    totalQty: formatAmount(parent.totalQty),
    ...presentScheduleHonesty(parent, scheduler),
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
  /** The child's placed size. */
  readonly qty: string;
  /** POV: the volume or book size its participation was applied to; null for other kinds. */
  readonly basisQty: string | null;
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
      qty: formatAmount(child.qty),
      basisQty: child.basisQty == null ? null : formatAmount(child.basisQty),
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

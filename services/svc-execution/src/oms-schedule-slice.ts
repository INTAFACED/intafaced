/**
 * Take the next child slice of a live TWAP/VWAP/POV parent when the
 * injected clock hits the retained schedule (sliceIntervalMs / slicesPlanned).
 *
 * Clock is caller-injected like pass-timeout — this door never starts a
 * host timer and never invents VWAP volume or POV participation. Qty,
 * venue, symbol, side, limit, and parentCap stay on the request;
 * oms-slice + the parent remaining/price caps do the submit. Missing
 * schedule, clock, remaining, parentCap, or EMS store refuses. A slice
 * is scheduled only when the child is listed after record. Never invents ticks.
 */
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { AlgoPauseStore } from './oms-pause.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import { retainedRemaining } from './oms-parent-cap.js';
import { sliceLiveAlgoParent, type OmsSliceOk, type OmsSliceRefuse } from './oms-slice.js';
import type { ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';
import type { OmsSubmitFn } from './oms-trade-submit.js';

export type OmsScheduleSliceOk = OmsSliceOk & {
  readonly scheduled: true;
  readonly sliceIndex: number;
  readonly dueAt: string;
  readonly slicesPlanned: number;
};

export type OmsScheduleSliceRefuse = {
  readonly ok: false;
  readonly reason: OmsSliceRefuse['reason'] | 'missing_schedule' | 'missing_clock' | 'not_due';
  readonly detail: string;
};

export type OmsScheduleSliceResult = OmsScheduleSliceOk | OmsScheduleSliceRefuse;

function refuse(reason: OmsScheduleSliceRefuse['reason'], detail: string): OmsScheduleSliceRefuse {
  return { ok: false, reason, detail };
}

function isAlgoKind(kind: string): kind is ApprovedAlgoParent['kind'] {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function liveStatus(status: string): boolean {
  return status === 'approved' || status === 'running';
}

function injectedNow(now?: Date): Date | null {
  if (!(now instanceof Date)) return null;
  const ms = now.getTime();
  if (!Number.isFinite(ms)) return null;
  return now;
}

function scheduleMissing(parent: ApprovedAlgoParent): boolean {
  const { durationMs, sliceIntervalMs, slicesPlanned, participationBps } = parent.schedule;
  if (!(durationMs > 0) || !(sliceIntervalMs > 0) || slicesPlanned < 1) return true;
  if (parent.kind === 'pov' && (participationBps === null || !Number.isInteger(participationBps))) return true;
  const startedAt = parent.startedAt?.trim() ?? '';
  if (!startedAt) return true;
  if (!Number.isFinite(Date.parse(startedAt))) return true;
  return false;
}

function remainingMissing(parent: ApprovedAlgoParent): boolean {
  const raw = retainedRemaining(parent);
  if (!raw) return true;
  try {
    const amount = parseAmount(raw);
    return amount < ZERO;
  } catch {
    return true;
  }
}

export async function scheduleSliceLiveAlgoParent(input: {
  parentClientOrderId?: string;
  amount?: string;
  venueId?: string;
  symbol?: string;
  side?: 'buy' | 'sell';
  limitPrice?: string;
  parentCap?: string;
  now?: Date;
  parentStore?: ApprovedAlgoParentStore;
  submit?: OmsSubmitFn;
  submitByVenue?: Readonly<Record<string, OmsSubmitFn>>;
  pauseStore?: AlgoPauseStore;
  emsStore?: EmsOrderStore;
}): Promise<OmsScheduleSliceResult> {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for schedule slice');
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
    return refuse(
      'not_live',
      `parent ${parentClientOrderId} is ${existing.status} — schedule slice needs a live (approved or running) parent`,
    );
  }
  const owner = existing.executionOwner?.trim() ?? '';
  if (!owner) {
    return refuse(
      'unattended',
      `parent ${parentClientOrderId} is unattended (no execution owner) — refusing to submit a child until claimed`,
    );
  }
  if (scheduleMissing(existing)) {
    return refuse(
      'missing_schedule',
      'retained schedule or startedAt is incomplete — refusing to invent slices, VWAP volume, or POV participation',
    );
  }
  const now = injectedNow(input.now);
  if (!now) {
    return refuse('missing_clock', 'now is required — refusing to invent a wall clock or host timer');
  }
  if (remainingMissing(existing)) {
    return refuse('missing_residual', 'residual.remaining is missing — refusing to invent leftover from duration or slicesPlanned');
  }

  if (!input.emsStore) {
    return refuse(
      'ems_store_unwired',
      'EMS evidence store is required for schedule slice — refusing to treat a missing store as no children',
    );
  }
  const emsStore = input.emsStore;

  const startedAt = existing.startedAt!.trim();
  const startedMs = Date.parse(startedAt);
  const sliceIntervalMs = existing.schedule.sliceIntervalMs;
  const slicesPlanned = existing.schedule.slicesPlanned;
  const taken = emsStore.list({ parentClientOrderId }).filter((row) => row.venueId.trim() !== '');
  const sliceIndex = taken.length;
  if (sliceIndex >= slicesPlanned) {
    return refuse('not_due', `parent ${parentClientOrderId} has taken ${sliceIndex} of ${slicesPlanned} planned slices`);
  }
  let lastTakenAtMs: number | null = null;
  for (const child of taken) {
    const recorded = child.recordedAtMs;
    if (!Number.isFinite(recorded)) {
      return refuse('missing_schedule', 'retained child recordedAtMs is incomplete — refusing to invent slice spacing');
    }
    if (lastTakenAtMs === null || recorded > lastTakenAtMs) lastTakenAtMs = recorded;
  }
  const dueAtMs = lastTakenAtMs === null ? startedMs : lastTakenAtMs + sliceIntervalMs;
  const dueAt = new Date(dueAtMs).toISOString();
  if (now.getTime() < dueAtMs) {
    return refuse(
      'not_due',
      `parent ${parentClientOrderId} next slice ${sliceIndex} due at ${dueAt} — injected clock is not past the schedule`,
    );
  }

  const sliced = await sliceLiveAlgoParent({
    parentClientOrderId,
    amount: input.amount,
    venueId: input.venueId,
    symbol: input.symbol,
    side: input.side,
    limitPrice: input.limitPrice,
    parentCap: input.parentCap,
    parentStore: input.parentStore,
    submit: input.submit,
    submitByVenue: input.submitByVenue,
    pauseStore: input.pauseStore,
    emsStore,
  });
  if (!sliced.ok) return sliced;

  emsStore.record({
    clientOrderId: sliced.child.clientOrderId,
    parentClientOrderId: sliced.parent.parentClientOrderId,
    executionGroupId: sliced.parent.parentClientOrderId,
    childOrderId: sliced.child.childOrderId,
    venueId: sliced.child.venueId,
    symbol: input.symbol!.trim(),
    side: input.side!,
    execution: sliced.execution,
    state: 'ACKNOWLEDGED',
    reconciliationKey: null,
    recordedAtMs: now.getTime(),
  });
  const retained = emsStore.list({ parentClientOrderId });
  const kept = retained.some((child) => child.clientOrderId === sliced.child.clientOrderId);
  if (!kept) {
    return refuse(
      'child_not_retained',
      `child ${sliced.child.clientOrderId} is not visible after record — refusing to report the slice as scheduled`,
    );
  }

  return {
    ...sliced,
    scheduled: true,
    sliceIndex,
    dueAt,
    slicesPlanned,
  };
}

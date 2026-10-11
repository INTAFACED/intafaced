/**
 * Drain one in-flight algo — stop slicing that parent or group.
 *
 * No new children. Existing children stop or the outcome is unknown.
 * Residual is confirmed filled plus remaining when every child is known.
 * This door never invents a canceled order and does not touch matching.
 */
import { add, formatAmount, ZERO, type Amount } from '@intafaced/ledger-client';
import type { VenueKind } from '@intafaced/venue-adapter';
import { cancelOmsOrder, type OmsCancelFn } from './oms-cancel.js';
import { venueOrderToExecution } from './oms-trade-submit.js';
import type { EmsOrderEvidence, EmsOrderStore } from './oms-ems-store.js';

export type OmsDrainInput = {
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly cancelByVenue?: Readonly<Record<string, OmsCancelFn>>;
  readonly emsStore?: EmsOrderStore;
  readonly kindsByVenue?: Readonly<Record<string, VenueKind>>;
};

export type OmsDrainChildOutcome = 'stopped' | 'unknown' | 'already_stopped';

export type OmsDrainChild = {
  readonly clientOrderId: string;
  readonly venueId: string;
  readonly outcome: OmsDrainChildOutcome;
  readonly status?: string;
  readonly reason?: string;
};

export type OmsDrainResidual = {
  readonly filled: string;
  readonly remaining: string | null;
};

export type OmsDrainOk = {
  readonly ok: true;
  readonly algo: { readonly parentClientOrderId?: string; readonly executionGroupId?: string };
  readonly children: readonly OmsDrainChild[];
  readonly residual: OmsDrainResidual;
};

export type OmsDrainRefuse =
  | { readonly ok: false; readonly reason: 'missing_algo'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ambiguous_algo'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string };

export type OmsDrainResult = OmsDrainOk | OmsDrainRefuse;

const TERMINAL_STOPPED = new Set(['canceled', 'filled', 'expired', 'rejected']);

type ResidualPiece = {
  readonly filled: Amount;
  readonly remaining: Amount;
};

function alreadyStopped(row: EmsOrderEvidence): boolean {
  return row.state === 'REJECTED' || row.state === 'UNWIRED' || row.state === 'CANCELED';
}

/** Stored terminal observations survive restart; legacy remaining is never backfilled. */
function storedResidual(row: EmsOrderEvidence): ResidualPiece | null {
  const execution = row.execution;
  if (row.drainedRemaining !== undefined) return { filled: execution?.filledAmount ?? ZERO, remaining: row.drainedRemaining };
  if (!execution) return null;
  return { filled: execution.filledAmount, remaining: row.drainedRemaining ?? ZERO };
}

function childKind(row: EmsOrderEvidence, kindsByVenue?: Readonly<Record<string, VenueKind>>): VenueKind | undefined {
  return kindsByVenue?.[row.venueId] ?? (row.venueId === 'internal' ? 'internal' : undefined);
}

function residualFromOrders(orders: readonly ResidualPiece[], unknown: boolean): OmsDrainResidual {
  let filled: Amount = ZERO;
  let remaining: Amount = ZERO;
  for (const order of orders) {
    filled = add(filled, order.filled);
    remaining = add(remaining, order.remaining);
  }
  return {
    filled: formatAmount(filled),
    remaining: unknown ? null : formatAmount(remaining),
  };
}

export async function drainInFlightAlgo(input: OmsDrainInput): Promise<OmsDrainResult> {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (parentClientOrderId && executionGroupId) {
    return { ok: false, reason: 'ambiguous_algo', detail: 'drain exactly one parentClientOrderId or one executionGroupId' };
  }
  if (!parentClientOrderId && !executionGroupId) {
    return { ok: false, reason: 'missing_algo', detail: 'parentClientOrderId or executionGroupId is required' };
  }
  if (!input.emsStore) {
    return { ok: false, reason: 'ems_store_unwired', detail: 'EMS evidence store is required for algo drain' };
  }

  const rows = input.emsStore.list(parentClientOrderId ? { parentClientOrderId } : { executionGroupId });
  const children: OmsDrainChild[] = [];
  const confirmed: ResidualPiece[] = [];
  let unknown = false;

  for (const row of rows) {
    // The execute door also journals a parent command fingerprint before planning.
    // It has no venue or execution and cannot supply a child's residual.
    if (!row.venueId.trim() && row.state === 'UNWIRED' && row.execution === null && row.requestFingerprint) continue;
    if (alreadyStopped(row)) {
      children.push({
        clientOrderId: row.clientOrderId,
        venueId: row.venueId,
        outcome: 'already_stopped',
        reason: row.state,
      });
      const stored = storedResidual(row);
      if (stored) confirmed.push(stored);
      if (row.drainedRemaining === undefined) unknown = true;
      continue;
    }

    const kind = childKind(row, input.kindsByVenue);
    if (kind === 'internal') {
      unknown = true;
      children.push({
        clientOrderId: row.clientOrderId,
        venueId: row.venueId,
        outcome: 'unknown',
        reason: 'internal_venue',
      });
      continue;
    }

    const cancelled = await cancelOmsOrder({
      venueId: row.venueId,
      symbol: row.symbol,
      clientOrderId: row.clientOrderId,
      kind,
      cancelByVenue: input.cancelByVenue,
      emsStore: input.emsStore,
    });

    if (!cancelled.ok) {
      unknown = true;
      children.push({
        clientOrderId: row.clientOrderId,
        venueId: row.venueId,
        outcome: 'unknown',
        reason: cancelled.reason,
      });
      continue;
    }

    if (TERMINAL_STOPPED.has(cancelled.order.status)) {
      confirmed.push({ filled: cancelled.order.filled, remaining: cancelled.order.remaining });
      // Preserve the actual terminal fill before marking the child stopped.
      const evidence = input.emsStore.get(row.clientOrderId);
      if (evidence) {
        const price = cancelled.order.averagePrice;
        if (price !== null && cancelled.order.venueOrderId) {
          const observed = venueOrderToExecution(cancelled.order, {
            symbol: row.symbol,
            side: row.side,
            amount: cancelled.order.amount,
            limitPrice: price,
            clientOrderId: row.clientOrderId,
          });
          input.emsStore.record({
            ...evidence,
            execution: { ...observed, averagePrice: price },
            state: 'CANCELED',
            drainedRemaining: cancelled.order.remaining,
          });
        } else if (cancelled.order.filled === ZERO) {
          input.emsStore.record({ ...evidence, execution: null, state: 'CANCELED', drainedRemaining: cancelled.order.remaining });
        }
      }
      children.push({
        clientOrderId: row.clientOrderId,
        venueId: row.venueId,
        outcome: 'stopped',
        status: cancelled.order.status,
      });
      continue;
    }

    unknown = true;
    // A still-working partial child supplies a fill, but never proves a stop.
    confirmed.push({ filled: cancelled.order.filled, remaining: ZERO });
    children.push({
      clientOrderId: row.clientOrderId,
      venueId: row.venueId,
      outcome: 'unknown',
      status: cancelled.order.status,
      reason: 'venue_status_unconfirmed',
    });
  }

  return {
    ok: true,
    algo: parentClientOrderId ? { parentClientOrderId } : { executionGroupId },
    children,
    residual: residualFromOrders(confirmed, unknown),
  };
}

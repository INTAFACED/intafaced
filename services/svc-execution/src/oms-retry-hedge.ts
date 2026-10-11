/**
 * Retry one listed failed EMS hedge child on a live TWAP/VWAP/POV parent.
 *
 * Reuses the failed-hedge list and the repair fill. Residual remaining is
 * the parent's retained leftover. Venue comes from the stored EMS child —
 * this door never invents a venue or fill, never submits a replacement
 * hedge, never posts ledger, and does not touch matching. Paper and
 * non-live parents refuse.
 */
import { formatAmount, MoneyError, parseAmount } from '@intafaced/ledger-client';
import { listFailedHedgeChildren, type OmsFailedHedgesRefuse } from './oms-failed-hedges.js';
import { repairFailedHedgeChild, type OmsRepairHedgeResidual } from './oms-repair-hedge.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import type { AlgoKind, ApprovedAlgoParentStore } from './oms-start.js';

export type OmsRetryHedgeInput = {
  readonly parentClientOrderId?: string;
  readonly clientOrderId?: string;
  readonly executionGroupId?: string;
  readonly parentStore?: ApprovedAlgoParentStore;
  readonly emsStore?: EmsOrderStore;
};

export type OmsRetryHedgeOk = {
  readonly ok: true;
  readonly retried: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: AlgoKind;
    readonly status: 'approved' | 'running';
  };
  readonly child: {
    readonly clientOrderId: string;
    readonly venueId: string;
    readonly outcome: 'retried';
    readonly reason: string;
  };
  readonly residual: OmsRepairHedgeResidual;
};

export type OmsRetryHedgeRefuse =
  | OmsFailedHedgesRefuse
  | { readonly ok: false; readonly reason: 'missing_child'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_only'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_listed'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'no_ems_evidence'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_parent_child'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_failed'; readonly detail: string };

export type OmsRetryHedgeResult = OmsRetryHedgeOk | OmsRetryHedgeRefuse;

function refuse(reason: 'missing_child' | 'parent_only' | 'not_listed', detail: string): OmsRetryHedgeRefuse {
  return { ok: false, reason, detail };
}

/** Blank, missing, or unparsable leftover stays null. Never invent "0". */
function retainedRemaining(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  try {
    return formatAmount(parseAmount(text));
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

export function retryFailedHedgeChild(input: OmsRetryHedgeInput): OmsRetryHedgeResult {
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (executionGroupId) {
    return refuse('parent_only', 'retry exactly one listed failed hedge child on one parentClientOrderId');
  }

  const listed = listFailedHedgeChildren({
    parentClientOrderId: input.parentClientOrderId,
    parentStore: input.parentStore,
    emsStore: input.emsStore,
  });
  if (!listed.ok) return listed;

  const clientOrderId = input.clientOrderId?.trim() ?? '';
  if (!clientOrderId) {
    return refuse('missing_child', 'clientOrderId of the listed failed hedge child is required');
  }

  const listedChild = listed.children.find((row) => row.clientOrderId === clientOrderId);
  if (!listedChild) {
    return refuse('not_listed', `child ${clientOrderId} is not a listed failed hedge on parent ${listed.parent.parentClientOrderId}`);
  }

  const repaired = repairFailedHedgeChild({
    parentClientOrderId: listed.parent.parentClientOrderId,
    clientOrderId,
    emsStore: input.emsStore,
  });
  if (!repaired.ok) return repaired;

  const parent = input.parentStore?.get(listed.parent.parentClientOrderId);
  return {
    ok: true,
    retried: true,
    parent: {
      parentClientOrderId: listed.parent.parentClientOrderId,
      kind: listed.parent.kind,
      status: listed.parent.status,
    },
    child: {
      clientOrderId: repaired.child.clientOrderId,
      venueId: listedChild.venueId,
      outcome: 'retried',
      reason: repaired.child.reason,
    },
    residual: {
      filled: repaired.residual.filled,
      remaining: retainedRemaining(parent?.residual?.remaining),
    },
  };
}

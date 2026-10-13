/**
 * Stop one running implementation-shortfall parent.
 * Children take no new. Residual stays on the parent. This door never
 * invents a canceled order and does not touch matching.
 */
import type { ApprovedAlgoParentStore } from './oms-start.js';

export type OmsIsStopRefuseReason = 'missing_parent' | 'not_running' | 'already_stopped' | 'not_live';

export type OmsIsStopRefusal = {
  readonly ok: false;
  readonly reason: OmsIsStopRefuseReason;
  readonly detail: string;
};

export type OmsIsStopOk = {
  readonly ok: true;
  readonly stopped: true;
  readonly parent: {
    readonly parentClientOrderId: string;
    readonly kind: 'implementation_shortfall';
  };
  readonly childrenTakeNew: false;
  readonly residual: { readonly remaining: string | null };
};

export type OmsIsStopResult = OmsIsStopOk | OmsIsStopRefusal;

function refuse(reason: OmsIsStopRefuseReason, detail: string): OmsIsStopRefusal {
  return { ok: false, reason, detail };
}

function parentRemaining(parentStore: ApprovedAlgoParentStore | undefined, parentClientOrderId: string): string | null {
  if (!parentStore) return null;
  const remaining = parentStore.get(parentClientOrderId)?.residual?.remaining?.trim() ?? '';
  return remaining || null;
}

/**
 * Stop a running IS parent. Existing children stay as recorded.
 * Residual is not released or consumed.
 */
export function stopImplementationShortfallParent(input: {
  parentClientOrderId?: string;
  kind?: string;
  status?: string;
  parentStore?: ApprovedAlgoParentStore;
}): OmsIsStopResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (input.kind !== undefined && input.kind !== 'implementation_shortfall') {
    return refuse('not_live', `kind ${String(input.kind)} is not implementation_shortfall`);
  }
  const status = input.status?.trim() ?? '';
  if (status === 'stopped') {
    return refuse('already_stopped', `parent ${parentClientOrderId} is already stopped`);
  }
  if (status !== 'running') {
    return refuse('not_running', `parent ${parentClientOrderId} is not running`);
  }

  const remaining = parentRemaining(input.parentStore, parentClientOrderId);
  return {
    ok: true,
    stopped: true,
    parent: { parentClientOrderId, kind: 'implementation_shortfall' },
    childrenTakeNew: false,
    residual: { remaining },
  };
}

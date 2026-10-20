/**
 * Operator kill — stop one live TWAP/VWAP/POV parent.
 *
 * Reuses cancel-remaining. Children stop or the outcome is unknown.
 * An unknown child cancel is not killed: true and does not stop the parent.
 * A successful matching delete stays beside the EMS children. When those book
 * orders are already gone and an EMS child is unknown, the parent is paused.
 * A refused or unconfirmed matching cancel still cancels street children and
 * pauses, so a running parent takes no later slice. A null kill or stop still
 * returns those canceled children with not_live. Unknown filled stays
 * unknown — this door does not invent a zero fill.
 * Matching never-saw (404) / ack without sequence is unknown — never killed
 * from silence. Cancel is a request until matching sequence. This door never
 * invents a canceled order, a matching sequence, or a silent-success missing
 * parent. Claimed parents are in scope (unattended kill is the unowned
 * night-desk door).
 */
import type { VenueKind } from '@intafaced/venue-adapter';
import { cancelRemainingParentChildren, type OmsCancelRemainingRefuse } from './oms-cancel-remaining.js';
import type { OmsCancelFn } from './oms-cancel.js';
import type { OmsDrainChild, OmsDrainResidual } from './oms-drain.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import type { AlgoPauseStore } from './oms-pause.js';
import type { AlgoKind, ApprovedAlgoParentStore } from './oms-start.js';
import {
  cancelKillParentMatching,
  type OmsKillParentMatchingChild,
  type OmsKillParentMatchingRefusal,
  type OmsMatchingS2s,
} from './oms-kill-parent-matching.js';

export type OmsKillParentResidual = {
  readonly filled: string | null;
  readonly remaining: string | null;
};

export type OmsKillParentOk = {
  readonly ok: true;
  readonly killed: boolean;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly children: readonly OmsDrainChild[];
  readonly residual: OmsKillParentResidual;
};

export type OmsKillParentRefuse =
  | OmsCancelRemainingRefuse
  | OmsKillParentMatchingRefusal
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'pause_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'not_live';
      readonly detail: string;
      readonly children?: readonly OmsDrainChild[];
    }
  | { readonly ok: false; readonly reason: 'missing_operator'; readonly detail: string };

export type OmsKillParentResult = OmsKillParentOk | OmsKillParentRefuse;

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: Exclude<OmsKillParentRefuse['reason'], OmsCancelRemainingRefuse['reason']>, detail: string): OmsKillParentRefuse {
  return { ok: false, reason, detail };
}

function liveStatus(status: string): boolean {
  return status === 'approved' || status === 'running';
}

function operatorOf(operatorId?: string): string {
  return operatorId?.trim() ?? '';
}

function childrenKnown(children: readonly OmsDrainChild[]): boolean {
  return children.every((child) => child.outcome === 'stopped' || child.outcome === 'already_stopped');
}

/** A zero fill with unknown remaining was not observed. Leave filled unknown. */
function residualAfterUnconfirmedMatching(residual: OmsDrainResidual): OmsKillParentResidual {
  if (residual.remaining === null && residual.filled === '0') {
    return { filled: null, remaining: null };
  }
  return residual;
}

export async function killLiveAlgoParent(input: {
  parentClientOrderId?: string;
  executionGroupId?: string;
  operatorId?: string;
  parentStore?: ApprovedAlgoParentStore;
  pauseStore?: AlgoPauseStore;
  emsStore?: EmsOrderStore;
  cancelByVenue?: Readonly<Record<string, OmsCancelFn>>;
  kindsByVenue?: Readonly<Record<string, VenueKind>>;
  matchingUrl?: string | null;
  matchingChildren?: readonly OmsKillParentMatchingChild[] | null;
  fetch?: typeof fetch;
  internalServiceSecret?: string;
  /** svc-execution's own key for the matching cancels. */
  matchingS2s?: OmsMatchingS2s;
}): Promise<OmsKillParentResult> {
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (executionGroupId) {
    return { ok: false, reason: 'parent_only', detail: 'kill exactly one parentClientOrderId' };
  }
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return { ok: false, reason: 'missing_parent', detail: 'parentClientOrderId is required' };
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for operator kill');
  }
  const operatorId = operatorOf(input.operatorId);
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  if (!input.pauseStore) {
    return refuse('pause_store_unwired', 'pause store is required for operator kill');
  }
  if (!input.emsStore) {
    return { ok: false, reason: 'ems_store_unwired', detail: 'EMS evidence store is required for operator kill' };
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status === 'paper') {
    return refuse('paper', `parent ${parentClientOrderId} is paper — refusing to kill a paper parent`);
  }
  if (!liveStatus(existing.status)) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${existing.status} — kill needs a live (approved or running) parent`);
  }
  if (existing.status === 'approved' && typeof input.parentStore.kill !== 'function') {
    return refuse('parent_store_unwired', 'approved algo parent store.kill is required to stop an approved parent');
  }

  const matchingChildren = input.matchingChildren;
  let matchingRefusal: OmsKillParentMatchingRefusal | null = null;
  let matchingUnconfirmedChildren: readonly OmsDrainChild[] | null = null;
  let matchingStoppedChildren: readonly OmsDrainChild[] = [];
  if (matchingChildren && matchingChildren.length > 0) {
    const matching = await cancelKillParentMatching({
      children: matchingChildren,
      matchingUrl: input.matchingUrl,
      fetch: input.fetch,
      internalServiceSecret: input.internalServiceSecret,
      s2s: input.matchingS2s,
    });
    if (!matching.ok) {
      matchingRefusal = matching;
    } else if (!matching.killed) {
      matchingUnconfirmedChildren = matching.children;
    } else {
      matchingStoppedChildren = matching.children;
    }
  }

  const cancelled = await cancelRemainingParentChildren({
    parentClientOrderId,
    cancelByVenue: input.cancelByVenue,
    emsStore: input.emsStore,
    kindsByVenue: input.kindsByVenue,
  });
  if (matchingRefusal || matchingUnconfirmedChildren) {
    input.pauseStore.pause({ kind: 'parent', id: parentClientOrderId });
  }
  if (!cancelled.ok) {
    return cancelled;
  }
  if (matchingRefusal) {
    return matchingRefusal;
  }
  if (matchingUnconfirmedChildren) {
    return {
      ok: true,
      killed: false,
      parent: { parentClientOrderId: existing.parentClientOrderId, kind: existing.kind },
      children: [...matchingUnconfirmedChildren, ...cancelled.children],
      residual: residualAfterUnconfirmedMatching(cancelled.residual),
    };
  }

  const children = [...matchingStoppedChildren, ...cancelled.children];

  if (!childrenKnown(cancelled.children)) {
    if (matchingStoppedChildren.length > 0) {
      input.pauseStore.pause({ kind: 'parent', id: parentClientOrderId });
    }
    return {
      ok: true,
      killed: false,
      parent: { parentClientOrderId: existing.parentClientOrderId, kind: existing.kind },
      children,
      residual: cancelled.residual,
    };
  }

  input.pauseStore.pause({ kind: 'parent', id: parentClientOrderId });

  const stopped =
    typeof input.parentStore.kill === 'function'
      ? input.parentStore.kill(parentClientOrderId)
      : input.parentStore.stop(parentClientOrderId);
  if (!stopped) {
    return {
      ok: false,
      reason: 'not_live',
      detail: `parent ${parentClientOrderId} could not be stopped`,
      children,
    };
  }

  return {
    ok: true,
    killed: true,
    parent: { parentClientOrderId: stopped.parentClientOrderId, kind: stopped.kind },
    children,
    residual: cancelled.residual,
  };
}

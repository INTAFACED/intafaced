/**
 * Pass, accept, reject, or timeout a live claimed TWAP/VWAP/POV parent.
 *
 * Current owner offers a named target with a caller-supplied expireAt.
 * Until accept, the passer stays the execution owner. Accept transfers
 * ownership; reject or timeout leaves it with the passer. Missing
 * expireAt refuses — this door never invents a duration or wall clock,
 * never invents an operator, never steals, never places children, and
 * does not touch matching. Unconfirmed EMS fills on the parent refuse
 * the offer and the accept — handoff must not hide prints from the incoming owner.
 */
import type { EmsOrderStore } from './oms-ems-store.js';
import type { FillConfirmStore } from './oms-fill-confirm.js';
import type { AlgoKind, ApprovedAlgoParent, ApprovedAlgoParentStore } from './oms-start.js';
import { refuseUnconfirmedHandoff } from './oms-unconfirmed.js';

export type OmsPassOk = {
  readonly ok: true;
  readonly passed: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly executionOwner: string;
  readonly pendingPassTo: string;
  readonly pendingPassExpireAt: string;
};

export type OmsPassAcceptOk = {
  readonly ok: true;
  readonly accepted: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly executionOwner: string;
  readonly pendingPassTo: null;
};

export type OmsPassRejectOk = {
  readonly ok: true;
  readonly rejected: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly executionOwner: string;
  readonly pendingPassTo: null;
};

export type OmsPassTimeoutOk = {
  readonly ok: true;
  readonly timedOut: true;
  readonly parent: { readonly parentClientOrderId: string; readonly kind: AlgoKind };
  readonly executionOwner: string;
  readonly pendingPassTo: null;
  readonly expireAt: string;
};

export type OmsPassRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'paper'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_live'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_operator'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_target'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unowned'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_owner'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'self_pass'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_passing'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'no_pass_pending'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_target'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_expire_at'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_clock'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_due'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'fill_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unconfirmed_fills'; readonly detail: string };

export type OmsPassResult = OmsPassOk | OmsPassRefuse;
export type OmsPassAcceptResult = OmsPassAcceptOk | OmsPassRefuse;
export type OmsPassRejectResult = OmsPassRejectOk | OmsPassRefuse;
export type OmsPassTimeoutResult = OmsPassTimeoutOk | OmsPassRefuse;

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsPassRefuse['reason'], detail: string): OmsPassRefuse {
  return { ok: false, reason, detail };
}

function liveStatus(status: string): boolean {
  return status === 'approved' || status === 'running';
}

function operatorOf(operatorId?: string): string {
  return operatorId?.trim() ?? '';
}

function ownerOf(parent: ApprovedAlgoParent): string | null {
  const owner = parent.executionOwner?.trim() ?? '';
  return owner || null;
}

function pendingOf(parent: ApprovedAlgoParent): string | null {
  const pending = parent.pendingPassTo?.trim() ?? '';
  return pending || null;
}

function retainedPassExpireAt(raw?: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return trimmed;
}

function injectedNow(now?: Date): Date | null {
  if (!(now instanceof Date)) return null;
  const ms = now.getTime();
  if (!Number.isFinite(ms)) return null;
  return now;
}

function locateLiveParent(input: {
  parentClientOrderId?: string;
  operatorId?: string;
  parentStore?: ApprovedAlgoParentStore;
  requireOperator?: boolean;
}): { ok: true; parent: ApprovedAlgoParent; operatorId: string } | OmsPassRefuse {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for pass');
  }
  const operatorId = operatorOf(input.operatorId);
  if (input.requireOperator !== false && !operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status === 'paper') {
    return refuse('paper', `parent ${parentClientOrderId} is paper — refusing to pass a paper parent`);
  }
  if (!liveStatus(existing.status)) {
    return refuse('not_live', `parent ${parentClientOrderId} is ${existing.status} — pass needs a live (approved or running) parent`);
  }
  return { ok: true, parent: existing, operatorId };
}

export function passLiveAlgoParent(input: {
  parentClientOrderId?: string;
  operatorId?: string;
  targetOperatorId?: string;
  expireAt?: string;
  parentStore?: ApprovedAlgoParentStore;
  emsStore?: EmsOrderStore;
  fillConfirmStore?: FillConfirmStore;
}): OmsPassResult {
  const located = locateLiveParent(input);
  if (!located.ok) return located;
  const targetOperatorId = operatorOf(input.targetOperatorId);
  if (!targetOperatorId) {
    return refuse('missing_target', 'target operator id is required — refusing to invent a user');
  }
  const current = ownerOf(located.parent);
  if (!current) {
    return refuse('unowned', `parent ${located.parent.parentClientOrderId} is unowned — claim it before pass`);
  }
  if (current !== located.operatorId) {
    return refuse('not_owner', `parent ${located.parent.parentClientOrderId} is claimed by ${current} — refusing steal`);
  }
  if (targetOperatorId === current) {
    return refuse('self_pass', `parent ${located.parent.parentClientOrderId} is already owned by ${current}`);
  }
  const pending = pendingOf(located.parent);
  if (pending && pending !== targetOperatorId) {
    return refuse('already_passing', `parent ${located.parent.parentClientOrderId} already has a pass pending to ${pending}`);
  }
  const expireAt = retainedPassExpireAt(input.expireAt);
  if (!expireAt) {
    return refuse('missing_expire_at', 'expireAt is required — refusing to invent a pass timeout from duration or the clock');
  }
  if (!input.parentStore?.offerPass) {
    return refuse('parent_store_unwired', 'approved algo parent store.offerPass is required for pass');
  }
  const fence = refuseUnconfirmedHandoff(
    {
      parentClientOrderId: located.parent.parentClientOrderId,
      parentStore: input.parentStore,
      emsStore: input.emsStore,
      fillConfirmStore: input.fillConfirmStore,
    },
    'pass',
  );
  if (!fence.ok) return fence;
  const offered = input.parentStore.offerPass(located.parent.parentClientOrderId, located.operatorId, targetOperatorId, expireAt);
  if (!offered) {
    return refuse('not_owner', `parent ${located.parent.parentClientOrderId} is not claimed by this operator`);
  }
  const executionOwner = ownerOf(offered);
  const pendingPassTo = pendingOf(offered);
  const pendingPassExpireAt = retainedPassExpireAt(offered.pendingPassExpireAt);
  if (!executionOwner || !pendingPassTo) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  if (!pendingPassExpireAt) {
    return refuse('missing_expire_at', 'expireAt is required — refusing to invent a pass timeout from duration or the clock');
  }
  return {
    ok: true,
    passed: true,
    parent: { parentClientOrderId: offered.parentClientOrderId, kind: offered.kind },
    executionOwner,
    pendingPassTo,
    pendingPassExpireAt,
  };
}

export function acceptLiveAlgoParentPass(input: {
  parentClientOrderId?: string;
  operatorId?: string;
  parentStore?: ApprovedAlgoParentStore;
  emsStore?: EmsOrderStore;
  fillConfirmStore?: FillConfirmStore;
}): OmsPassAcceptResult {
  const located = locateLiveParent(input);
  if (!located.ok) return located;
  const pending = pendingOf(located.parent);
  if (!pending) {
    return refuse('no_pass_pending', `parent ${located.parent.parentClientOrderId} has no pass to accept`);
  }
  if (pending !== located.operatorId) {
    return refuse('not_target', `parent ${located.parent.parentClientOrderId} is offered to ${pending} — refusing steal`);
  }
  if (!input.parentStore?.acceptPass) {
    return refuse('parent_store_unwired', 'approved algo parent store.acceptPass is required for accept');
  }
  const fence = refuseUnconfirmedHandoff(
    {
      parentClientOrderId: located.parent.parentClientOrderId,
      parentStore: input.parentStore,
      emsStore: input.emsStore,
      fillConfirmStore: input.fillConfirmStore,
    },
    'accept',
  );
  if (!fence.ok) return fence;
  const accepted = input.parentStore.acceptPass(located.parent.parentClientOrderId, located.operatorId);
  if (!accepted) {
    return refuse('not_target', `parent ${located.parent.parentClientOrderId} is not offered to this operator`);
  }
  const executionOwner = ownerOf(accepted);
  if (!executionOwner) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  return {
    ok: true,
    accepted: true,
    parent: { parentClientOrderId: accepted.parentClientOrderId, kind: accepted.kind },
    executionOwner,
    pendingPassTo: null,
  };
}

export function rejectLiveAlgoParentPass(input: {
  parentClientOrderId?: string;
  operatorId?: string;
  parentStore?: ApprovedAlgoParentStore;
}): OmsPassRejectResult {
  const located = locateLiveParent(input);
  if (!located.ok) return located;
  const pending = pendingOf(located.parent);
  if (!pending) {
    return refuse('no_pass_pending', `parent ${located.parent.parentClientOrderId} has no pass to reject`);
  }
  if (pending !== located.operatorId) {
    return refuse('not_target', `parent ${located.parent.parentClientOrderId} is offered to ${pending} — refusing steal`);
  }
  if (!input.parentStore?.rejectPass) {
    return refuse('parent_store_unwired', 'approved algo parent store.rejectPass is required for reject');
  }
  const rejected = input.parentStore.rejectPass(located.parent.parentClientOrderId, located.operatorId);
  if (!rejected) {
    return refuse('not_target', `parent ${located.parent.parentClientOrderId} is not offered to this operator`);
  }
  const executionOwner = ownerOf(rejected);
  if (!executionOwner) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  return {
    ok: true,
    rejected: true,
    parent: { parentClientOrderId: rejected.parentClientOrderId, kind: rejected.kind },
    executionOwner,
    pendingPassTo: null,
  };
}

export function timeoutLiveAlgoParentPass(input: {
  parentClientOrderId?: string;
  parentStore?: ApprovedAlgoParentStore;
  now?: Date;
}): OmsPassTimeoutResult {
  const located = locateLiveParent({ ...input, requireOperator: false });
  if (!located.ok) return located;
  const pending = pendingOf(located.parent);
  if (!pending) {
    return refuse('no_pass_pending', `parent ${located.parent.parentClientOrderId} has no pass to timeout`);
  }
  const expireAt = retainedPassExpireAt(located.parent.pendingPassExpireAt);
  if (!expireAt) {
    return refuse('missing_expire_at', 'pendingPassExpireAt is missing — refusing to invent a pass timeout from duration or the clock');
  }
  const now = injectedNow(input.now);
  if (!now) {
    return refuse('missing_clock', 'now is required — refusing to invent a wall clock');
  }
  if (now.getTime() < Date.parse(expireAt)) {
    return refuse(
      'not_due',
      `parent ${located.parent.parentClientOrderId} pass expires at ${expireAt} — injected clock is not past the deadline`,
    );
  }
  if (!input.parentStore?.timeoutPass) {
    return refuse('parent_store_unwired', 'approved algo parent store.timeoutPass is required for pass timeout');
  }
  const timedOut = input.parentStore.timeoutPass(located.parent.parentClientOrderId);
  if (!timedOut) {
    return refuse('missing_expire_at', 'pendingPassExpireAt is missing — refusing to invent a pass timeout from duration or the clock');
  }
  const executionOwner = ownerOf(timedOut);
  if (!executionOwner) {
    return refuse('unowned', `parent ${timedOut.parentClientOrderId} is unowned — timeout cannot invent an owner`);
  }
  return {
    ok: true,
    timedOut: true,
    parent: { parentClientOrderId: timedOut.parentClientOrderId, kind: timedOut.kind },
    executionOwner,
    pendingPassTo: null,
    expireAt,
  };
}

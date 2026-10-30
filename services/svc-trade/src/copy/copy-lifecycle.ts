/**
 * Follower copy control (PTX-M26-R05).
 *
 * PAUSE_NEW fences new mirrors immediately; existing orders/positions continue.
 * STOP_NEW fences new intent and revokes the session grant; it does not flatten.
 * STOP_CLOSE_ONLY (CB-copy-09) fences new intent and keeps the session grant, so the
 * copy driver still mirrors the leader's closes, capped at the copied position still
 * open. It does not flatten either.
 * DETACH_KEEP stops copying and leaves existing orders/positions with the follower.
 * Flatten is a separate explicit choice (`copy.flatten`) — these doors never call it.
 */

import { CopyError } from './errors.js';
import type { CopyFollow } from './follows.js';

export const COPY_RELATIONSHIP_STATES = ['ACTIVE', 'PAUSED', 'STOPPING', 'CLOSE_ONLY', 'DETACHED'] as const;
export type CopyRelationshipState = (typeof COPY_RELATIONSHIP_STATES)[number];

export const COPY_CONTROL_DISPOSITIONS = ['PAUSE_NEW', 'STOP_NEW', 'STOP_CLOSE_ONLY', 'DETACH_KEEP', 'RESUME'] as const;
export type CopyControlDisposition = (typeof COPY_CONTROL_DISPOSITIONS)[number];

export type CopyControlAck = {
  readonly followId: string;
  readonly relationshipState: CopyRelationshipState;
  readonly disposition: CopyControlDisposition;
  readonly newIntentFenced: boolean;
  readonly flattenInvented: false;
  readonly sessionKeyRevoked: boolean;
};

export function parseCopyRelationshipState(raw: unknown): CopyRelationshipState {
  if (raw === undefined || raw === null || raw === '') return 'ACTIVE';
  const value = String(raw);
  if ((COPY_RELATIONSHIP_STATES as readonly string[]).includes(value)) {
    return value as CopyRelationshipState;
  }
  // Unrecognized (corrupt) state fails closed: fence new intents rather than resume copying.
  return 'PAUSED';
}

export function followRelationshipState(follow: CopyFollow): CopyRelationshipState {
  return follow.relationshipState ?? 'ACTIVE';
}

export function copyNewIntentFenced(state: CopyRelationshipState): boolean {
  return state !== 'ACTIVE';
}

export function requireCopyFollowId(followId: string | undefined | null): string {
  const id = typeof followId === 'string' ? followId.trim() : '';
  if (!id) {
    throw new CopyError('Follow id is required', 'trade.copy_not_following');
  }
  return id;
}

export function requireNewCopyIntentAllowed(follow: CopyFollow): void {
  const state = followRelationshipState(follow);
  if (state === 'ACTIVE') return;
  if (state === 'PAUSED') {
    throw new CopyError('Copy is paused — new mirrors are fenced immediately', 'trade.copy_paused');
  }
  if (state === 'STOPPING' || state === 'CLOSE_ONLY') {
    throw new CopyError('Copy is stopped — new intent is fenced; no flatten invented', 'trade.copy_stopped');
  }
  throw new CopyError('Copy is detached — new mirrors are refused; positions stay with the follower', 'trade.copy_detached');
}

export function presentCopyControlAck<D extends CopyControlDisposition>(
  follow: CopyFollow,
  disposition: D,
): CopyControlAck & { readonly disposition: D } {
  const relationshipState = followRelationshipState(follow);
  return {
    followId: follow.followId,
    relationshipState,
    disposition,
    newIntentFenced: copyNewIntentFenced(relationshipState),
    flattenInvented: false,
    sessionKeyRevoked: follow.sessionKeyRevoked === true,
  };
}

export function applyCopyPause(follow: CopyFollow): CopyFollow {
  const state = followRelationshipState(follow);
  if (state === 'PAUSED') return { ...follow, relationshipState: 'PAUSED' };
  if (state !== 'ACTIVE') {
    throw new CopyError(`Cannot pause a ${state} copy follow`, 'trade.copy_state_invalid');
  }
  return { ...follow, relationshipState: 'PAUSED' };
}

export function applyCopyResume(follow: CopyFollow): CopyFollow {
  const state = followRelationshipState(follow);
  if (state === 'ACTIVE') return { ...follow, relationshipState: 'ACTIVE' };
  if (state !== 'PAUSED') {
    throw new CopyError(`Cannot resume a ${state} copy follow`, 'trade.copy_state_invalid');
  }
  return { ...follow, relationshipState: 'ACTIVE' };
}

export function applyCopyStop(follow: CopyFollow): CopyFollow {
  const state = followRelationshipState(follow);
  if (state === 'STOPPING') {
    return { ...follow, relationshipState: 'STOPPING', sessionKeyRevoked: true };
  }
  if (state === 'DETACHED') {
    throw new CopyError('Cannot stop a DETACHED copy follow', 'trade.copy_state_invalid');
  }
  return { ...follow, relationshipState: 'STOPPING', sessionKeyRevoked: true };
}

/** STOP_CLOSE_ONLY: no new opens; the grant stays so the leader's closes still close. A revoked stop cannot come back. */
export function applyCopyStopCloseOnly(follow: CopyFollow): CopyFollow {
  const state = followRelationshipState(follow);
  if (state !== 'ACTIVE' && state !== 'PAUSED' && state !== 'CLOSE_ONLY') {
    throw new CopyError(`Cannot stop a ${state} copy follow with close-only`, 'trade.copy_state_invalid');
  }
  return { ...follow, relationshipState: 'CLOSE_ONLY' };
}

export function applyCopyDetach(follow: CopyFollow): CopyFollow {
  return { ...follow, relationshipState: 'DETACHED', sessionKeyRevoked: true };
}

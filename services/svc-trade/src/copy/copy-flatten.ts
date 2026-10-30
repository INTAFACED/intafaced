/**
 * Explicit follower flatten (PTX-M26-R05).
 *
 * One door that closes the follower's copy position. Pause / stop / detach
 * never call this — flatten is a separate follower choice, not implied.
 * Missing follow is refused by the caller before this runs.
 * The port submits ordinary reduce-risk orders; this never invents a fill.
 */
import type { Principal } from '@intafaced/auth';
import { CopyError } from './errors.js';
import type { CopyFollow } from './follows.js';
import { applyCopyDetach } from './copy-lifecycle.js';

export const COPY_FLATTEN_DISPOSITION = 'DETACH_FLATTEN' as const;
export type CopyFlattenDisposition = typeof COPY_FLATTEN_DISPOSITION;

export const COPY_FLATTEN_REFUSED_RESIDUAL =
  'trade.copy flatten is refuse-closed until the follower flatten port is wired — never invent a close';

export type FlattenCopyPositionInput = {
  readonly followId: string;
  readonly followerId: string;
  /** Only find the closes already placed under their business keys; never place one (a replay on a left follow, #6920). */
  readonly lookupOnly?: boolean;
};

export type FlattenCopyRefuse = 'drift' | 'unavailable' | 'partial';

export type FlattenCopyPositionResult = {
  readonly orderIds: readonly string[];
  readonly refuse?: FlattenCopyRefuse;
  /** Lookup only: a leg still held has no close under its business key. */
  readonly unplaced?: boolean;
};

export type FlattenCopyPositionPort = (principal: Principal, input: FlattenCopyPositionInput) => Promise<FlattenCopyPositionResult>;

export const COPY_FLATTEN_DRIFT_RESIDUAL = 'copy.flatten refuses when the close drifted — never invent a flatten';

export const COPY_FLATTEN_UNAVAILABLE_RESIDUAL = 'copy.flatten refuses when the close is unavailable — never invent a flatten';

export const COPY_FLATTEN_PARTIAL_RESIDUAL =
  'copy.flatten placed some closes and refused the rest — the follow stays fenced and is not detached';

export type CopyFlattenAck = {
  readonly followId: string;
  readonly relationshipState: 'DETACHED';
  readonly disposition: CopyFlattenDisposition;
  readonly newIntentFenced: true;
  readonly flattenChosen: true;
  readonly flattenInvented: false;
  readonly sessionKeyRevoked: true;
  readonly orderIds: readonly string[];
};

/** Same fence as detach — flatten then closes; pause/stop never import this. */
export function applyCopyFlatten(follow: CopyFollow): CopyFollow {
  return applyCopyDetach(follow);
}

export function presentCopyFlattenAck(follow: CopyFollow, orderIds: readonly string[]): CopyFlattenAck {
  return {
    followId: follow.followId,
    relationshipState: 'DETACHED',
    disposition: COPY_FLATTEN_DISPOSITION,
    newIntentFenced: true,
    flattenChosen: true,
    flattenInvented: false,
    sessionKeyRevoked: true,
    orderIds,
  };
}

/**
 * The flatten door. Pause/stop/detach must not call this.
 * Unwired port refuses rather than inventing a close.
 */
export async function flattenFollowerCopyPosition(
  principal: Principal,
  follow: CopyFollow,
  port: FlattenCopyPositionPort | null,
): Promise<{ orderIds: readonly string[] }> {
  if (!port) {
    throw new CopyError(
      'copy.flatten is refuse-closed until the follower flatten port is wired — never invent a close',
      'trade.copy_flatten_refused',
      COPY_FLATTEN_REFUSED_RESIDUAL,
    );
  }
  const closed = await port(principal, { followId: follow.followId, followerId: follow.followerId });
  if (closed.refuse === 'drift') {
    throw new CopyError(
      'copy.flatten refuses when the close drifted — never invent a flatten',
      'trade.copy_flatten_drift',
      COPY_FLATTEN_DRIFT_RESIDUAL,
    );
  }
  if (closed.refuse === 'unavailable') {
    throw new CopyError(
      'copy.flatten refuses when the close is unavailable — never invent a flatten',
      'trade.copy_flatten_unavailable',
      COPY_FLATTEN_UNAVAILABLE_RESIDUAL,
    );
  }
  if (closed.refuse === 'partial') {
    const orderIds = closed.orderIds;
    throw new CopyError(
      orderIds.length > 0
        ? `copy.flatten placed some closes and refused the rest — follow stays fenced (orderIds: ${orderIds.join(',')})`
        : 'copy.flatten placed some closes and refused the rest — follow stays fenced',
      'trade.copy_flatten_partial',
      COPY_FLATTEN_PARTIAL_RESIDUAL,
      orderIds,
    );
  }
  return { orderIds: closed.orderIds };
}

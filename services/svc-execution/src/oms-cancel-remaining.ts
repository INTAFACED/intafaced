/**
 * Cancel remaining children of one parent algo.
 *
 * Parent only. Reuses drain's cancel path so residual is confirmed
 * filled plus remaining when every child is known. This door never
 * invents a canceled order and does not touch matching.
 */
import type { VenueKind } from '@intafaced/venue-adapter';
import { drainInFlightAlgo, type OmsDrainChild, type OmsDrainResidual } from './oms-drain.js';
import type { OmsCancelFn } from './oms-cancel.js';
import type { EmsOrderStore } from './oms-ems-store.js';

export type OmsCancelRemainingInput = {
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  readonly cancelByVenue?: Readonly<Record<string, OmsCancelFn>>;
  readonly emsStore?: EmsOrderStore;
  readonly kindsByVenue?: Readonly<Record<string, VenueKind>>;
};

export type OmsCancelRemainingOk = {
  readonly ok: true;
  readonly parent: { readonly parentClientOrderId: string };
  readonly children: readonly OmsDrainChild[];
  readonly residual: OmsDrainResidual;
};

export type OmsCancelRemainingRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_only'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'ems_store_unwired'; readonly detail: string };

export type OmsCancelRemainingResult = OmsCancelRemainingOk | OmsCancelRemainingRefuse;

export async function cancelRemainingParentChildren(input: OmsCancelRemainingInput): Promise<OmsCancelRemainingResult> {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (executionGroupId) {
    return {
      ok: false,
      reason: 'parent_only',
      detail: 'cancel remaining children of exactly one parentClientOrderId',
    };
  }
  if (!parentClientOrderId) {
    return { ok: false, reason: 'missing_parent', detail: 'parentClientOrderId is required' };
  }

  const drained = await drainInFlightAlgo({
    parentClientOrderId,
    cancelByVenue: input.cancelByVenue,
    emsStore: input.emsStore,
    kindsByVenue: input.kindsByVenue,
  });
  if (!drained.ok) {
    if (drained.reason === 'ems_store_unwired') {
      return { ok: false, reason: 'ems_store_unwired', detail: drained.detail };
    }
    return { ok: false, reason: 'missing_parent', detail: drained.detail };
  }

  return {
    ok: true,
    parent: { parentClientOrderId },
    children: drained.children,
    residual: drained.residual,
  };
}

/**
 * OMS cancel door — cancel by client order id on an injected venue fn.
 *
 * TradeAdapter.cancelOrder is client-id first (a pending order has no venue id).
 * Does not invent a canceled status: if the venue still says open/filled, that
 * result is returned. Missing injection or throw is `cancel_failed`.
 */
import type { VenueExecution, VenueKind } from '@intafaced/venue-adapter';
import type { VenueOrder } from '@intafaced/venue-contracts';
import { venueOrderToExecution } from './oms-trade-submit.js';
import type { EmsOrderStore } from './oms-ems-store.js';

export type OmsCancelFn = (symbol: string, clientOrderId: string) => Promise<VenueOrder>;

export type OmsCancelInput = {
  readonly venueId: string;
  readonly symbol: string;
  readonly clientOrderId: string;
  readonly kind?: VenueKind;
  readonly cancelByVenue?: Readonly<Record<string, OmsCancelFn>>;
  /** Optional EMS reconciliation sink for a previously unknown child. */
  readonly emsStore?: EmsOrderStore;
};

export type OmsCancelOk = { readonly ok: true; readonly order: VenueOrder };
export type OmsCancelRefuse =
  | { readonly ok: false; readonly reason: 'internal_venue'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'cancel_failed'; readonly detail: string };

export type OmsCancelResult = OmsCancelOk | OmsCancelRefuse;

function cancelErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function cancelOmsOrder(input: OmsCancelInput): Promise<OmsCancelResult> {
  if (input.kind === 'internal') {
    return {
      ok: false,
      reason: 'internal_venue',
      detail: `refusing cancel on internal venue ${input.venueId}`,
    };
  }

  const clientOrderId = input.clientOrderId.trim();
  const symbol = input.symbol.trim();
  const venueId = input.venueId.trim();
  if (!venueId || !symbol || !clientOrderId) {
    return { ok: false, reason: 'cancel_failed', detail: 'venueId, symbol, and clientOrderId are required' };
  }

  const cancel = input.cancelByVenue?.[venueId];
  if (!cancel) {
    return { ok: false, reason: 'cancel_failed', detail: `no cancel injected for venue ${venueId}` };
  }

  let order: VenueOrder;
  try {
    order = await cancel(symbol, clientOrderId);
  } catch (err) {
    return { ok: false, reason: 'cancel_failed', detail: cancelErrorMessage(err) };
  }

  if (order.status === 'pending') {
    return {
      ok: false,
      reason: 'cancel_failed',
      detail: 'venue cancel is still pending — refusing to invent canceled',
    };
  }

  const evidence = input.emsStore?.get(clientOrderId);
  if (evidence && !matchesRetainedSliceIntent(evidence, order)) {
    return { ok: false, reason: 'cancel_failed', detail: 'venue observation does not match the retained slice intent' };
  }
  if (evidence && (order.status === 'filled' || order.status === 'partially_filled')) {
    try {
      const observed = venueOrderToExecution(order, {
        symbol,
        side: order.side,
        amount: order.amount,
        limitPrice: order.averagePrice ?? order.price ?? 0n,
        clientOrderId,
      });
      if (observed.averagePrice === null) {
        return { ok: true, order };
      }
      const execution: VenueExecution = { ...observed, averagePrice: observed.averagePrice };
      input.emsStore?.record({
        ...evidence,
        execution,
        state: execution.status === 'rejected' ? 'REJECTED' : 'ACKNOWLEDGED',
        reconciliationKey: null,
        recordedAtMs: Date.now(),
      });
    } catch {
      // A cancel response is not submit evidence. Only a confirmed fill can
      // reconcile an execution; otherwise preserve the unknown EMS record.
    }
  }

  return { ok: true, order };
}
import { matchesRetainedSliceIntent } from './oms-slice-intent.js';

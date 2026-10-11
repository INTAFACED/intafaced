/**
 * Bridge TradeAdapter.placeOrder → LiquiditySource.submit (OMS execute).
 *
 * Does not invent an average from the request limit. Filled + null average
 * throws. Unfilled + null average stays null — ZERO would read as filled-at-zero.
 * `open` still maps to `partial` (VenueExecution has no resting status); execute
 * treats only `rejected` as failure, so a 0-fill rest stays ok:true with a null
 * price. A cancel or expiry that already filled some size maps to `partial`
 * using that venue fill — the size is never invented. A zero-fill cancel or
 * expiry stays `rejected`. Does not treat pending as executed.
 * Unknown fees are 0 — never a fabricated venue fee.
 */
import { ZERO, type Amount } from '@intafaced/ledger-client';
import type { TradeAdapter, VenueOrder } from '@intafaced/venue-contracts';
import type { SubmitRequest, VenueExecution } from '@intafaced/venue-adapter';

export type OmsSubmitFn = (request: SubmitRequest) => Promise<OmsVenueExecution>;

/** venue-adapter VenueExecution.averagePrice is Amount; unfilled stays null here. */
export type OmsVenueExecution = Omit<VenueExecution, 'averagePrice'> & {
  readonly averagePrice: Amount | null;
  /** Actual venue response quantity, absent from older submit ports. */
  readonly remainingAmount?: Amount;
};

function hasFill(filled: Amount): boolean {
  return filled > 0n;
}

function mapStatus(order: VenueOrder): VenueExecution['status'] {
  switch (order.status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
    case 'open':
      return 'partial';
    case 'canceled':
    case 'expired':
      return hasFill(order.filled) ? 'partial' : 'rejected';
    case 'rejected':
      return 'rejected';
    default:
      throw new Error(`cannot map venue order status ${order.status} to VenueExecution`);
  }
}

export function venueOrderToExecution(order: VenueOrder, _request: SubmitRequest): OmsVenueExecution {
  if (order.status === 'pending') {
    throw new Error('venue order is still pending — no VenueExecution until the venue acknowledges');
  }

  const status = mapStatus(order);
  if (!order.venueOrderId) {
    throw new Error('venue order has no venueOrderId — cannot report a VenueExecution');
  }

  if (hasFill(order.filled) && order.averagePrice == null) {
    throw new Error('filled venue order has null averagePrice — refusing to invent a fill price');
  }

  return {
    venueId: order.venueId,
    venueOrderId: order.venueOrderId,
    filledAmount: order.filled,
    remainingAmount: order.remaining,
    averagePrice: order.averagePrice,
    feeAmount: order.feePaid ?? ZERO,
    feeAsset: order.feeAsset ?? '',
    status,
    executedAt: order.observedAt,
  };
}

export function tradeAdapterSubmit(adapter: TradeAdapter): OmsSubmitFn {
  return async (request) => {
    const order = await adapter.placeOrder({
      symbol: request.symbol,
      side: request.side,
      type: 'limit',
      amount: request.amount,
      price: request.limitPrice,
      clientOrderId: request.clientOrderId,
    });
    return venueOrderToExecution(order, request);
  };
}

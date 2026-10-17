/**
 * Maintenance is not halt. Halt is cancel-only: new orders refuse, cancels stay.
 * Maintenance refuses the customer cancel and leaves the resting order in place.
 */
import type { MarketId, RejectReason, SubmitResult, AmendResult } from './types.js';

export const MARKET_MAINTENANCE = 'market_maintenance' as const;

export function maintenanceRefuse(marketId: MarketId): RejectReason {
  return {
    code: MARKET_MAINTENANCE,
    message: `market ${marketId} is in maintenance — cancels are refused and the resting order stays`,
  };
}

export function maintenanceSubmitResult(marketId: MarketId, orderId: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: {
      ...maintenanceRefuse(marketId),
      message: `market ${marketId} is in maintenance — order ${orderId} not processed`,
    },
    cancellations: [],
    triggered: [],
  };
}

export function maintenanceAmendResult(marketId: MarketId, orderId: string): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: {
      ...maintenanceRefuse(marketId),
      message: `market ${marketId} is in maintenance — order ${orderId} not processed`,
    },
    cancellations: [],
    triggered: [],
  };
}

/** Last maintenance / end wins. Not a halt record — replay must not treat it as cancel-only. */
export function replayMaintenance(records: readonly { readonly kind: string; readonly marketId?: MarketId }[]): ReadonlySet<MarketId> {
  const maintenance = new Set<MarketId>();
  for (const record of records) {
    if (record.marketId === undefined) continue;
    if (record.kind === 'maintenance') maintenance.add(record.marketId);
    else if (record.kind === 'end_maintenance') maintenance.delete(record.marketId);
  }
  return maintenance;
}

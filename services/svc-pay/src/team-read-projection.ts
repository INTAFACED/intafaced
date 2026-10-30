import type { MerchantTierList, PayRecordedPricingSnapshot } from '@intafaced/contracts';
import { safeFailure, type MerchantFailure } from './merchant-failure.js';
import type { MerchantReadAudience } from './merchant-read-access.js';
import { seesFullPricing, type MerchantRole } from './merchant-ops/roles.js';

/**
 * Commercial terms on a stored pricing row. Owner, admin, and finance see the
 * row. Viewer and developer see the fee amount and nothing else.
 */
export function projectPricingSnapshot<T extends { fee: string }>(
  snapshot: T | null,
  audience: MerchantReadAudience,
): T | { fee: string } | null {
  if (!snapshot) return null;
  if (seesFullPricing(audience)) return snapshot;
  return { fee: snapshot.fee };
}

/**
 * The tier ladder for one caller. Owner, admin, and finance get each tier fee
 * as stored, spread included. Every other role, and no role at all, gets the
 * fee without its `spreadBps` key: the same rule the portal's `pricingVisibility`
 * reads (`seesFullPricing`), applied here so the API never sends what the page hides.
 */
export function projectTierList(list: MerchantTierList, role: MerchantRole | null): MerchantTierList {
  if (list.status !== 'configured' || (role !== null && seesFullPricing(role))) return list;
  return {
    ...list,
    tiers: list.tiers.map((tier) => ({
      ...tier,
      fees: tier.fees.map(({ spreadBps: _spread, ...fee }) => fee),
    })),
  };
}

export interface TeamHistoryEvent {
  readonly id: string;
  readonly event: string;
  readonly ts: string;
  readonly amount: string | null;
  readonly assetId: string | null;
  readonly failure: MerchantFailure | null;
}

const AMOUNT = /^\d+(\.\d{1,18})?$/;
const ASSET = /^[A-Za-z0-9._-]{1,16}$/;

/**
 * Team history. Event name, time, a decimal amount and asset when the payload
 * has them, and a catalog failure. The raw payload stays with the owner: it
 * holds the instrument, rail text, and the routing decision.
 */
export function projectTeamHistoryEvent(event: {
  id: string;
  event: string;
  payload: Record<string, unknown> | null | undefined;
  ts: Date;
}): TeamHistoryEvent {
  const payload = event.payload ?? {};
  const routing = event.event === 'rail.selected' || payload.kind === 'pay.routing.decision';
  if (routing) {
    return { id: event.id, event: event.event, ts: event.ts.toISOString(), amount: null, assetId: null, failure: null };
  }
  const amount = typeof payload.amount === 'string' && AMOUNT.test(payload.amount) ? payload.amount : null;
  const assetId = typeof payload.assetId === 'string' && ASSET.test(payload.assetId) ? payload.assetId : null;
  const code = typeof payload.failureCode === 'string' ? payload.failureCode : null;
  return {
    id: event.id,
    event: event.event,
    ts: event.ts.toISOString(),
    amount,
    assetId,
    failure: safeFailure(code),
  };
}

export type { PayRecordedPricingSnapshot };

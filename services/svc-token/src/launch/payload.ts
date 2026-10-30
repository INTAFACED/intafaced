import { formatAmount } from '@intafaced/ledger-client';
import { canonicalEvent, type CreateEventInput } from './launch-service.js';

/**
 * What the founders approve for a launch door: the action names and the canonical launch payload. Kept apart from the router
 * so the console can pin its own hash to this code without loading the router and its tRPC graph.
 */

/** The founders' approvals for the three operator doors. Each binds the fields it changes. */
export const LAUNCH_ISSUER_SET_ACTION = 'token.launch.issuer.set';
export const LAUNCH_EVENT_CREATE_ACTION = 'token.launch.event.create';
export const LAUNCH_EVENT_MOVE_ACTION = 'token.launch.event.move';

/** The canonical event the founders approve: stored values in a fixed order, times as UTC ISO. */
export function launchEventPayload(input: CreateEventInput): string {
  const e = canonicalEvent(input);
  const amt = (v: bigint | null) => (v === null ? null : formatAmount(v));
  return JSON.stringify({
    id: e.id,
    issuerId: e.issuerId,
    type: e.type,
    projectName: e.projectName,
    symbol: e.symbol,
    periods: [e.periods.announceAt, e.periods.snapshotAt, e.periods.openAt, e.periods.closeAt, e.periods.distributionAt].map((d) =>
      d.toISOString(),
    ),
    method: e.method,
    perUserCap: amt(e.perUserCap),
    ticketSize: amt(e.ticketSize),
    tierWeights: e.tierWeights?.map((t) => [formatAmount(t.minBasis), t.weight]) ?? null,
    price: amt(e.price),
    paymentAsset: e.paymentAsset,
    rateSource: e.rateSource,
  });
}

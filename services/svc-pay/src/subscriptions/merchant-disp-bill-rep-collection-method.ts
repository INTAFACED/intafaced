import { PayError } from '../payment-service.js';
import { normaliseSubscriptionPath } from './mandate-product.js';

/**
 * M-bill-01 (spec group merchant-disp-bill-rep): a subscription's collection
 * method, named the way merchants know it.
 *
 * There is no second field. The method IS the subscription's existing `path`:
 *   - `send_invoice`         = `crypto_invoice` (live: each period opens an invoice)
 *   - `charge_automatically` = `card` (refuses `pay.mandate_rail_absent`: no card rail)
 */
export const COLLECTION_METHODS = ['send_invoice', 'charge_automatically'] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export function collectionMethodOf(path: string): CollectionMethod {
  return normaliseSubscriptionPath(path) === 'crypto_invoice' ? 'send_invoice' : 'charge_automatically';
}

/**
 * The not-connected refusal for the card method. Spec merchant-disp-bill-rep.md
 * (AMENDED 2026-10-18, allowlist): the card collection method keeps
 * `NotLiveCard` with code `rail.card`. The code reaches the client as
 * `data.blockers: [{ code: 'rail.card' }]` through the shared tRPC error
 * formatter (packages/contracts/src/trpc.ts errorBlockersOf), the same field
 * every other blocker uses. The PayError code stays `pay.mandate_rail_absent`,
 * the one the card path already refuses with.
 */
export class NotLiveCardRefusal extends PayError {
  readonly blockers = [{ code: 'rail.card' }] as const;
  constructor() {
    super('Card charging is not connected yet. The collection method was not changed.', 'pay.mandate_rail_absent', {
      notLive: 'rail.card',
    });
    this.name = 'NotLiveCardRefusal';
  }
}

/** Refuse before any write. Card charging is not connected, so the method stays where it is. */
export function assertCollectionMethodAvailable(method: CollectionMethod): void {
  if (method === 'charge_automatically') throw new NotLiveCardRefusal();
}

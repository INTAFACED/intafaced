import { ProtocolListingDesk } from './desk.js';
import type { ListingStore } from './store.js';

/** What the router needs: the desk that writes and the store it and the readers share. */
export interface ListingDesk {
  readonly desk: ProtocolListingDesk;
  readonly store: ListingStore;
  readonly now: () => string;
}

export function createListingDesk(deps: {
  store: ListingStore;
  approvals: ConstructorParameters<typeof ProtocolListingDesk>[0]['approvals'];
  reasonCodes: () => readonly string[] | null;
  now: () => string;
}): ListingDesk {
  return { desk: new ProtocolListingDesk(deps), store: deps.store, now: deps.now };
}

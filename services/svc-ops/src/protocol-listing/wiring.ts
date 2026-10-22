import { ProtocolListingDesk } from './desk.js';
import type { ReasonCodes } from './reason-codes.js';
import type { ListingStore } from './store.js';

/** What the router needs: the desk that writes and the store it and the readers share. */
export interface ListingDesk {
  readonly desk: ProtocolListingDesk;
  readonly store: ListingStore;
  readonly reasonCodes: ReasonCodes;
  readonly now: () => string;
}

export function createListingDesk(deps: {
  store: ListingStore;
  approvals: ConstructorParameters<typeof ProtocolListingDesk>[0]['approvals'];
  reasonCodes: ReasonCodes;
  now: () => string;
}): ListingDesk {
  const { reasonCodes, ...rest } = deps;
  return {
    desk: new ProtocolListingDesk({ ...rest, reasonCodes: async () => (await reasonCodes.inForce()).codes }),
    store: deps.store,
    reasonCodes,
    now: deps.now,
  };
}

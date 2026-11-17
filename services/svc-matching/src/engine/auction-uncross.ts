/**
 * Auction STATE / uncross refuse (PX-S03 §9 / PTX-M03-R05).
 * Uncrossing rules are unset; the engine does not invent an uncross.
 * Hitch: imported from auction.ts so MatchingEngine is wrapped without recutting engine.ts.
 */
import { MatchingEngine } from './engine.js';
import type { AuctionUncrossResult, MarketId, RejectReason, SubmitResult } from './types.js';

export const UNCROSSING_UNSET = 'uncrossing_unset' as const;
export const UNCROSSING_UNSET_MESSAGE = 'uncrossing rules are unset; the engine does not invent an uncross';

const FLAG = Symbol.for('intafaced.matching.auction-uncross');
export const AUCTION_STATE = Symbol.for('intafaced.matching.auction-state');

type Host = MatchingEngine & {
  [AUCTION_STATE]?: Set<MarketId>;
};

/**
 * Uncrossing is an owner AuctionPolicy socket (PX-S03 §9: algorithm, imbalance, reference, tie-break).
 * No env on this process publishes it. MATCHING_RULEBOOK_VERSION is a different door.
 * UNSET is the live product — no compose pin, no invented price or algorithm.
 */
export function uncrossingRulesUnset(): boolean {
  return true;
}

export function uncrossingUnsetRefuse(): RejectReason {
  return {
    code: UNCROSSING_UNSET,
    message: UNCROSSING_UNSET_MESSAGE,
  };
}

export function isAuction(host: Host, marketId: MarketId): boolean {
  return host[AUCTION_STATE]?.has(marketId) === true;
}

export function refusedUncross(marketId: MarketId): AuctionUncrossResult {
  return {
    accepted: false,
    marketId,
    fills: [],
    rejected: uncrossingUnsetRefuse(),
  };
}

export function uncrossSubmitRefuse(orderId: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { ...uncrossingUnsetRefuse(), message: `${UNCROSSING_UNSET_MESSAGE} — order ${orderId} not processed` },
    cancellations: [],
    triggered: [],
  };
}

export function installAuctionUncross(ctor: typeof MatchingEngine = MatchingEngine): void {
  const proto = ctor.prototype as {
    submit: MatchingEngine['submit'];
    uncross?: (marketId: MarketId) => Promise<AuctionUncrossResult>;
    enterAuction?: (marketId: MarketId) => Promise<AuctionUncrossResult>;
    leaveAuction?: (marketId: MarketId) => Promise<AuctionUncrossResult>;
    [FLAG]?: boolean;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origSubmit = proto.submit;

  proto.uncross = async function (this: MatchingEngine, marketId: MarketId) {
    return refusedUncross(marketId);
  };

  proto.enterAuction = async function (this: MatchingEngine, marketId: MarketId) {
    return refusedUncross(marketId);
  };

  proto.leaveAuction = async function (this: MatchingEngine, marketId: MarketId) {
    return refusedUncross(marketId);
  };

  proto.submit = async function (this: MatchingEngine, marketId, order, proof) {
    if (isAuction(this as Host, marketId)) return uncrossSubmitRefuse(order.orderId);
    return origSubmit.call(this, marketId, order, proof);
  };
}

try {
  installAuctionUncross();
} catch {
  queueMicrotask(() => installAuctionUncross());
}

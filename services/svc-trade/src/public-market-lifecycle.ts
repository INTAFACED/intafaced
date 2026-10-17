import type { MarketStateSnapshot } from '@intafaced/exchange-contract';

/**
 * Public markets row lifecycle. The stored snapshot's `state` string is the
 * name the row publishes (POST_ONLY, CANCEL_ONLY, HALTED, DELISTING, and the
 * rest). Operator identity, notes, and actor ids are not fields of this shape
 * and are not copied even if a caller attached them.
 */
export function publicMarketLifecycle(snapshot: MarketStateSnapshot | null | undefined): {
  marketId: MarketStateSnapshot['marketId'];
  ruleVersion: MarketStateSnapshot['ruleVersion'];
  instrumentId: MarketStateSnapshot['instrumentId'];
  instrumentVersion: MarketStateSnapshot['instrumentVersion'];
  state: MarketStateSnapshot['state'];
  reasonCategory: MarketStateSnapshot['reasonCategory'];
  reasonCode: MarketStateSnapshot['reasonCode'];
  effectiveAt: MarketStateSnapshot['effectiveAt'];
  observedAt: MarketStateSnapshot['observedAt'];
  lastGoodState: MarketStateSnapshot['lastGoodState'];
  allowedActions: MarketStateSnapshot['allowedActions'];
  transitionId: MarketStateSnapshot['transitionId'];
  evidenceRefs: MarketStateSnapshot['evidenceRefs'];
} | null {
  if (!snapshot) return null;
  return {
    marketId: snapshot.marketId,
    ruleVersion: snapshot.ruleVersion,
    instrumentId: snapshot.instrumentId,
    instrumentVersion: snapshot.instrumentVersion,
    state: snapshot.state,
    reasonCategory: snapshot.reasonCategory,
    reasonCode: snapshot.reasonCode,
    effectiveAt: snapshot.effectiveAt,
    observedAt: snapshot.observedAt,
    lastGoodState: snapshot.lastGoodState,
    allowedActions: [...snapshot.allowedActions],
    transitionId: snapshot.transitionId,
    evidenceRefs: [...snapshot.evidenceRefs],
  };
}

import { createHash } from 'node:crypto';
import { createMarketLifecycleAdmissionProof, marketStateSnapshotSchema } from '@intafaced/exchange-contract';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';

/**
 * THE LIFECYCLE PROOF OF A SPREAD (CB-otc-16).
 *
 * svc-matching's spread door wants a PX-S01 proof whose snapshot names the SPREAD id and allows PLACE. The lifecycle
 * authority in this service publishes per market (`trade.markets`), and a spread is not a market: nobody publishes a
 * dossier for a spread id, and none is invented here.
 *
 * A spread is open for placement exactly when both of its legs are. So the proof for the spread is derived from the two
 * LEG proofs, each of which is the real authority's PLACE proof for that leg's market (a halted, suspended, closed or
 * unpublished leg never yields one, so this is never reached for it). The derived snapshot:
 *
 *   · names the spread as market and instrument, in state OPEN, and allows only what BOTH legs allow;
 *   · carries the union of the legs' evidence references, so the real approvals stay on the record;
 *   · is observed and effective at the EARLIER of the two legs' times, so it is never fresher than its stalest leg;
 *   · takes version names from both legs' versions, so a rule change on either leg changes the spread's.
 *
 * It decides nothing the legs did not already decide. If the owner later publishes a lifecycle dossier for spread ids,
 * this derivation is replaced by that publication.
 */

const stableId = (namespace: string, value: string): string =>
  `${namespace}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;

export class SpreadLifecycleError extends Error {
  readonly code = 'trade.spread_leg_not_open';
  constructor(message: string) {
    super(message);
    this.name = 'SpreadLifecycleError';
  }
}

export function spreadLifecycleProof(input: {
  readonly spreadId: string;
  readonly legs: readonly [LifecycleAdmissionProof, LifecycleAdmissionProof];
}): LifecycleAdmissionProof {
  const [a, b] = input.legs;
  for (const leg of input.legs) {
    if (leg.action !== 'PLACE' || leg.snapshot.state !== 'OPEN') {
      throw new SpreadLifecycleError(`leg ${leg.snapshot.marketId} is ${leg.snapshot.state}; a spread opens only when both legs do`);
    }
  }
  const earlier = (x: string, y: string) => (Date.parse(x) <= Date.parse(y) ? x : y);
  const observedAt = earlier(a.snapshot.observedAt, b.snapshot.observedAt);
  const effectiveAt = earlier(a.snapshot.effectiveAt, b.snapshot.effectiveAt);
  const allowedActions = a.snapshot.allowedActions.filter((action) => b.snapshot.allowedActions.includes(action));
  const evidenceRefs = [...new Set([...a.snapshot.evidenceRefs, ...b.snapshot.evidenceRefs])];
  const snapshot = marketStateSnapshotSchema.parse({
    marketId: input.spreadId,
    ruleVersion: stableId('trade.lifecycle.spread-rules', `${input.spreadId}|${a.snapshot.ruleVersion}|${b.snapshot.ruleVersion}`),
    instrumentId: input.spreadId,
    instrumentVersion: stableId(
      'trade.lifecycle.spread-instrument',
      `${input.spreadId}|${a.snapshot.instrumentVersion}|${b.snapshot.instrumentVersion}`,
    ),
    state: 'OPEN',
    reasonCategory: 'NORMAL',
    reasonCode: 'trade.lifecycle.spread_legs_open',
    effectiveAt,
    observedAt,
    lastGoodState: 'OPEN',
    allowedActions,
    transitionId: stableId('trade.lifecycle.spread-transition', `${input.spreadId}|${a.transitionId}|${b.transitionId}`),
    evidenceRefs,
  });
  return createMarketLifecycleAdmissionProof(snapshot, 'PLACE', observedAt);
}

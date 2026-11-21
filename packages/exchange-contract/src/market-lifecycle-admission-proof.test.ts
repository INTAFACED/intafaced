import { describe, expect, it } from 'vitest';
import {
  createMarketLifecycleAdmissionProof,
  marketLifecycleAdmissionProofSchema,
  marketLifecycleSnapshotId,
  marketStateSnapshotSchema,
  snapshotIdFor,
  type MarketStateSnapshot,
} from './index.js';

const snapshot: MarketStateSnapshot = {
  marketId: 'market-1',
  ruleVersion: 'rules-1',
  instrumentId: 'instrument-1',
  instrumentVersion: 'instrument-v1',
  state: 'OPEN',
  reasonCategory: 'NORMAL',
  reasonCode: 'trade.lifecycle.ready',
  effectiveAt: '2026-08-24T16:00:00.000Z',
  observedAt: '2026-08-24T16:00:00.000Z',
  lastGoodState: 'OPEN',
  allowedActions: ['PLACE'],
  transitionId: 'transition-1',
  evidenceRefs: ['evidence-1'],
};

const expectedSnapshotId = 'trade.lifecycle.snapshot:4846f0a4c779eb6058e60a6b6afa70a9099555ee5bac1b9e654f23872b7e3381';
const expectedProofJson =
  '{"action":"PLACE","decision":"ELIGIBLE","checkedAt":"2026-08-24T16:00:00.000Z","snapshotId":"trade.lifecycle.snapshot:4846f0a4c779eb6058e60a6b6afa70a9099555ee5bac1b9e654f23872b7e3381","transitionId":"transition-1","evidenceRefs":["evidence-1"],"snapshot":{"marketId":"market-1","ruleVersion":"rules-1","instrumentId":"instrument-1","instrumentVersion":"instrument-v1","state":"OPEN","reasonCategory":"NORMAL","reasonCode":"trade.lifecycle.ready","effectiveAt":"2026-08-24T16:00:00.000Z","observedAt":"2026-08-24T16:00:00.000Z","lastGoodState":"OPEN","allowedActions":["PLACE"],"transitionId":"transition-1","evidenceRefs":["evidence-1"]}}';

describe('market lifecycle admission proof contract', () => {
  it('matches the golden snapshot ID and proof bytes', () => {
    const parsed = marketStateSnapshotSchema.parse(snapshot);
    const proof = createMarketLifecycleAdmissionProof(parsed, 'PLACE', parsed.observedAt);

    expect(snapshotIdFor(parsed)).toBe(expectedSnapshotId);
    expect(marketLifecycleSnapshotId(parsed)).toBe(expectedSnapshotId);
    expect(JSON.stringify(proof)).toBe(expectedProofJson);
    expect(marketLifecycleAdmissionProofSchema.parse(proof)).toEqual(proof);
  });

  it('binds action, checkedAt, evidence, transition, and snapshot hash', () => {
    const proof = createMarketLifecycleAdmissionProof(snapshot, 'PLACE');
    const tampered = [
      { action: 'PLACE_POST_ONLY' },
      { checkedAt: '2026-08-24T16:01:00.000Z' },
      { evidenceRefs: ['evidence-forged'] },
      { transitionId: 'transition-forged' },
      { snapshotId: `${proof.snapshotId.slice(0, -1)}0` },
    ];

    for (const change of tampered) {
      expect(marketLifecycleAdmissionProofSchema.safeParse({ ...proof, ...change }).success).toBe(false);
    }
    expect(marketLifecycleAdmissionProofSchema.safeParse({ ...proof, snapshot: { ...proof.snapshot, allowedActions: [] } }).success).toBe(
      false,
    );
  });

  it('refuses an ineligible action and malformed checkedAt with typed parse failures', () => {
    expect(() => createMarketLifecycleAdmissionProof(snapshot, 'PLACE_POST_ONLY')).toThrow();
    expect(() => createMarketLifecycleAdmissionProof(snapshot, 'PLACE', 'not-a-timestamp')).toThrow();
    expect(() => createMarketLifecycleAdmissionProof({ ...snapshot, allowedActions: [] }, 'PLACE')).toThrow();
  });

  it('cannot admit ordinary PLACE against an auction snapshot', () => {
    expect(
      marketStateSnapshotSchema.safeParse({ ...snapshot, state: 'AUCTION', lastGoodState: 'PRELAUNCH', allowedActions: ['PLACE'] }).success,
    ).toBe(false);
    const auction = marketStateSnapshotSchema.parse({ ...snapshot, state: 'AUCTION', lastGoodState: 'PRELAUNCH', allowedActions: [] });
    expect(() => createMarketLifecycleAdmissionProof(auction, 'PLACE')).toThrow();
  });

  it('admits AMEND when the snapshot allows it', () => {
    const amendSnapshot = marketStateSnapshotSchema.parse({ ...snapshot, allowedActions: ['PLACE', 'AMEND'] });
    const proof = createMarketLifecycleAdmissionProof(amendSnapshot, 'AMEND');
    expect(proof.action).toBe('AMEND');
    expect(marketLifecycleAdmissionProofSchema.parse(proof).action).toBe('AMEND');
    expect(() => createMarketLifecycleAdmissionProof(snapshot, 'AMEND')).toThrow();
  });

  it('deep-freezes the proof and remains repeatable after serialization', () => {
    const parsed = marketStateSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    const proof = createMarketLifecycleAdmissionProof(parsed, 'PLACE');
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.snapshot)).toBe(true);
    expect(Object.isFrozen(proof.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(proof.snapshot.allowedActions)).toBe(true);

    const roundTripped = marketLifecycleAdmissionProofSchema.parse(JSON.parse(JSON.stringify(proof)));
    expect(createMarketLifecycleAdmissionProof(roundTripped.snapshot, roundTripped.action, roundTripped.checkedAt)).toEqual(proof);
    expect(JSON.stringify(createMarketLifecycleAdmissionProof(roundTripped.snapshot, roundTripped.action, roundTripped.checkedAt))).toBe(
      JSON.stringify(proof),
    );
  });
});

describe('a proof whose snapshot breaks its own state rule', () => {
  it('is refused with the snapshot issue, never thrown out of safeParse', () => {
    const proof = { ...JSON.parse(expectedProofJson), snapshot: { ...snapshot, state: 'HALTED' } };
    const parsed = marketLifecycleAdmissionProofSchema.safeParse(proof);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain('HALTED cannot permit PLACE');
  });
});

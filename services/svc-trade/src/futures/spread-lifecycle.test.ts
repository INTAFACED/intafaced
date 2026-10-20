import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { describe, expect, it } from 'vitest';
import { SpreadLifecycleError, spreadLifecycleProof } from './spread-lifecycle.js';

const leg = (marketId: string, over: Record<string, unknown> = {}) =>
  createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: `rules-${marketId}`,
      instrumentId: marketId,
      instrumentVersion: `instrument-${marketId}`,
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: '2026-10-20T11:00:00.000Z',
      observedAt: '2026-10-20T11:59:00.000Z',
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'CANCEL'],
      transitionId: `transition-${marketId}`,
      evidenceRefs: [`evidence-${marketId}`],
      ...over,
    } as never,
    'PLACE',
    (over.observedAt as string | undefined) ?? '2026-10-20T11:59:00.000Z',
  );

describe('spreadLifecycleProof', () => {
  it("names the spread, carries both legs' evidence, and is never fresher than its stalest leg", () => {
    const a = leg('far', { observedAt: '2026-10-20T11:58:00.000Z' });
    const b = leg('near', { effectiveAt: '2026-10-20T10:00:00.000Z', allowedActions: ['PLACE'] });
    const proof = spreadLifecycleProof({ spreadId: 'CAL', legs: [a, b] });
    expect(proof.action).toBe('PLACE');
    expect(proof.snapshot).toMatchObject({
      marketId: 'CAL',
      instrumentId: 'CAL',
      state: 'OPEN',
      observedAt: '2026-10-20T11:58:00.000Z',
      effectiveAt: '2026-10-20T10:00:00.000Z',
      allowedActions: ['PLACE'],
    });
    expect(proof.snapshot.evidenceRefs).toEqual(['evidence-far', 'evidence-near']);
  });

  it("is stable for the same legs and changes when either leg's rules change", () => {
    const a = leg('far');
    const b = leg('near');
    const first = spreadLifecycleProof({ spreadId: 'CAL', legs: [a, b] });
    expect(JSON.stringify(spreadLifecycleProof({ spreadId: 'CAL', legs: [a, b] }))).toBe(JSON.stringify(first));
    const changed = spreadLifecycleProof({ spreadId: 'CAL', legs: [a, leg('near', { ruleVersion: 'rules-2' })] });
    expect(changed.snapshot.ruleVersion).not.toBe(first.snapshot.ruleVersion);
  });

  it('refuses when a leg is not open: a spread opens only when both legs do', () => {
    // The authority never issues a PLACE proof for a halted leg; a proof altered after the fact still does not open the spread.
    const open = leg('near');
    const halted = { ...open, snapshot: { ...open.snapshot, state: 'HALTED' } } as typeof open;
    expect(() => spreadLifecycleProof({ spreadId: 'CAL', legs: [leg('far'), halted] })).toThrow(SpreadLifecycleError);
  });
});

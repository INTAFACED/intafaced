import { describe, expect, it } from 'vitest';
import { InMemoryApprovedAlgoParentStore } from './oms-start.js';
import { stopImplementationShortfallParent } from './oms-is-stop.js';

function seedWithResidual(parentClientOrderId: string) {
  const parentStore = new InMemoryApprovedAlgoParentStore();
  parentStore.seed({
    parentClientOrderId,
    kind: 'twap',
    status: 'running',
    startedAt: '2026-08-31T12:00:00.000Z',
    schedule: { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null },
    residual: { remaining: '10' },
  });
  return parentStore;
}

describe('stopImplementationShortfallParent', () => {
  it('refuses missing parentClientOrderId', () => {
    expect(stopImplementationShortfallParent({ status: 'running' })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
    expect(stopImplementationShortfallParent({ parentClientOrderId: '   ', status: 'running' })).toMatchObject({
      ok: false,
      reason: 'missing_parent',
    });
  });

  it('refuses omitted status with not_running', () => {
    expect(stopImplementationShortfallParent({ parentClientOrderId: 'p-is' })).toMatchObject({
      ok: false,
      reason: 'not_running',
    });
  });

  it('refuses status approved with not_running', () => {
    expect(
      stopImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'approved',
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('refuses status stopped with already_stopped', () => {
    expect(
      stopImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'stopped',
      }),
    ).toMatchObject({ ok: false, reason: 'already_stopped' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      stopImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        kind: 'twap',
        status: 'running',
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it("happy running IS: stopped true, childrenTakeNew false, residual.remaining still '10'", () => {
    const parentStore = seedWithResidual('p-is');
    const result = stopImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
      parentStore,
    });
    expect(result).toEqual({
      ok: true,
      stopped: true,
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      childrenTakeNew: false,
      residual: { remaining: '10' },
    });
    expect(parentStore.get('p-is')?.residual).toEqual({ remaining: '10' });
    expect(parentStore.get('p-is')?.residual?.released).toBeUndefined();
  });

  it('without parentStore: residual.remaining null (not invented)', () => {
    const result = stopImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
    });
    expect(result).toEqual({
      ok: true,
      stopped: true,
      parent: { parentClientOrderId: 'p-is', kind: 'implementation_shortfall' },
      childrenTakeNew: false,
      residual: { remaining: null },
    });
  });

  it('result has no canceled/flatten field — no invented cancels', () => {
    const parentStore = seedWithResidual('p-is');
    const result = stopImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
      parentStore,
    });
    expect(result).not.toHaveProperty('canceled');
    expect(result).not.toHaveProperty('flatten');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childrenTakeNew).toBe(false);
    }
  });
});

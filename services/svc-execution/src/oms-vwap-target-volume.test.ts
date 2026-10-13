import { describe, expect, it } from 'vitest';
import { InMemoryApprovedAlgoParentStore, type RetainedAlgoSchedule } from './oms-start.js';
import { approveAlgoParentWithVwapTargetVolume } from './oms-vwap-target-volume.js';

const MATCHING_OPEN = { venueHalted: false } as const;
const OP = '33333333-3333-4333-8333-333333333333';

function retainedVwap(): RetainedAlgoSchedule {
  return { durationMs: 120_000, sliceIntervalMs: 15_000, slicesPlanned: 8, participationBps: null };
}

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function vwapApproveInput(
  parentStore: InMemoryApprovedAlgoParentStore,
  over: {
    parentClientOrderId?: string;
    jobs?: { enabled: boolean };
    targetVolume: string | null | undefined;
    schedule?: RetainedAlgoSchedule;
  },
) {
  return {
    parentClientOrderId: over.parentClientOrderId ?? 'p-vwap',
    kind: 'vwap' as const,
    schedule: over.schedule ?? retainedVwap(),
    operatorId: OP,
    parentStore,
    jobs: over.jobs ?? { enabled: true },
    matchingVenueHalt: MATCHING_OPEN,
    targetVolume: over.targetVolume,
  };
}

describe('approveAlgoParentWithVwapTargetVolume', () => {
  it('refuses VWAP + null targetVolume with target_volume_blank; store has no approved row', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume(vwapApproveInput(parentStore, { targetVolume: null }));
    expect(result).toMatchObject({ ok: false, reason: 'target_volume_blank' });
    expect(parentStore.get('p-vwap')).toBeNull();
  });

  it('refuses VWAP + undefined targetVolume with target_volume_blank', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume(vwapApproveInput(parentStore, { targetVolume: undefined }));
    expect(result).toMatchObject({ ok: false, reason: 'target_volume_blank' });
    expect(parentStore.get('p-vwap')).toBeNull();
  });

  it('refuses VWAP + whitespace targetVolume with target_volume_blank', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume(vwapApproveInput(parentStore, { targetVolume: '   ' }));
    expect(result).toMatchObject({ ok: false, reason: 'target_volume_blank' });
    expect(parentStore.get('p-vwap')).toBeNull();
  });

  it('refuses VWAP + 0 with target_volume_invalid; no approved row', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume(vwapApproveInput(parentStore, { targetVolume: '0' }));
    expect(result).toMatchObject({ ok: false, reason: 'target_volume_invalid' });
    expect(parentStore.get('p-vwap')).toBeNull();
  });

  it('refuses VWAP + nope with target_volume_invalid', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume(vwapApproveInput(parentStore, { targetVolume: 'nope' }));
    expect(result).toMatchObject({ ok: false, reason: 'target_volume_invalid' });
    expect(parentStore.get('p-vwap')).toBeNull();
  });

  it('VWAP + 10 + complete schedule + jobs on + operator + matching open: approve succeeds', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume(vwapApproveInput(parentStore, { targetVolume: '10' }));
    expect(result).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'p-vwap', kind: 'vwap' },
      status: 'approved',
      schedule: retainedVwap(),
    });
    expect(parentStore.get('p-vwap')?.kind).toBe('vwap');
    expect(parentStore.get('p-vwap')?.status).toBe('approved');
  });

  it('does not invent size from slicesPlanned: still target_volume_blank', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume(
      vwapApproveInput(parentStore, {
        targetVolume: null,
        schedule: {
          durationMs: 120_000,
          sliceIntervalMs: 15_000,
          slicesPlanned: 8,
          participationBps: null,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'target_volume_blank' });
    expect(parentStore.get('p-vwap')).toBeNull();
  });

  it('TWAP + blank targetVolume still approves (VWAP-only gate)', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume({
      parentClientOrderId: 'p-twap',
      kind: 'twap',
      schedule: retainedTwap(),
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      targetVolume: null,
    });
    expect(result).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'p-twap', kind: 'twap' },
      status: 'approved',
      schedule: retainedTwap(),
    });
    expect(parentStore.get('p-twap')?.kind).toBe('twap');
  });

  it('VWAP jobs_off still refuses after a present targetVolume (delegate to approve)', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithVwapTargetVolume(vwapApproveInput(parentStore, { jobs: { enabled: false }, targetVolume: '10' }));
    expect(result).toMatchObject({ ok: false, reason: 'jobs_off' });
    expect(parentStore.get('p-vwap')).toBeNull();
  });
});

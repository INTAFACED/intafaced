import { describe, expect, it } from 'vitest';
import { InMemoryApprovedAlgoParentStore, type RetainedAlgoSchedule } from './oms-start.js';
import { approveAlgoParentWithTwapDuration } from './oms-twap-duration.js';

const MATCHING_OPEN = { venueHalted: false } as const;
const OP = '33333333-3333-4333-8333-333333333333';

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function retainedPov(): RetainedAlgoSchedule {
  return { durationMs: 90_000, sliceIntervalMs: 5_000, slicesPlanned: 18, participationBps: 150 };
}

function twapApproveInput(
  parentStore: InMemoryApprovedAlgoParentStore,
  over: {
    parentClientOrderId?: string;
    jobs?: { enabled: boolean };
    durationMs: number | null | undefined;
    schedule?: RetainedAlgoSchedule;
  },
) {
  return {
    parentClientOrderId: over.parentClientOrderId ?? 'p-twap',
    kind: 'twap' as const,
    schedule: over.schedule ?? retainedTwap(),
    operatorId: OP,
    parentStore,
    jobs: over.jobs ?? { enabled: true },
    matchingVenueHalt: MATCHING_OPEN,
    durationMs: over.durationMs,
  };
}

describe('approveAlgoParentWithTwapDuration', () => {
  it('refuses TWAP + null durationMs with duration_blank; store has no approved row', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration(twapApproveInput(parentStore, { durationMs: null }));
    expect(result).toMatchObject({ ok: false, reason: 'duration_blank' });
    expect(parentStore.get('p-twap')).toBeNull();
  });

  it('refuses TWAP + undefined durationMs with duration_blank', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration(twapApproveInput(parentStore, { durationMs: undefined }));
    expect(result).toMatchObject({ ok: false, reason: 'duration_blank' });
    expect(parentStore.get('p-twap')).toBeNull();
  });

  it('refuses TWAP + 0 with duration_invalid; no approved row', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration(twapApproveInput(parentStore, { durationMs: 0 }));
    expect(result).toMatchObject({ ok: false, reason: 'duration_invalid' });
    expect(parentStore.get('p-twap')).toBeNull();
  });

  it('refuses TWAP + -1 with duration_invalid', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration(twapApproveInput(parentStore, { durationMs: -1 }));
    expect(result).toMatchObject({ ok: false, reason: 'duration_invalid' });
    expect(parentStore.get('p-twap')).toBeNull();
  });

  it('refuses TWAP + 1.5 (non-integer) with duration_invalid', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration(twapApproveInput(parentStore, { durationMs: 1.5 }));
    expect(result).toMatchObject({ ok: false, reason: 'duration_invalid' });
    expect(parentStore.get('p-twap')).toBeNull();
  });

  it('TWAP + 60_000 + complete schedule + jobs on + operator + matching open: approve succeeds', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration(twapApproveInput(parentStore, { durationMs: 60_000 }));
    expect(result).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'p-twap', kind: 'twap' },
      status: 'approved',
      schedule: retainedTwap(),
    });
    expect(result.ok === true && result.schedule.durationMs).toBe(60_000);
    expect(parentStore.get('p-twap')?.kind).toBe('twap');
    expect(parentStore.get('p-twap')?.status).toBe('approved');
    expect(parentStore.get('p-twap')?.schedule.durationMs).toBe(60_000);
  });

  it('does not invent duration from slicesPlanned * sliceIntervalMs: still duration_blank', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration(
      twapApproveInput(parentStore, {
        durationMs: null,
        schedule: {
          durationMs: 0,
          sliceIntervalMs: 10_000,
          slicesPlanned: 6,
          participationBps: null,
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'duration_blank' });
    expect(parentStore.get('p-twap')).toBeNull();
  });

  it('POV + blank durationMs still approves (TWAP-only gate)', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration({
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      schedule: retainedPov(),
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      durationMs: null,
    });
    expect(result).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'p-pov', kind: 'pov' },
      status: 'approved',
      schedule: retainedPov(),
    });
    expect(parentStore.get('p-pov')?.kind).toBe('pov');
  });

  it('TWAP jobs_off still refuses after a present duration (delegate to approve)', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithTwapDuration(twapApproveInput(parentStore, { jobs: { enabled: false }, durationMs: 60_000 }));
    expect(result).toMatchObject({ ok: false, reason: 'jobs_off' });
    expect(parentStore.get('p-twap')).toBeNull();
  });
});

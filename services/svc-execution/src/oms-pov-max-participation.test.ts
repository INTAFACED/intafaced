import { describe, expect, it } from 'vitest';
import { InMemoryApprovedAlgoParentStore, type RetainedAlgoSchedule } from './oms-start.js';
import { approveAlgoParentWithMaxParticipation } from './oms-pov-max-participation.js';

const MATCHING_OPEN = { venueHalted: false } as const;
const OP = '33333333-3333-4333-8333-333333333333';

function retainedPov(): RetainedAlgoSchedule {
  return { durationMs: 90_000, sliceIntervalMs: 5_000, slicesPlanned: 18, participationBps: 150 };
}

function retainedTwap(): RetainedAlgoSchedule {
  return { durationMs: 60_000, sliceIntervalMs: 10_000, slicesPlanned: 6, participationBps: null };
}

function povApproveInput(
  parentStore: InMemoryApprovedAlgoParentStore,
  over: {
    parentClientOrderId?: string;
    jobs?: { enabled: boolean };
    maxParticipationBps: number | null | undefined;
  },
) {
  return {
    parentClientOrderId: over.parentClientOrderId ?? 'p-pov',
    kind: 'pov' as const,
    schedule: retainedPov(),
    operatorId: OP,
    parentStore,
    jobs: over.jobs ?? { enabled: true },
    matchingVenueHalt: MATCHING_OPEN,
    maxParticipationBps: over.maxParticipationBps,
  };
}

describe('approveAlgoParentWithMaxParticipation', () => {
  it('refuses POV + null maxParticipationBps with max_participation_blank; store has no approved row', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation(povApproveInput(parentStore, { maxParticipationBps: null }));
    expect(result).toMatchObject({ ok: false, reason: 'max_participation_blank' });
    expect(parentStore.get('p-pov')).toBeNull();
  });

  it('refuses POV + undefined maxParticipationBps with max_participation_blank', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation(povApproveInput(parentStore, { maxParticipationBps: undefined }));
    expect(result).toMatchObject({ ok: false, reason: 'max_participation_blank' });
    expect(parentStore.get('p-pov')).toBeNull();
  });

  it('refuses POV + 1.5 (non-integer) with max_participation_invalid; no approved row', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation(povApproveInput(parentStore, { maxParticipationBps: 1.5 }));
    expect(result).toMatchObject({ ok: false, reason: 'max_participation_invalid' });
    expect(parentStore.get('p-pov')).toBeNull();
  });

  it('refuses POV + -1 with max_participation_invalid', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation(povApproveInput(parentStore, { maxParticipationBps: -1 }));
    expect(result).toMatchObject({ ok: false, reason: 'max_participation_invalid' });
    expect(parentStore.get('p-pov')).toBeNull();
  });

  it('refuses POV + NaN with max_participation_invalid', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation(povApproveInput(parentStore, { maxParticipationBps: Number.NaN }));
    expect(result).toMatchObject({ ok: false, reason: 'max_participation_invalid' });
    expect(parentStore.get('p-pov')).toBeNull();
  });

  it('POV + 0 (not blank) + jobs on + operator + matching open: approve succeeds', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation(povApproveInput(parentStore, { maxParticipationBps: 0 }));
    expect(result).toMatchObject({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'p-pov', kind: 'pov' },
      status: 'approved',
    });
    expect(parentStore.get('p-pov')?.status).toBe('approved');
    expect(parentStore.get('p-pov')?.schedule.participationBps).toBe(150);
  });

  it('POV + 200 + complete schedule: approve succeeds (ok true, approved true, kind pov)', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation(povApproveInput(parentStore, { maxParticipationBps: 200 }));
    expect(result).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'p-pov', kind: 'pov' },
      status: 'approved',
      schedule: retainedPov(),
    });
    expect(parentStore.get('p-pov')?.kind).toBe('pov');
    expect(parentStore.get('p-pov')?.status).toBe('approved');
  });

  it('TWAP + blank maxParticipationBps still approves (POV-only gate); does not invent a TWAP rate', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation({
      parentClientOrderId: 'p-twap',
      kind: 'twap',
      schedule: retainedTwap(),
      operatorId: OP,
      parentStore,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      maxParticipationBps: null,
    });
    expect(result).toEqual({
      ok: true,
      approved: true,
      parent: { parentClientOrderId: 'p-twap', kind: 'twap' },
      status: 'approved',
      schedule: retainedTwap(),
    });
    expect(parentStore.get('p-twap')?.schedule.participationBps).toBeNull();
  });

  it('POV jobs_off still refuses after a present max (delegate to approve)', () => {
    const parentStore = new InMemoryApprovedAlgoParentStore();
    const result = approveAlgoParentWithMaxParticipation(
      povApproveInput(parentStore, { jobs: { enabled: false }, maxParticipationBps: 200 }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'jobs_off' });
    expect(parentStore.get('p-pov')).toBeNull();
  });
});

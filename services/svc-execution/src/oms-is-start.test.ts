import { describe, expect, it } from 'vitest';
import { startImplementationShortfallParent } from './oms-is-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const MATCHING_OPEN = { venueHalted: false } as const;
const MATCHING_HALTED = { venueHalted: true } as const;
const now = new Date('2026-08-31T12:00:00.000Z');

describe('startImplementationShortfallParent', () => {
  it("jobs off refuses even with approved true and arrival '100'", () => {
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '100',
        operatorId: OP,
        jobs: { enabled: false },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'jobs_off' });
  });

  it('jobs unwired refuses', () => {
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '100',
        operatorId: OP,
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'jobs_gate_unwired' });
  });

  it('refuses missing parentClientOrderId', () => {
    expect(
      startImplementationShortfallParent({
        approved: true,
        arrivalPrice: '100',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: '   ',
        approved: true,
        arrivalPrice: '100',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('approved false / omitted and status not approved refuses not_approved', () => {
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: false,
        arrivalPrice: '100',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        arrivalPrice: '100',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('status running refuses already_started even if approved true', () => {
    const result = startImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      approved: true,
      status: 'running',
      arrivalPrice: '100',
      operatorId: OP,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      now,
    });
    expect(result).toMatchObject({ ok: false, reason: 'already_started' });
    expect(result).not.toHaveProperty('started');
  });

  it.each(['stopped', 'expired', 'paper', 'cancelled'])(
    'approved true with status %s refuses not_approved and does not start',
    (status) => {
      const result = startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status,
        arrivalPrice: '100.5',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'not_approved',
        detail: 'parent p-is is not approved',
      });
      expect(result).not.toHaveProperty('started');
      expect(result).not.toHaveProperty('arrivalPrice');
      expect(result).not.toHaveProperty('slices');
      expect(result).not.toHaveProperty('venue');
      expect(result).not.toHaveProperty('child');
    },
  );

  it.each([' running', 'Running', 'RUNNING', '  running  '])(
    'status %j refuses already_started and does not start',
    (status) => {
      const result = startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        status,
        arrivalPrice: '100.5',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'already_started',
        detail: 'parent p-is is already running',
      });
      expect(result).not.toHaveProperty('started');
    },
  );

  it('blank/null arrival with approved true refuses missing_schedule and does not invent slices', () => {
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: null,
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: undefined,
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '   ',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_schedule' });
    const blank = startImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      approved: true,
      arrivalPrice: '',
      operatorId: OP,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      now,
    });
    expect(blank).not.toHaveProperty('slicesPlanned');
    expect(blank).not.toHaveProperty('duration');
  });

  it('missing operator refuses', () => {
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '100',
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '100',
        operatorId: '   ',
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('matching halt-all refuses venue_halted; missing halt source refuses venue_halt_unavailable', () => {
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '100',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_HALTED,
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'venue_halted' });
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '100',
        operatorId: OP,
        jobs: { enabled: true },
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'venue_halt_unavailable' });
  });

  it("happy: approved true + arrival '100.5' + operator + jobs on + matching open + now", () => {
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        approved: true,
        arrivalPrice: '100.5',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toEqual({
      ok: true,
      started: true,
      parentClientOrderId: 'p-is',
      kind: 'implementation_shortfall',
      status: 'running',
      arrivalPrice: '100.5',
      startedAt: '2026-08-31T12:00:00.000Z',
    });
  });

  it("approved true with status omitted or approved still starts as running", () => {
    const omitted = startImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      approved: true,
      arrivalPrice: '100.5',
      operatorId: OP,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      now,
    });
    const approvedStatus = startImplementationShortfallParent({
      parentClientOrderId: 'p-is',
      approved: true,
      status: 'approved',
      arrivalPrice: '100.5',
      operatorId: OP,
      jobs: { enabled: true },
      matchingVenueHalt: MATCHING_OPEN,
      now,
    });
    for (const result of [omitted, approvedStatus]) {
      expect(result).toEqual({
        ok: true,
        started: true,
        parentClientOrderId: 'p-is',
        kind: 'implementation_shortfall',
        status: 'running',
        arrivalPrice: '100.5',
        startedAt: '2026-08-31T12:00:00.000Z',
      });
      expect(typeof (result as { arrivalPrice: string }).arrivalPrice).toBe('string');
    }
  });

  it("status 'approved' without approved true still starts", () => {
    expect(
      startImplementationShortfallParent({
        parentClientOrderId: 'p-is',
        status: 'approved',
        arrivalPrice: '100.5',
        operatorId: OP,
        jobs: { enabled: true },
        matchingVenueHalt: MATCHING_OPEN,
        now,
      }),
    ).toMatchObject({
      ok: true,
      started: true,
      status: 'running',
      kind: 'implementation_shortfall',
      arrivalPrice: '100.5',
    });
  });
});

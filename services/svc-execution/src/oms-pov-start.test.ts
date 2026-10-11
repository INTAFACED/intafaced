import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPovParent } from './oms-pov-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const MATCHING_OPEN = { venueHalted: false } as const;
const MATCHING_HALTED = { venueHalted: true } as const;
const JOBS_ON = { enabled: true } as const;
const JOBS_OFF = { enabled: false } as const;
const PARTICIPATION = 1500;
const CREDIT = '100';
const REMAINING = '1.25';
const NOW = new Date('2026-08-31T17:00:00.000Z');

describe('startPovParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPovParent({
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPovParent({
        parentClientOrderId: '   ',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('jobs unwired / jobs_off refuse even when already approved', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'jobs_gate_unwired' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_OFF,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'jobs_off' });
  });

  it('refuses kind twap / vwap with not_live', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'twap',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'vwap',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses already-running parent with already_started', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        status: 'running',
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it('refuses approved paper with not_approved', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        status: 'paper',
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses approved stopped, expired, halted, blank, and whitespace with not_approved', () => {
    for (const status of ['stopped', 'expired', 'halted', '', '   ']) {
      expect(
        startPovParent({
          parentClientOrderId: 'p-pov',
          kind: 'pov',
          approved: true,
          status,
          maxParticipationBps: PARTICIPATION,
          credit: CREDIT,
          remaining: REMAINING,
          operatorId: OP,
          jobs: JOBS_ON,
          matchingVenueHalt: MATCHING_OPEN,
          now: NOW,
        }),
      ).toMatchObject({ ok: false, reason: 'not_approved' });
    }
  });

  it('refuses padded running with already_started', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        status: 'running ',
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it('refuses status approved when the approved flag is omitted or false', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'approved',
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: false,
        status: 'approved',
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses paper / omitted approved with not_approved', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'paper',
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: '   ',
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / null / invalid participation with missing_max_participation', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_max_participation' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: null,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_max_participation' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: -1,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_max_participation' });
  });

  it('refuses omitted / null / whitespace credit with credit_blank', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: null,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'credit_blank' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: '   ',
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'credit_blank' });
  });

  it("refuses 'not-an-amount' credit with credit_invalid", () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: 'not-an-amount',
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'credit_invalid' });
  });

  it('refuses omitted / null / whitespace remaining with missing_residual', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: null,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: '   ',
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
  });

  it('matching halt-all refuses venue_halted; missing halt source refuses venue_halt_unavailable', () => {
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_HALTED,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'venue_halted' });
    expect(
      startPovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        approved: true,
        maxParticipationBps: PARTICIPATION,
        credit: CREDIT,
        remaining: REMAINING,
        operatorId: OP,
        jobs: JOBS_ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'venue_halt_unavailable' });
  });

  it('happy: already-approved + credit + remaining + jobs on — status running, not paper', () => {
    const result = startPovParent({
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      approved: true,
      status: 'approved',
      maxParticipationBps: PARTICIPATION,
      credit: CREDIT,
      remaining: REMAINING,
      operatorId: OP,
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      started: true,
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'running',
      maxParticipationBps: PARTICIPATION,
      credit: formatAmount(parseAmount(CREDIT)),
      residual: { remaining: formatAmount(parseAmount(REMAINING)) },
      startedAt: NOW.toISOString(),
    });
    expect(result).not.toHaveProperty('paper');
    expect(result).not.toHaveProperty('matching');
    expect(result).not.toMatchObject({ status: 'paper' });
    expect(result).not.toMatchObject({ status: 'approved' });
  });

  it('starts when approved is true and status is omitted', () => {
    const result = startPovParent({
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      approved: true,
      maxParticipationBps: PARTICIPATION,
      credit: CREDIT,
      remaining: REMAINING,
      operatorId: OP,
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      started: true,
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'running',
      maxParticipationBps: PARTICIPATION,
      credit: formatAmount(parseAmount(CREDIT)),
      residual: { remaining: formatAmount(parseAmount(REMAINING)) },
      startedAt: NOW.toISOString(),
    });
  });
});

import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { expirePovParent } from './oms-pov-expire.js';

const MATCHING_OPEN = { venueHalted: false } as const;
const MATCHING_HALTED = { venueHalted: true } as const;
const JOBS_ON = { enabled: true } as const;
const JOBS_OFF = { enabled: false } as const;
const EXPIRE_AT = '2026-08-31T18:00:00.000Z';
const REMAINING = '1.25';
const NOW = new Date('2026-08-31T18:00:00.000Z');

describe('expirePovParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      expirePovParent({
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      expirePovParent({
        parentClientOrderId: '   ',
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('jobs unwired / jobs_off refuse even when running', () => {
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'jobs_gate_unwired' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_OFF,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'jobs_off' });
  });

  it('refuses kind twap / vwap with not_live', () => {
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'twap',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'vwap',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses already-expired parent with already_expired', () => {
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'expired',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'already_expired' });
  });

  it('refuses already-stopped parent with already_stopped', () => {
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'stopped',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'already_stopped' });
  });

  it('refuses approved / paper / omitted status with not_running', () => {
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'approved',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'paper',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('refuses omitted / null / whitespace / invalid expireAt with missing_expire_at (never invent from participation or the clock)', () => {
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: null,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: '   ',
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: 'not-a-date',
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_expire_at' });
  });

  it('refuses omitted / null / whitespace remaining with missing_residual', () => {
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: null,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: '   ',
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_OPEN,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_residual' });
  });

  it('refuses not_due when the retained expireAt is still after the injected now', () => {
    const result = expirePovParent({
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'running',
      expireAt: EXPIRE_AT,
      remaining: REMAINING,
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      now: new Date('2026-08-31T17:00:00.000Z'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_due' });
    expect(result).not.toMatchObject({ status: 'expired' });
  });

  it('refuses missing_clock when now is omitted, not a Date, or an invalid Date', () => {
    const running = {
      parentClientOrderId: 'p-pov',
      kind: 'pov' as const,
      status: 'running' as const,
      expireAt: EXPIRE_AT,
      remaining: REMAINING,
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
    };
    expect(expirePovParent(running)).toMatchObject({ ok: false, reason: 'missing_clock' });
    expect(
      expirePovParent({
        ...running,
        now: '2026-08-31T18:00:00.000Z' as unknown as Date,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_clock' });
    expect(
      expirePovParent({
        ...running,
        now: new Date(Number.NaN),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_clock' });
  });

  it('expires when the injected now is after the retained expireAt and formats residual', () => {
    const result = expirePovParent({
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'running',
      expireAt: EXPIRE_AT,
      remaining: REMAINING,
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      now: new Date('2026-08-31T19:00:00.000Z'),
    });
    expect(result).toEqual({
      ok: true,
      expired: true,
      parent: { parentClientOrderId: 'p-pov', kind: 'pov' },
      status: 'expired',
      expireAt: EXPIRE_AT,
      residual: { remaining: formatAmount(parseAmount(REMAINING)) },
    });
  });

  it('matching halt-all refuses venue_halted; missing halt source refuses venue_halt_unavailable', () => {
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        matchingVenueHalt: MATCHING_HALTED,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'venue_halted' });
    expect(
      expirePovParent({
        parentClientOrderId: 'p-pov',
        kind: 'pov',
        status: 'running',
        expireAt: EXPIRE_AT,
        remaining: REMAINING,
        jobs: JOBS_ON,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'venue_halt_unavailable' });
  });

  it('happy: running + retained expireAt + remaining — status expired, residual via ledger-client, not paper', () => {
    const result = expirePovParent({
      parentClientOrderId: 'p-pov',
      kind: 'pov',
      status: 'running',
      expireAt: EXPIRE_AT,
      remaining: REMAINING,
      jobs: JOBS_ON,
      matchingVenueHalt: MATCHING_OPEN,
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      expired: true,
      parent: { parentClientOrderId: 'p-pov', kind: 'pov' },
      status: 'expired',
      expireAt: EXPIRE_AT,
      residual: { remaining: formatAmount(parseAmount(REMAINING)) },
    });
    expect(result).not.toHaveProperty('paper');
    expect(result).not.toHaveProperty('matching');
  });
});

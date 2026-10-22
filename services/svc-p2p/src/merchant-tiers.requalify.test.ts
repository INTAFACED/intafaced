import { describe, expect, it } from 'vitest';
import { applyUpgradeClock, parseTierPolicy, reassess, type MerchantTierRecord } from './merchant-tiers.js';

/** P-ads-merchant-13 review MAJOR: qualify, drop, re-qualify must wait the delay again. */
const policy = parseTierPolicy({
  ladder: [
    { rank: 1, name: 'Bronze', minCompletedTrades: 10, minCompletionBps: 9000, orderCeiling: '1000', maxPendingOrders: 2 },
    { rank: 2, name: 'Silver', minCompletedTrades: 100, minCompletionBps: 9500, orderCeiling: '5000', maxPendingOrders: 5 },
  ],
  upgradeDelayMs: 1000,
  assessmentPeriodMs: 5000,
});
const rec = (o: Partial<MerchantTierRecord> = {}): MerchantTierRecord => ({
  rank: 1,
  state: 'active',
  qualifiedSince: null,
  assessmentEndsAt: null,
  ...o,
});
const silver = { completedTrades: 150, completionBps: 9600 };
const bronze = { completedTrades: 150, completionBps: 9100 };
const run = (record: MerchantTierRecord, metrics: typeof silver, now: number) =>
  reassess({ policy, status: 'approved', record, metrics, now });

describe('upgrade clock reset (qualify, drop, re-qualify)', () => {
  it('re-qualifying after a drop restarts the clock and waits the full delay', () => {
    expect(run(rec(), silver, 10)).toEqual({ kind: 'start_upgrade_clock', at: 10 });
    // drop back to the current rank: the clock resets
    expect(run(rec({ qualifiedSince: 10 }), bronze, 500)).toEqual({ kind: 'reset_upgrade_clock' });
    // weeks later, re-qualify: a NEW clock, not an instant upgrade
    expect(run(rec(), silver, 100_000)).toEqual({ kind: 'start_upgrade_clock', at: 100_000 });
    expect(run(rec({ qualifiedSince: 100_000 }), silver, 100_999)).toEqual({ kind: 'none' });
    expect(run(rec({ qualifiedSince: 100_000 }), silver, 101_000)).toEqual({ kind: 'upgrade', from: 1, to: 2 });
  });

  it('a stale clock is never honoured: drop while the clock is old still resets, not upgrades', () => {
    expect(run(rec({ qualifiedSince: 10 }), bronze, 1_000_000)).toEqual({ kind: 'reset_upgrade_clock' });
  });

  it('losing every rank with a clock set resets the clock first', () => {
    expect(run(rec({ qualifiedSince: 10 }), { completedTrades: 0, completionBps: null }, 50)).toEqual({ kind: 'reset_upgrade_clock' });
    expect(run(rec(), { completedTrades: 0, completionBps: null }, 51)).toEqual({ kind: 'start_assessment', endsAt: 5051 });
  });

  it('a stale clock left after an upgrade is reset, not reused for the next rank', () => {
    expect(run(rec({ rank: 2, qualifiedSince: 10 }), silver, 2000)).toEqual({ kind: 'reset_upgrade_clock' });
  });
});

describe('suspension, revoke and step-down reset the upgrade clock', () => {
  for (const status of ['suspended', 'rejected', 'withdrawn', 'applied'] as const) {
    it(`${status} with a clock set resets it; reinstated merchant waits the full delay`, () => {
      const r = rec({ qualifiedSince: 10 });
      expect(reassess({ policy, status, record: r, metrics: silver, now: 500 })).toEqual({ kind: 'reset_upgrade_clock' });
      const reset = applyUpgradeClock(r, { kind: 'reset_upgrade_clock' });
      expect(reassess({ policy, status: 'approved', record: reset, metrics: silver, now: 1_000_000 })).toEqual({
        kind: 'start_upgrade_clock',
        at: 1_000_000,
      });
    });
  }
  for (const state of ['revoked', 'downgrade_requested'] as const) {
    it(`${state} with a clock set resets it; back to active waits the full delay`, () => {
      const r = rec({ state, qualifiedSince: 10 });
      expect(run(r, silver, 500)).toEqual({ kind: 'reset_upgrade_clock' });
      const back = { ...applyUpgradeClock(r, { kind: 'reset_upgrade_clock' }), state: 'active' as const };
      expect(run(back, silver, 1_000_000)).toEqual({ kind: 'start_upgrade_clock', at: 1_000_000 });
      expect(run({ ...back, qualifiedSince: 1_000_000 }, silver, 1_000_999)).toEqual({ kind: 'none' });
    });
  }
  it('suspended or revoked with no clock set is still a no-op', () => {
    expect(reassess({ policy, status: 'suspended', record: rec(), metrics: silver, now: 5 })).toEqual({ kind: 'none' });
    expect(run(rec({ state: 'revoked' }), silver, 5)).toEqual({ kind: 'none' });
  });
});

describe('applied upgrade clears the clock', () => {
  it('upgrade sets the rank and clears qualifiedSince; the next sweep is a no-op', () => {
    const r = rec({ qualifiedSince: 10 });
    const move = run(r, silver, 1010);
    expect(move).toEqual({ kind: 'upgrade', from: 1, to: 2 });
    const after = applyUpgradeClock(r, move);
    expect(after).toMatchObject({ rank: 2, qualifiedSince: null });
    expect(run(after, silver, 2000)).toEqual({ kind: 'none' });
  });
  it('start and reset move the clock; other moves leave the record alone', () => {
    expect(applyUpgradeClock(rec(), { kind: 'start_upgrade_clock', at: 7 }).qualifiedSince).toBe(7);
    const r = rec({ qualifiedSince: 7 });
    expect(applyUpgradeClock(r, { kind: 'none' })).toBe(r);
  });
});

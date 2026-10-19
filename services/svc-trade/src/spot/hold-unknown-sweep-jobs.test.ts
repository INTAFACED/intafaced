import { describe, expect, it } from 'vitest';
import { startHoldUnknownSweepJobs } from './hold-unknown-sweep-jobs.js';

describe('dead-man switch job vs the hold-unknown kill switch', () => {
  const trade = {
    sweepHoldUnknown: async () => ({ examined: 0, booked: 0, absent: 0, stillUnknown: 0, alerts: [] }) as never,
    sweepCancelAllAfter: async () => ({ unavailable: 0, failed: 0 }),
  };
  it('still runs when the hold-unknown sweep is switched off', () => {
    const h = startHoldUnknownSweepJobs({ trade, config: { enabled: false, intervalMs: 60_000, cancelAllAfterIntervalMs: 5_000 } });
    expect(h.host.list().map((j: { name?: string } | string) => (typeof j === 'string' ? j : j.name))).toContain(
      'trade.cancel_all_after_sweep',
    );
    h.stop();
  });
  it('is registered alongside the recovery sweeps when enabled', () => {
    const h = startHoldUnknownSweepJobs({ trade, config: { enabled: true, intervalMs: 60_000, cancelAllAfterIntervalMs: 5_000 } });
    const names = h.host.list().map((j: { name?: string } | string) => (typeof j === 'string' ? j : j.name));
    expect(names).toEqual(expect.arrayContaining(['trade.hold_unknown_sweep', 'trade.cancel_all_after_sweep']));
    h.stop();
  });
});

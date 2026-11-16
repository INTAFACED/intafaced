import { describe, expect, it, vi } from 'vitest';
import { createJobHost } from './job-host.js';

describe('createJobHost', () => {
  it('schedules and stops a job', async () => {
    const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
    let nextId = 1;
    const host = createJobHost({
      setIntervalFn: ((fn: () => void, ms: number) => {
        const id = nextId++;
        timers.push({ id, fn: fn as () => void, ms });
        return id as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: ((id: number) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      }) as typeof clearInterval,
    });

    const tick = vi.fn();
    const handle = host.every('mining.epoch_payout', 1000, tick);
    expect(host.list()).toEqual(['mining.epoch_payout']);
    expect(timers[0]!.ms).toBe(1000);
    await timers[0]!.fn();
    expect(tick).toHaveBeenCalledTimes(1);
    handle.stop();
    expect(host.list()).toEqual([]);
  });

  it('does not invent ticks — no auto-start jobs', () => {
    const host = createJobHost({
      setIntervalFn: vi.fn(() => 1) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as typeof clearInterval,
    });
    expect(host.list()).toEqual([]);
  });
});

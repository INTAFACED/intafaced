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
    const handle = host.every('funding', 1000, tick);
    expect(host.list()).toEqual(['funding']);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(1000);

    await timers[0]!.fn();
    expect(tick).toHaveBeenCalledTimes(1);

    handle.stop();
    expect(host.list()).toEqual([]);
    expect(timers).toHaveLength(0);
  });

  it('refuses zero/negative interval and duplicate names', () => {
    const host = createJobHost({
      setIntervalFn: vi.fn(() => 1) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as typeof clearInterval,
    });
    expect(() => host.every('x', 0, () => {})).toThrow(/intervalMs/);
    host.every('x', 100, () => {});
    expect(() => host.every('x', 100, () => {})).toThrow(/already scheduled/);
  });

  it('does not invent ticks — no auto-start jobs', () => {
    const host = createJobHost({
      setIntervalFn: vi.fn(() => 1) as unknown as typeof setInterval,
      clearIntervalFn: vi.fn() as typeof clearInterval,
    });
    expect(host.list()).toEqual([]);
  });

  it('stopAll clears every job', () => {
    const cleared: number[] = [];
    let id = 0;
    const host = createJobHost({
      setIntervalFn: (() => ++id) as unknown as typeof setInterval,
      clearIntervalFn: ((x: number) => {
        cleared.push(x);
      }) as typeof clearInterval,
    });
    host.every('a', 10, () => {});
    host.every('b', 20, () => {});
    host.stopAll();
    expect(host.list()).toEqual([]);
    expect(cleared).toHaveLength(2);
  });
});

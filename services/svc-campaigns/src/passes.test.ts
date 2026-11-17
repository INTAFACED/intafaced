import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPasses } from './passes.js';

describe('startPasses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs each pass on its own interval and never overlaps a pass with itself', async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const fast = vi.fn(async () => undefined);
    const running = startPasses(
      [
        { name: 'slow pass', everyMs: 1_000, run: slow },
        { name: 'fast pass', everyMs: 500, run: fast },
      ],
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(6);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slow).toHaveBeenCalledTimes(2);
    running.stop();
  });

  it('names the pass that threw and keeps running it', async () => {
    const onError = vi.fn();
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const running = startPasses([{ name: 'reward payment pass', everyMs: 1_000, run }], onError);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'boom' }), 'reward payment pass');
    running.stop();
  });

  it('stops every pass at once', async () => {
    const run = vi.fn(async () => undefined);
    const running = startPasses(
      [
        { name: 'a', everyMs: 1_000, run },
        { name: 'b', everyMs: 1_000, run },
      ],
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    running.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

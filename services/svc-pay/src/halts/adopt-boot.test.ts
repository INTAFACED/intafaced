import { describe, expect, it } from 'vitest';
import { ADOPT_CONFIG_ATTEMPTS, ADOPT_CONFIG_BACKOFF_CAP_MS, adoptConfigBackoffMs, retryAdoptConfig } from './adopt-boot.js';

describe('adoptConfig boot retry', () => {
  it('stops at five tries and waits 1s, 2s, 4s, 8s, never past 16s', async () => {
    const waits: number[] = [];
    let calls = 0;
    await retryAdoptConfig(
      async () => {
        calls += 1;
        throw new Error('db down');
      },
      () => undefined,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(calls).toBe(ADOPT_CONFIG_ATTEMPTS);
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(adoptConfigBackoffMs(5)).toBe(ADOPT_CONFIG_BACKOFF_CAP_MS);
    expect(adoptConfigBackoffMs(9)).toBe(ADOPT_CONFIG_BACKOFF_CAP_MS);
  });

  it('logs every failure and returns after the last one', async () => {
    const logged: number[] = [];
    await retryAdoptConfig(
      async () => {
        throw new Error('db down');
      },
      (_error, attempt) => logged.push(attempt),
      async () => undefined,
    );
    expect(logged).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns on the first success and does not sleep', async () => {
    let calls = 0;
    let slept = 0;
    await retryAdoptConfig(
      async () => {
        calls += 1;
      },
      () => {
        throw new Error('should not log');
      },
      async () => {
        slept += 1;
      },
    );
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });

  it('retries until adopt succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    await retryAdoptConfig(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('db down');
      },
      () => undefined,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
  });
});

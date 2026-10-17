import { describe, expect, it } from 'vitest';
import { FIXTURE_TRUNCATE_ATTEMPTS, retryFixtureTruncate } from './fixture-truncate.testkit.js';

describe('fixture truncate retry', () => {
  it('retries deadlock_detected and then returns', async () => {
    let calls = 0;
    await retryFixtureTruncate(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    });
    expect(calls).toBe(3);
  });

  it('does not retry any other database error', async () => {
    let calls = 0;
    const failure = Object.assign(new Error('serialization failure'), { code: '40001' });
    await expect(
      retryFixtureTruncate(async () => {
        calls += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it('stops at the attempt bound and surfaces the deadlock', async () => {
    let calls = 0;
    const failure = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    await expect(
      retryFixtureTruncate(async () => {
        calls += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(FIXTURE_TRUNCATE_ATTEMPTS);
  });
});

/**
 * Two recovery schedulers, one pass.
 *
 * The lock is the same session advisory lock production takes
 * (`bank.recovery.jobs` / `singleton`) on TEST_DATABASE_URL. A second
 * scheduler that arrives while the first still holds it does not run the jobs.
 */
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { startBankRecoveryJobs } from './recovery-jobs.js';

const url = process.env.TEST_DATABASE_URL?.trim();
if (url === undefined || url === '') throw new Error('TEST_DATABASE_URL is unset');

const sql = postgres(url, { max: 2, onnotice: () => undefined });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('two recovery schedulers', () => {
  it('runs the pass once while the other replica holds the lock', async () => {
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls = { loans: 0, repay: 0, earn: 0 };
    const ports = {
      loans: {
        originationFeeBps: '0',
        resumePending: async () => {
          calls.loans += 1;
          if (calls.loans === 1) {
            entered();
            await hold;
          }
          return [];
        },
        recoverRepayments: async () => {
          calls.repay += 1;
          return [];
        },
      },
      earn: {
        resumePending: async () => {
          calls.earn += 1;
          return [];
        },
      },
    };
    const first = startBankRecoveryJobs({
      config: { intervalMs: 60_000, batchLimit: 50 },
      lock: sql,
      ...ports,
    });
    const second = startBankRecoveryJobs({
      config: { intervalMs: 60_000, batchLimit: 50 },
      lock: sql,
      ...ports,
    });
    try {
      const running = first.tickOnce();
      await started;
      await second.tickOnce();
      expect(calls).toEqual({ loans: 1, repay: 0, earn: 0 });
      releaseHold();
      await running;
      expect(calls).toEqual({ loans: 1, repay: 1, earn: 1 });
      await second.tickOnce();
      expect(calls).toEqual({ loans: 2, repay: 2, earn: 2 });
    } finally {
      releaseHold();
      first.stop();
      second.stop();
    }
  });
});

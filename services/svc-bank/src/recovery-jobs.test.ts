/**
 * Recovery timer — the jobs actually run.
 *
 * 1. Promise: the scheduler calls resume-pending loans, recover repayments and
 *    resume-pending earn; a thrown job does not cancel the next tick; a blank
 *    interval disables the timer and warns.
 * 2. Break: the endpoints exist and nothing calls them, so an unknown ledger
 *    outcome stays pending forever.
 * 3. Done bar: the cases below. Two replicas are the database test.
 * 4. Class M
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseRecoveryBatchLimit,
  parseRecoveryInterval,
  recoveryCounts,
  startBankRecoveryJobs,
  type RecoveryJobResult,
} from './recovery-jobs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SECRET = 's'.repeat(32);

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
  LOAN_QUOTE_ASSET_ID: 'X',
  TRANSFER_BATCH_SIZE: '200',
  LOAN_SWEEP_BATCH_SIZE: '500',
};

async function loadEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function jobs(impl?: {
  loans?: (limit: number) => Promise<readonly RecoveryJobResult[]>;
  repay?: (limit: number) => Promise<readonly RecoveryJobResult[]>;
  earn?: (limit: number) => Promise<readonly RecoveryJobResult[]>;
}) {
  return {
    loans: {
      originationFeeBps: '0',
      resumePending: vi.fn(impl?.loans ?? (async () => [{ outcome: 'completed' }])),
      recoverRepayments: vi.fn(impl?.repay ?? (async () => [{ outcome: 'open' }])),
    },
    earn: {
      resumePending: vi.fn(impl?.earn ?? (async () => [{ outcome: 'completed' }])),
    },
  };
}

describe('recovery schedule config', () => {
  it('uses the hold-unknown sweep defaults when unset, and blank disables', () => {
    expect(parseRecoveryInterval(undefined)).toBe(60_000);
    expect(parseRecoveryInterval(null)).toBe(60_000);
    expect(parseRecoveryInterval('')).toBeNull();
    expect(parseRecoveryInterval('   ')).toBeNull();
    expect(parseRecoveryInterval('60000')).toBe(60_000);
    expect(parseRecoveryBatchLimit(undefined)).toBe(50);
    expect(parseRecoveryBatchLimit('')).toBeNull();
    expect(parseRecoveryBatchLimit('   ')).toBeNull();
    expect(parseRecoveryBatchLimit('50')).toBe(50);
    expect(() => parseRecoveryInterval('0')).toThrow(/BANK_RECOVERY_JOBS_INTERVAL_MS/);
    expect(() => parseRecoveryInterval('4999')).toThrow(/BANK_RECOVERY_JOBS_INTERVAL_MS/);
    expect(() => parseRecoveryBatchLimit('0')).toThrow(/BANK_RECOVERY_JOBS_BATCH_LIMIT/);
    expect(() => parseRecoveryBatchLimit('1001')).toThrow(/BANK_RECOVERY_JOBS_BATCH_LIMIT/);
  });

  it('counts scanned, resolved and still unknown without changing a row', () => {
    expect(recoveryCounts([{ outcome: 'completed' }, { outcome: 'open' }, { outcome: 'failed', reason: 'socket hang up' }])).toEqual({
      scanned: 3,
      resolved: 2,
      stillUnknown: 1,
    });
  });

  it('env leaves the timer on by default and blank turns each knob off', async () => {
    expect((await loadEnv()).BANK_RECOVERY_JOBS_INTERVAL_MS).toBe(60_000);
    expect((await loadEnv()).BANK_RECOVERY_JOBS_BATCH_LIMIT).toBe(50);
    expect((await loadEnv({ BANK_RECOVERY_JOBS_INTERVAL_MS: '' })).BANK_RECOVERY_JOBS_INTERVAL_MS).toBeNull();
    expect((await loadEnv({ BANK_RECOVERY_JOBS_INTERVAL_MS: '   ' })).BANK_RECOVERY_JOBS_INTERVAL_MS).toBeNull();
    expect((await loadEnv({ BANK_RECOVERY_JOBS_BATCH_LIMIT: '' })).BANK_RECOVERY_JOBS_BATCH_LIMIT).toBeNull();
    await expect(loadEnv({ BANK_RECOVERY_JOBS_INTERVAL_MS: 'nope' })).rejects.toThrow(/BANK_RECOVERY_JOBS_INTERVAL_MS/);
  });
});

describe('startBankRecoveryJobs', () => {
  it('invokes each recovery job and logs scanned, resolved, still unknown', async () => {
    vi.useFakeTimers();
    const ports = jobs({
      loans: async (limit) => {
        expect(limit).toBe(50);
        return [{ outcome: 'completed' }, { outcome: 'failed', reason: 'down' }];
      },
      repay: async (limit) => {
        expect(limit).toBe(50);
        return [{ outcome: 'open' }, { outcome: 'failed' }];
      },
      earn: async (limit) => {
        expect(limit).toBe(50);
        return [{ outcome: 'completed' }];
      },
    });
    const onResult = vi.fn();
    const handle = startBankRecoveryJobs({
      config: { intervalMs: 1_000, batchLimit: 50 },
      ...ports,
      tryLock: async (_namespace, _key, body) => {
        await body();
        return { acquired: true };
      },
      onResult,
    });
    expect(handle.list()).toEqual([
      'bank.recovery.resume_pending_loans',
      'bank.recovery.recover_loan_repayments',
      'bank.recovery.resume_pending_earn',
    ]);
    expect(ports.loans.resumePending).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ports.loans.resumePending).toHaveBeenCalledTimes(1);
    expect(ports.loans.recoverRepayments).toHaveBeenCalledTimes(1);
    expect(ports.earn.resumePending).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('bank.recovery.resume_pending_loans', {
      scanned: 2,
      resolved: 1,
      stillUnknown: 1,
    });
    expect(onResult).toHaveBeenCalledWith('bank.recovery.recover_loan_repayments', {
      scanned: 2,
      resolved: 1,
      stillUnknown: 1,
    });
    expect(onResult).toHaveBeenCalledWith('bank.recovery.resume_pending_earn', {
      scanned: 1,
      resolved: 1,
      stillUnknown: 0,
    });
    handle.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.loans.resumePending).toHaveBeenCalledTimes(1);
  });

  it('announces owed personal-send notices as a fourth job when that port is given', async () => {
    vi.useFakeTimers();
    const announceUnannounced = vi.fn(async (limit: number): Promise<readonly RecoveryJobResult[]> => {
      expect(limit).toBe(50);
      return [{ outcome: 'completed' }, { outcome: 'failed', reason: 'bank.transfer_notice_failed' }];
    });
    const onResult = vi.fn();
    const handle = startBankRecoveryJobs({
      config: { intervalMs: 1_000, batchLimit: 50 },
      ...jobs(),
      transferNotices: { announceUnannounced },
      tryLock: async (_namespace, _key, body) => {
        await body();
        return { acquired: true };
      },
      onResult,
    });
    expect(handle.list()).toContain('bank.recovery.announce_posted_transfers');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(announceUnannounced).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('bank.recovery.announce_posted_transfers', { scanned: 2, resolved: 1, stillUnknown: 1 });
    handle.stop();
  });

  it('drives on cash-outs left before their hold or the partner as a fifth job when that port is given', async () => {
    vi.useFakeTimers();
    const redrive = vi.fn(async (limit: number): Promise<readonly RecoveryJobResult[]> => {
      expect(limit).toBe(50);
      return [{ outcome: 'completed' }, { outcome: 'failed', reason: 'bank.cash_out_partner_gone' }];
    });
    const onResult = vi.fn();
    const handle = startBankRecoveryJobs({
      config: { intervalMs: 1_000, batchLimit: 50 },
      ...jobs(),
      cashOuts: { redrive },
      tryLock: async (_namespace, _key, body) => {
        await body();
        return { acquired: true };
      },
      onResult,
    });
    expect(handle.list()).toContain('bank.recovery.redrive_cash_outs');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(redrive).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('bank.recovery.redrive_cash_outs', { scanned: 2, resolved: 1, stillUnknown: 1 });
    handle.stop();
  });

  it('a job error does not stop the next tick', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const ports = jobs({
      loans: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ledger down');
        return [{ outcome: 'completed' }];
      },
    });
    const onError = vi.fn();
    const handle = startBankRecoveryJobs({
      config: { intervalMs: 1_000, batchLimit: 50 },
      ...ports,
      tryLock: async (_namespace, _key, body) => {
        await body();
        return { acquired: true };
      },
      onError,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe('bank.recovery.resume_pending_loans');
    expect(ports.loans.recoverRepayments).toHaveBeenCalledTimes(1);
    expect(ports.earn.resumePending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(ports.loans.recoverRepayments).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('a blank interval disables the timer and warns', async () => {
    vi.useFakeTimers();
    const ports = jobs();
    const onWarn = vi.fn();
    const handle = startBankRecoveryJobs({
      config: { intervalMs: null, batchLimit: 50 },
      ...ports,
      onWarn,
    });
    expect(handle.list()).toEqual([]);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith('BANK_RECOVERY_JOBS_INTERVAL_MS is blank: loan and earn recovery jobs are disabled');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.loans.resumePending).not.toHaveBeenCalled();
    expect(ports.loans.recoverRepayments).not.toHaveBeenCalled();
    expect(ports.earn.resumePending).not.toHaveBeenCalled();
    handle.stop();
  });

  it('a blank batch disables the timer and warns', async () => {
    vi.useFakeTimers();
    const ports = jobs();
    const onWarn = vi.fn();
    const handle = startBankRecoveryJobs({
      config: { intervalMs: 60_000, batchLimit: null },
      ...ports,
      onWarn,
    });
    expect(handle.list()).toEqual([]);
    expect(onWarn).toHaveBeenCalledWith('BANK_RECOVERY_JOBS_BATCH_LIMIT is blank: loan and earn recovery jobs are disabled');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.loans.resumePending).not.toHaveBeenCalled();
    expect(ports.earn.resumePending).not.toHaveBeenCalled();
    handle.stop();
  });

  it('index.ts starts the timer and stops it on shutdown', () => {
    const index = readFileSync(join(HERE, 'index.ts'), 'utf8');
    expect(index).toContain('startBankRecoveryJobs');
    expect(index).toContain('recoveryJobs.stop()');
    expect(index).toContain('scanned: counts.scanned');
    expect(index).toContain('stillUnknown: counts.stillUnknown');
    const env = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(env).toContain('parseRecoveryInterval');
    expect(env).toContain('parseRecoveryBatchLimit');
    expect(env).not.toMatch(/BANK_RECOVERY_JOBS_BATCH_LIMIT[\s\S]{0,200}\.default\(100\)/);
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const block = compose.match(/^  svc-bank:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m)?.[0] ?? '';
    expect(block).toMatch(/BANK_RECOVERY_JOBS_INTERVAL_MS:\s*\$\{BANK_RECOVERY_JOBS_INTERVAL_MS-60000\}/);
    expect(block).toMatch(/BANK_RECOVERY_JOBS_BATCH_LIMIT:\s*\$\{BANK_RECOVERY_JOBS_BATCH_LIMIT-50\}/);
    expect(compose.match(/^\s+BANK_RECOVERY_JOBS_INTERVAL_MS:/gm) ?? []).toHaveLength(1);
    expect(compose.match(/^\s+BANK_RECOVERY_JOBS_BATCH_LIMIT:/gm) ?? []).toHaveLength(1);
  });
});

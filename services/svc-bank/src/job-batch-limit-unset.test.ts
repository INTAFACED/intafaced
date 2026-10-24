import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BankError } from './errors.js';
import {
  assertAutoInvestBatchLimit,
  assertEarnResumePendingLimit,
  assertLoanAccrueBatchLimit,
  assertLoanResumePendingLimit,
  assertLoanRiskSweepLimit,
  assertTransferDueLimit,
} from './job-batch-limit.js';
import { bankRouterSource } from './router/router-source.js';

/**
 * Job batch size is refuse-closed when unset.
 *
 * Omit used to invent 100 (resumePending) / 200 (runDueTransfers / auto-invest)
 * / 500 (runRiskSweep) / 1000 (loans.accrueAll). Blank must refuse. Owner/cron
 * may pass those magnitudes explicitly.
 *
 * Not milled: earn.accrueAll (no invented row cap), Number() bps, card-sim.
 * TRANSFER_BATCH_SIZE / LOAN_SWEEP_BATCH_SIZE env already refuse-closed (#4051).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function refuseBank(fn: (n: number | undefined) => number, code: string, invented: number) {
  expect(() => fn(undefined)).toThrow(BankError);
  expect(() => fn(Number.NaN)).toThrow(BankError);
  expect(() => fn(0)).toThrow(BankError);
  try {
    fn(undefined);
    throw new Error('expected refuse');
  } catch (e) {
    expect(e).toBeInstanceOf(BankError);
    expect((e as BankError).code).toBe(code);
    expect((e as BankError).message).not.toMatch(new RegExp(`default ${invented}|${invented}-row`, 'i'));
  }
}

describe('svc-bank resumePending/accrueAll limit unset refuse', () => {
  it('earn.resumePending refuses blank / NaN — never invent 100; owner may pass 100', () => {
    refuseBank(assertEarnResumePendingLimit, 'bank.earn_resume_pending_limit_unset', 100);
    expect(assertEarnResumePendingLimit(100)).toBe(100);
    expect(assertEarnResumePendingLimit(1)).toBe(1);
    expect(assertEarnResumePendingLimit(1_000)).toBe(1_000);
    expect(() => assertEarnResumePendingLimit(0)).toThrow(BankError);
    expect(() => assertEarnResumePendingLimit(1_001)).toThrow(BankError);
    try {
      assertEarnResumePendingLimit(1_001);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(BankError);
      expect((e as BankError).code).toBe('bank.validation_failed');
    }
  });

  it('loans.resumePending refuses blank / NaN — never invent 100; owner may pass 100', () => {
    refuseBank(assertLoanResumePendingLimit, 'bank.loan_resume_pending_limit_unset', 100);
    expect(assertLoanResumePendingLimit(100)).toBe(100);
    expect(assertLoanResumePendingLimit(1)).toBe(1);
    expect(assertLoanResumePendingLimit(1_000)).toBe(1_000);
    try {
      assertLoanResumePendingLimit(10_000);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(BankError);
      expect((e as BankError).code).toBe('bank.validation_failed');
    }
  });

  it('loans.accrueAll refuses blank / NaN — never invent 1000; owner may pass 1000', () => {
    refuseBank(assertLoanAccrueBatchLimit, 'bank.loan_accrue_batch_limit_unset', 1_000);
    expect(assertLoanAccrueBatchLimit(1_000)).toBe(1_000);
    expect(assertLoanAccrueBatchLimit(1)).toBe(1);
    expect(assertLoanAccrueBatchLimit(10_000)).toBe(10_000);
    expect(() => assertLoanAccrueBatchLimit(0)).toThrow(BankError);
    try {
      assertLoanAccrueBatchLimit(10_001);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(BankError);
      expect((e as BankError).code).toBe('bank.validation_failed');
    }
  });

  it('services no longer default resumePending/accrueAll batch to 100/1000', () => {
    const earn = readFileSync(join(ROOT, 'services/svc-bank/src/earn/earn-service.ts'), 'utf8');
    const earnResume = earn.slice(earn.indexOf('async resumePending('), earn.indexOf('async position('));
    expect(earnResume).toContain('assertEarnResumePendingLimit');
    expect(earnResume).not.toMatch(/limit = 100/);
    expect(earnResume).not.toMatch(/\?\? 100/);

    const loans = readFileSync(join(ROOT, 'services/svc-bank/src/loans/loan-service.ts'), 'utf8');
    const loanResume = loans.slice(loans.indexOf('async resumePending('), loans.indexOf('async abandonPending('));
    expect(loanResume).toContain('assertLoanResumePendingLimit');
    expect(loanResume).not.toMatch(/limit = 100/);
    expect(loanResume).not.toMatch(/\?\? 100/);

    const loanAccrue = loans.slice(loans.indexOf('async accrueAll('), loans.indexOf('async repay('));
    expect(loanAccrue).toContain('assertLoanAccrueBatchLimit');
    expect(loanAccrue).not.toMatch(/limit = 1_000/);
    expect(loanAccrue).not.toMatch(/limit = 1000/);
    expect(loanAccrue).not.toMatch(/\?\? 1_000/);
    expect(loanAccrue).not.toMatch(/\?\? 1000/);
  });

  it('HTTP jobs require body.limit — omit does not invent 100/1000', () => {
    const index = readFileSync(join(ROOT, 'services/svc-bank/src/index.ts'), 'utf8');
    const resumeLoans = index.slice(
      index.indexOf("app.post('/internal/jobs/resume-pending-loans'"),
      index.indexOf("app.post('/internal/jobs/resume-pending-earn'"),
    );
    expect(resumeLoans).toContain('assertLoanResumePendingLimit');
    expect(resumeLoans).not.toMatch(/resumePending\(\s*\)/);

    const resumeEarn = index.slice(
      index.indexOf("app.post('/internal/jobs/resume-pending-earn'"),
      index.indexOf("app.post('/internal/jobs/run-auto-invest'"),
    );
    expect(resumeEarn).toContain('assertEarnResumePendingLimit');
    expect(resumeEarn).not.toMatch(/resumePending\(\s*\)/);

    const accrueLoan = index.slice(
      index.indexOf("app.post('/internal/jobs/accrue-loan-interest'"),
      index.indexOf("app.post('/internal/jobs/run-risk-sweep'"),
    );
    expect(accrueLoan).toContain('assertLoanAccrueBatchLimit');
    expect(accrueLoan).not.toMatch(/accrueAll\(\s*\)/);
  });

  it('tRPC all-book accrueLoanInterest passes input.limit — no invented 1000', () => {
    const router = bankRouterSource();
    const accrue = router.slice(router.indexOf('accrueLoanInterest: jobProcedure'), router.indexOf('runRiskSweep: jobProcedure'));
    expect(accrue).toContain('bank.loans.accrueAll(at, input.limit)');
    expect(accrue).not.toMatch(/accrueAll\(at\)/);
  });
});

describe('svc-bank leftover job-batch unset refuse (200/500)', () => {
  it('transfers.runDueTransfers refuses blank / NaN — never invent 200; owner may pass 200', () => {
    refuseBank(assertTransferDueLimit, 'bank.transfer_due_limit_unset', 200);
    expect(assertTransferDueLimit(200)).toBe(200);
    expect(assertTransferDueLimit(1)).toBe(1);
    expect(assertTransferDueLimit(10_000)).toBe(10_000);
    expect(() => assertTransferDueLimit(0)).toThrow(BankError);
    try {
      assertTransferDueLimit(10_001);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(BankError);
      expect((e as BankError).code).toBe('bank.validation_failed');
    }
  });

  it('autoInvest.runDue refuses blank / NaN — never invent 200; owner may pass 200', () => {
    refuseBank(assertAutoInvestBatchLimit, 'bank.auto_invest_batch_limit_unset', 200);
    expect(assertAutoInvestBatchLimit(200)).toBe(200);
    expect(assertAutoInvestBatchLimit(1)).toBe(1);
    expect(assertAutoInvestBatchLimit(10_000)).toBe(10_000);
    try {
      assertAutoInvestBatchLimit(10_001);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(BankError);
      expect((e as BankError).code).toBe('bank.validation_failed');
    }
  });

  it('loans.runRiskSweep refuses blank / NaN — never invent 500; owner may pass 500', () => {
    refuseBank(assertLoanRiskSweepLimit, 'bank.loan_risk_sweep_limit_unset', 500);
    expect(assertLoanRiskSweepLimit(500)).toBe(500);
    expect(assertLoanRiskSweepLimit(1)).toBe(1);
    expect(assertLoanRiskSweepLimit(10_000)).toBe(10_000);
    try {
      assertLoanRiskSweepLimit(10_001);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(BankError);
      expect((e as BankError).code).toBe('bank.validation_failed');
    }
  });

  it('services no longer default runDueTransfers / auto-invest / runRiskSweep batch to 200/500', () => {
    const transfers = readFileSync(join(ROOT, 'services/svc-bank/src/transfers/transfer-service.ts'), 'utf8');
    const due = transfers.slice(transfers.indexOf('async runDueTransfers('), transfers.indexOf('private async sweepStrandedClaims('));
    expect(due).toContain('assertTransferDueLimit');
    expect(due).not.toMatch(/\?\? 200/);

    const auto = readFileSync(join(ROOT, 'services/svc-bank/src/auto-invest/auto-invest-service.ts'), 'utf8');
    const ctor = auto.slice(auto.indexOf('constructor('), auto.indexOf('async createThresholdSweep('));
    expect(ctor).not.toMatch(/\?\? 200/);
    expect(ctor).not.toMatch(/batchSize = 200/);
    const runDue = auto.slice(auto.indexOf('async runDue('), auto.indexOf('async runsOf('));
    expect(runDue).toContain('assertAutoInvestBatchLimit');
    expect(runDue).not.toMatch(/\?\? 200/);

    const loans = readFileSync(join(ROOT, 'services/svc-bank/src/loans/loan-service.ts'), 'utf8');
    const sweep = loans.slice(loans.indexOf('async runRiskSweep('), loans.indexOf('private async markAndAct('));
    expect(sweep).toContain('assertLoanRiskSweepLimit');
    expect(sweep).not.toMatch(/\?\? 500/);
  });

  it('HTTP auto-invest requires body.limit — omit does not invent 200', () => {
    const index = readFileSync(join(ROOT, 'services/svc-bank/src/index.ts'), 'utf8');
    const autoJob = index.slice(
      index.indexOf("app.post('/internal/jobs/run-auto-invest'"),
      index.indexOf('await app.register(fastifyTRPCPlugin'),
    );
    expect(autoJob).toContain('assertAutoInvestBatchLimit');
    expect(autoJob).not.toMatch(/runDue\(\{\s*\}\)/);
  });

  it('tRPC job twins pass input.limit — omit does not invent 200/500', () => {
    const router = bankRouterSource();
    const due = router.slice(router.indexOf('runDueTransfers: jobProcedure'), router.indexOf('runAutoInvest: jobProcedure'));
    expect(due).toContain('runDueTransfers({ limit: input.limit })');
    expect(due).not.toMatch(/input\.limit === undefined \? \{\}/);

    const auto = router.slice(router.indexOf('runAutoInvest: jobProcedure'), router.indexOf('accrueInterest: jobProcedure'));
    expect(auto).toContain('runDue({ limit: input.limit })');
    expect(auto).not.toMatch(/input\.limit === undefined \? \{\}/);

    const sweep = router.slice(router.indexOf('runRiskSweep: jobProcedure'), router.indexOf('seizeLoan: scopedProcedure'));
    expect(sweep).toContain('runRiskSweep({ limit: input.limit })');
    expect(sweep).not.toMatch(/input\.limit === undefined \? \{\}/);
  });
});

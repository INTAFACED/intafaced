import { BankError, type BankErrorCode } from './errors.js';

const RESUME_MAX = 1_000;
const ACCRUE_MAX = 10_000;

function assertJobBatchLimit(limit: number | undefined, unsetCode: BankErrorCode, invented: number, max: number, name: string): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new BankError(
      `${name} batch size is unset. Blank refuses — never ${invented}. Pass a positive integer (${invented} is allowed if explicit).`,
      unsetCode,
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new BankError(`limit must be an integer 1..${max}, got ${limit}`, 'bank.validation_failed');
  }
  return limit;
}

/** earn.resumePending worker batch. Omit used to invent 100. */
export function assertEarnResumePendingLimit(limit: number | undefined): number {
  return assertJobBatchLimit(limit, 'bank.earn_resume_pending_limit_unset', 100, RESUME_MAX, 'earn.resumePending');
}

/** earn.renewDue worker batch: how many ended fixed-term savings one run renews. Blank refuses, never a default. */
export function assertEarnRenewBatchLimit(limit: number | undefined): number {
  return assertJobBatchLimit(limit, 'bank.earn_renew_batch_limit_unset', 100, RESUME_MAX, 'earn.renewDue');
}

/** earn.releaseUnbonded worker batch: how many ended unbondings one run releases (BK-earn-04). Blank refuses. */
export function assertEarnReleaseBatchLimit(limit: number | undefined): number {
  return assertJobBatchLimit(limit, 'bank.earn_release_batch_limit_unset', 100, RESUME_MAX, 'earn.releaseUnbonded');
}

/** loans.resumePending worker batch. Omit used to invent 100. */
export function assertLoanResumePendingLimit(limit: number | undefined): number {
  return assertJobBatchLimit(limit, 'bank.loan_resume_pending_limit_unset', 100, RESUME_MAX, 'loans.resumePending');
}

/** loans.accrueAll worker batch. Omit used to invent 1000. */
export function assertLoanAccrueBatchLimit(limit: number | undefined): number {
  return assertJobBatchLimit(limit, 'bank.loan_accrue_batch_limit_unset', 1_000, ACCRUE_MAX, 'loans.accrueAll');
}

/** transfers.runDueTransfers worker batch. Omit used to invent 200. */
export function assertTransferDueLimit(limit: number | undefined): number {
  return assertJobBatchLimit(limit, 'bank.transfer_due_limit_unset', 200, ACCRUE_MAX, 'transfers.runDueTransfers');
}

/** autoInvest constructor / runDue worker batch. Omit used to invent 200. */
export function assertAutoInvestBatchLimit(limit: number | undefined): number {
  return assertJobBatchLimit(limit, 'bank.auto_invest_batch_limit_unset', 200, ACCRUE_MAX, 'autoInvest.runDue');
}

/** loans.runRiskSweep worker batch. Omit used to invent 500. */
export function assertLoanRiskSweepLimit(limit: number | undefined): number {
  return assertJobBatchLimit(limit, 'bank.loan_risk_sweep_limit_unset', 500, ACCRUE_MAX, 'loans.runRiskSweep');
}

import type { BankRoot } from '../bank-root.js';
import type { AccountDetailsService } from '../account-details/account-details.js';
import type { IncomeSorterService } from '../sorter/income-sorter.js';
import type { PayrollPartner } from './payroll-sim.js';
import { SalaryService } from './salary-service.js';

/** Salary by direct deposit (J-bank-30). An area of svc-bank (`area-chain.ts`). */
export interface SalaryServices {
  /** J-bank-30: salary paid in by direct deposit, at the partner bank. `rail.bank` while no payroll network is wired. */
  readonly salary: SalaryService;
}

export interface SalaryServiceOptions {
  /** The payroll network for salary by direct deposit (J-bank-30). Unset: every salary door refuses `rail.bank`. */
  payrollPartner?: PayrollPartner | null;
  /** `BANK_DIRECT_DEPOSIT_REVERSAL_DAYS`: how long an employer may reverse a salary credit. Blank refuses every reversal. */
  directDepositReversalDays?: string | undefined;
  /** The salary credits' clock, which the reversal window reads. Unset: the wall clock. Tests move it. */
  salaryNow?: () => Date;
}

export function composeSalaryArea(
  root: BankRoot,
  made: { readonly accountDetails: AccountDetailsService; readonly sorter: Pick<IncomeSorterService, 'list' | 'minimumCredit'> },
  options: SalaryServiceOptions,
): SalaryServices {
  return {
    salary: new SalaryService(root.sql, {
      payroll: options.payrollPartner ?? null,
      custody: root.custody,
      accountDetails: made.accountDetails,
      sorter: made.sorter,
      reversalDays: () => options.directDepositReversalDays,
      ...(options.salaryNow ? { now: options.salaryNow } : {}),
    }),
  };
}

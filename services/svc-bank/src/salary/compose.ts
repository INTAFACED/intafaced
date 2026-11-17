import type { Sql } from 'postgres';
import type { AccountDetailsService } from '../account-details/account-details.js';
import type { IncomeSorterService } from '../sorter/income-sorter.js';
import type { PayrollPartner } from './payroll-sim.js';
import { SalaryService } from './salary-service.js';

/**
 * Salary by direct deposit (J-bank-30), made in its own place: `bank-service.ts` spreads these and does not change for a
 * salary journey (project-state #2656; `bank-service.compose.test.ts`).
 */
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

export interface SalaryComposeContext {
  readonly sql: Sql;
  readonly accountDetails: AccountDetailsService;
  readonly sorter: Pick<IncomeSorterService, 'list' | 'minimumCredit'>;
}

export function composeSalaryServices(ctx: SalaryComposeContext, options: SalaryServiceOptions): SalaryServices {
  return {
    salary: new SalaryService(ctx.sql, {
      payroll: options.payrollPartner ?? null,
      accountDetails: ctx.accountDetails,
      sorter: ctx.sorter,
      reversalDays: () => options.directDepositReversalDays,
      ...(options.salaryNow ? { now: options.salaryNow } : {}),
    }),
  };
}

import type { BankRoot } from '../bank-root.js';
import type { DirectDebitService } from '../direct-debits/direct-debits.js';
import type { EarnService } from '../earn/earn-service.js';
import type { LoanService } from '../loans/loan-service.js';
import type { BillPayService } from '../personal-pay/bills.js';
import type { TransferService } from '../transfers/transfer-service.js';
import { CalendarService } from './calendar.js';

/** One read of what is dated. An area of svc-bank (`area-chain.ts`). */
export interface CalendarServices {
  /** BK-acct-10: one read of what is dated, merged from svc-bank's own sources. Reads only. */
  readonly calendar: CalendarService;
}

export function composeCalendarArea(
  root: BankRoot,
  made: {
    readonly transfers: TransferService;
    readonly bills: BillPayService;
    readonly directDebits: DirectDebitService;
    readonly earn: EarnService;
    readonly loans: LoanService;
  },
): CalendarServices {
  return {
    calendar: new CalendarService({
      sql: root.sql,
      transfers: made.transfers,
      bills: made.bills,
      directDebits: made.directDebits,
      earn: made.earn,
      loans: made.loans,
      log: (source, err) =>
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'svc-bank',
            event: 'bank.calendar_source_failed',
            source,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
    }),
  };
}

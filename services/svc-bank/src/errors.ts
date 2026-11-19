import { SHARED_BANK_ERRORS } from './shared-bank-errors.js';
import { ACCOUNT_DETAILS_BANK_ERRORS } from './account-details/bank-errors.js';
import { ACCOUNT_HOME_BANK_ERRORS } from './account-home/bank-errors.js';
import { ACTIVITY_BANK_ERRORS } from './activity/bank-errors.js';
import { ANALYTICS_BANK_ERRORS } from './analytics/bank-errors.js';
import { AUTO_INVEST_BANK_ERRORS } from './auto-invest/bank-errors.js';
import { BUSINESS_BANK_ERRORS } from './business/bank-errors.js';
import { CALENDAR_BANK_ERRORS } from './calendar/bank-errors.js';
import { CARDS_BANK_ERRORS } from './cards/bank-errors.js';
import { CASH_OUT_BANK_ERRORS } from './cash-out/bank-errors.js';
import { DEPOSITS_BANK_ERRORS } from './deposits/bank-errors.js';
import { DEVELOPER_API_BANK_ERRORS } from './developer-api/bank-errors.js';
import { DIRECT_DEBITS_BANK_ERRORS } from './direct-debits/bank-errors.js';
import { EARN_BANK_ERRORS } from './earn/bank-errors.js';
import { HOLDS_BANK_ERRORS } from './holds/bank-errors.js';
import { LINKED_ACCOUNTS_BANK_ERRORS } from './linked-accounts/bank-errors.js';
import { LOANS_BANK_ERRORS } from './loans/bank-errors.js';
import { ONBOARDING_BANK_ERRORS } from './onboarding/bank-errors.js';
import { OPS_BANK_ERRORS } from './ops/bank-errors.js';
import { OWN_MOVES_BANK_ERRORS } from './own-moves/bank-errors.js';
import { PARTNER_BANK_ERRORS } from './partner/bank-errors.js';
import { PAY_YOURSELF_BANK_ERRORS } from './pay-yourself/bank-errors.js';
import { PORTFOLIO_BANK_ERRORS } from './portfolio/bank-errors.js';
import { RAIL_SENDS_BANK_ERRORS } from './rail-sends/bank-errors.js';
import { RAMPS_BANK_ERRORS } from './ramps/bank-errors.js';
import { RECOVERY_BANK_ERRORS } from './recovery/bank-errors.js';
import { ROUTER_BANK_ERRORS } from './router/bank-errors.js';
import { RULES_BANK_ERRORS } from './rules/bank-errors.js';
import { SAFETY_BANK_ERRORS } from './safety/bank-errors.js';
import { SALARY_BANK_ERRORS } from './salary/bank-errors.js';
import { SORTER_BANK_ERRORS } from './sorter/bank-errors.js';
import { SPACES_BANK_ERRORS } from './spaces/bank-errors.js';
import { STATEMENTS_BANK_ERRORS } from './statements/bank-errors.js';
import { STEP_UP_BANK_ERRORS } from './step-up/bank-errors.js';
import { TRANSFERS_BANK_ERRORS } from './transfers/bank-errors.js';

/**
 * svc-bank's own failure vocabulary.
 *
 * Codes are stable strings because they are what an SLO dashboard groups by and
 * what a client branches on. `bank.pool_underfunded` (an operator alarm: yield
 * we cannot pay) and `ledger.insufficient_funds` (a user with an empty space)
 * are both "the transfer did not happen", and collapsing them into one message
 * would make both unactionable.
 *
 * Every code, with what a caller is told for it, is declared in the `bank-errors.ts` of the folder that throws
 * it (`shared-bank-errors.ts` when more than one folder does). A new refusal goes there; a new folder's table is
 * spread here once. `errors-home.test.ts` refuses a code written in this file or in `router/errors.ts`.
 */
export const BANK_ERROR_STATUS = {
  ...SHARED_BANK_ERRORS,
  ...ACCOUNT_DETAILS_BANK_ERRORS,
  ...ACCOUNT_HOME_BANK_ERRORS,
  ...ACTIVITY_BANK_ERRORS,
  ...ANALYTICS_BANK_ERRORS,
  ...AUTO_INVEST_BANK_ERRORS,
  ...BUSINESS_BANK_ERRORS,
  ...CALENDAR_BANK_ERRORS,
  ...CARDS_BANK_ERRORS,
  ...CASH_OUT_BANK_ERRORS,
  ...DEPOSITS_BANK_ERRORS,
  ...DEVELOPER_API_BANK_ERRORS,
  ...DIRECT_DEBITS_BANK_ERRORS,
  ...EARN_BANK_ERRORS,
  ...HOLDS_BANK_ERRORS,
  ...LINKED_ACCOUNTS_BANK_ERRORS,
  ...LOANS_BANK_ERRORS,
  ...ONBOARDING_BANK_ERRORS,
  ...OPS_BANK_ERRORS,
  ...OWN_MOVES_BANK_ERRORS,
  ...PARTNER_BANK_ERRORS,
  ...PAY_YOURSELF_BANK_ERRORS,
  ...PORTFOLIO_BANK_ERRORS,
  ...RAIL_SENDS_BANK_ERRORS,
  ...RAMPS_BANK_ERRORS,
  ...RECOVERY_BANK_ERRORS,
  ...ROUTER_BANK_ERRORS,
  ...RULES_BANK_ERRORS,
  ...SAFETY_BANK_ERRORS,
  ...SALARY_BANK_ERRORS,
  ...SORTER_BANK_ERRORS,
  ...SPACES_BANK_ERRORS,
  ...STATEMENTS_BANK_ERRORS,
  ...STEP_UP_BANK_ERRORS,
  ...TRANSFERS_BANK_ERRORS,
} as const;

export type BankErrorCode = keyof typeof BANK_ERROR_STATUS;

export class BankError extends Error {
  constructor(
    message: string,
    readonly code: BankErrorCode,
  ) {
    super(message);
    this.name = 'BankError';
  }
}

/**
 * The ledger's platform-wide posting freeze refused a personal send, and the refusal proves nothing posted
 * (`provesPostNotCommitted`), so the reservation was abandoned (J-identity-14 #2). It reaches the customer as the
 * ledger's own code, `ledger.frozen`, a definite refusal and never an unknown outcome, so the app says the platform is
 * paused and never that this account is held. A freeze refusal that proves nothing stays a `LedgerError` (an unknown).
 */
export class LedgerFrozenRefusal extends Error {
  readonly code = 'ledger.frozen' as const;
  constructor(cause: unknown) {
    super('ledger.frozen', { cause });
    this.name = 'LedgerFrozenRefusal';
  }
}

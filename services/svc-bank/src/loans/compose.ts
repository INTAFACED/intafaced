import type { BankRoot } from '../bank-root.js';
import type { ActivityServiceOptions } from '../activity/activity-service.js';
import { LoanService, type LoanServiceOptions } from './loan-service.js';
import { fixedPriceSource } from './prices.js';

/** Crypto-backed loans. An area of svc-bank (`area-chain.ts`). */
export interface LoansServices {
  readonly loans: LoanService;
}

export interface LoansAreaOptions {
  /**
   * Loan wiring: where LTV marks come from, who buys seized collateral, and where
   * a margin call is delivered.
   *
   * Injected rather than constructed here, and deliberately not defaulted to a
   * live feed. svc-trade has no index price today — only best bid/ask and last
   * trade — so the adapter in use decides whether a liquidation may happen at
   * all. `loans/prices.ts` sets out what that costs and what would fix it. A
   * default that quietly reached for `last` would bury the most important caveat
   * in this module inside a composition root nobody reads.
   */
  loans?: LoanServiceOptions;
  /** The activity area's cursor secret: a loan statement is signed with it unless the loan options name their own. */
  activity?: Pick<ActivityServiceOptions, 'cursorSecret'>;
}

export function composeLoansArea(root: BankRoot, _made: object, options: LoansAreaOptions): LoansServices {
  // No price source configured = no marks = no liquidations, and every LTV read
  // fails with `bank.mark_missing`. The correct posture for a deployment that has
  // not decided where its prices come from.
  const loanBase = options.loans ?? { priceSource: fixedPriceSource({}) };
  // The payoff fee and window come from env (index.ts); unset or blank refuses.
  return {
    loans: new LoanService(root.sql, root.ledger, {
      ...loanBase,
      statementSecret: loanBase.statementSecret !== undefined ? loanBase.statementSecret : options.activity?.cursorSecret,
    }),
  };
}

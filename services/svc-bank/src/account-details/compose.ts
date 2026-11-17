import { AccountDetailsService, type AccountDetailsOptions } from './account-details.js';

/** Account details and the eligibility statement. An area of svc-bank (`area-chain.ts`). */
export interface AccountDetailsServices {
  readonly accountDetails: AccountDetailsService;
}

export interface AccountDetailsAreaOptions {
  /**
   * Account details and the eligibility statement (BK-acct-03). The currencies and the rule set are the owner's and have no
   * default; the banking partner is not wired today, so details refuse `rail.bank`.
   */
  accountDetails?: AccountDetailsOptions;
}

export function composeAccountDetailsArea(_root: unknown, _made: object, options: AccountDetailsAreaOptions): AccountDetailsServices {
  // No banking partner = every currency answers unavailable with `rail.bank`; no details are made up.
  return { accountDetails: new AccountDetailsService(options.accountDetails ?? {}) };
}

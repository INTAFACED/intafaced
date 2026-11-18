import type { BankRoot } from '../bank-root.js';
import { BANK_OFFRAMP_COOLING_HOURS_ENV } from '../offramp-cooling.js';
import type { RampServiceOptions } from '../ramps/ramp-service.js';
import { BANK_ADDRESS_BOOK_CAP_ENV } from '../withdraw-destination.js';
import { LinkedAccountService } from './linked-accounts.js';

/** The customer's own accounts at other banks. An area of svc-bank (`area-chain.ts`). */
export interface LinkedAccountsServices {
  /** BK-acct-02: the customer's own accounts at other banks. Kept unverified until a banking partner verifies them. */
  readonly linkedAccounts: LinkedAccountService;
}

export interface LinkedAccountsServiceOptions {
  /** The ramps area's address book cap and payout cooling-off: the same owner values as the crypto address book. */
  ramps?: Pick<RampServiceOptions, 'addressBookCap' | 'offrampCoolingHours'>;
}

export function composeLinkedAccountsArea(root: BankRoot, _made: object, options: LinkedAccountsServiceOptions): LinkedAccountsServices {
  return {
    linkedAccounts: new LinkedAccountService(root.sql, {
      // Resolved as RampService resolves them: a value passed in wins, otherwise the live env.
      addressBookCap: () =>
        options.ramps?.addressBookCap !== undefined ? options.ramps.addressBookCap : process.env[BANK_ADDRESS_BOOK_CAP_ENV],
      offrampCoolingHours: () =>
        options.ramps?.offrampCoolingHours !== undefined ? options.ramps.offrampCoolingHours : process.env[BANK_OFFRAMP_COOLING_HOURS_ENV],
    }),
  };
}

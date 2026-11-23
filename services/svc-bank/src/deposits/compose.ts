import type { BankRoot } from '../bank-root.js';
import {
  BANK_DEPOSIT_ADDRESS_CAP_ENV,
  BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS_ENV,
  DepositService,
  type DepositServiceOptions,
} from './deposit-service.js';

/** Crypto deposit addresses. An area of svc-bank (`area-chain.ts`). */
export interface DepositsServices {
  readonly deposits: DepositService;
}

export interface DepositsAreaOptions {
  /**
   * Custody port for deposit addresses. Unset refuses `bank.deposit_custody_unset`.
   * This service does not derive an address.
   */
  deposits?: DepositServiceOptions;
}

export function composeDepositsArea(root: BankRoot, _made: object, options: DepositsAreaOptions): DepositsServices {
  // The owner's extra-address cap and expiry window (W-deposit-02): a value passed in wins, otherwise the live env.
  return {
    deposits: new DepositService(
      root.sql,
      {
        ...options.deposits,
        addressCap: options.deposits?.addressCap ?? (() => process.env[BANK_DEPOSIT_ADDRESS_CAP_ENV]),
        addressExpiryDays: options.deposits?.addressExpiryDays ?? (() => process.env[BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS_ENV]),
      },
      root.assetRegistry,
    ),
  };
}

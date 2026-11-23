import type { BankRoot } from '../bank-root.js';
import type { LinkedAccountService } from '../linked-accounts/linked-accounts.js';
import type { RampService, RampServiceOptions } from '../ramps/ramp-service.js';
import { CashOutService } from './cash-out.js';
import type { CashOutPartner } from './payout-sim.js';

/** Cash out to a linked bank account. An area of svc-bank (`area-chain.ts`). */
export interface CashOutServices {
  /** BK-ord-01: cash out to a linked bank account. Kept refused with its reason; nothing is held or posted. */
  readonly cashOut: CashOutService;
}

export interface CashOutServiceOptions {
  /** Who pays out cash-outs to bank accounts. Unset: every cash-out is kept refused `bank.fiat_ramp_socket`. */
  cashOutPartner?: CashOutPartner | null;
  /** The security lock (the ramps area's option): a locked person's cash-out refuses. */
  ramps?: Pick<RampServiceOptions, 'securityLock'>;
}

export function composeCashOutArea(
  root: BankRoot,
  made: { readonly ramps: RampService; readonly linkedAccounts: LinkedAccountService },
  options: CashOutServiceOptions,
): CashOutServices {
  return {
    cashOut: new CashOutService(
      root.sql,
      root.ledger,
      { available: (userId, assetId) => made.ramps.availableOf(userId, assetId), linked: made.linkedAccounts },
      {
        partner: options.cashOutPartner ?? null,
        receiptSecret: root.receiptSecret,
        securityLock: options.ramps?.securityLock,
        custody: root.custody,
      },
    ),
  };
}

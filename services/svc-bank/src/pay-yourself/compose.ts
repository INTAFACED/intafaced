import type { BankRoot } from '../bank-root.js';
import { ZERO, type Amount } from '@intafaced/ledger-client';
import { partnerFeeKnown } from '../partner/test-partner.js';
import { PayYourselfService } from './pay-yourself-service.js';
import type { RealisedSource } from './realised-source.js';
import type { PayInRail } from './test-pay-in.js';

/** Pay yourself from your trading (J-bank-31). An area of svc-bank (`area-chain.ts`). */
export interface PayYourselfServices {
  /** J-bank-31: a venue withdrawal, signed once, to the person's own partner account. `bank.pay_in_unset` with no pay-in. */
  readonly payYourself: PayYourselfService;
}

export interface PayYourselfServiceOptions {
  /** The partner's pay-in a venue can withdraw to (J-bank-31). Unset: every pay yourself write refuses `bank.pay_in_unset`. */
  payInRail?: PayInRail | null;
  /** svc-trade's read of the person's realised trading result. Unset: the realised figure reads as not read, never 0. */
  realisedSource?: RealisedSource | null;
  /** The pay yourself clock, which the weekly rule reads. Unset: the wall clock. */
  payYourselfNow?: () => Date;
}

export function composePayYourselfArea(root: BankRoot, _made: object, options: PayYourselfServiceOptions): PayYourselfServices {
  return {
    payYourself: new PayYourselfService(root.sql, {
      payIn: options.payInRail ?? null,
      realised: options.realisedSource ?? null,
      // The TEST partner charges nothing for a pay-in (TEST) when it says what a move costs; with its fee switch
      // `unknown` it says nothing, read as "not known", never 0.
      partnerFee: (userId): Amount | null => (partnerFeeKnown(root.testPartner, userId) ? ZERO : null),
      ...(options.payYourselfNow ? { now: options.payYourselfNow } : {}),
    }),
  };
}

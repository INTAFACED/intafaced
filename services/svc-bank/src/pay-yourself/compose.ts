import type { Sql } from 'postgres';
import { ZERO, type Amount } from '@intafaced/ledger-client';
import { partnerFeeKnown, type TestPartner } from '../partner/test-partner.js';
import { PayYourselfService } from './pay-yourself-service.js';
import type { RealisedSource } from './realised-source.js';
import type { PayInRail } from './test-pay-in.js';

/**
 * Pay yourself from your trading (J-bank-31), made in its own place: `bank-service.ts` spreads these and does not change
 * for this journey (project-state #2656; `bank-service.compose.test.ts`).
 */
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

export function composePayYourselfServices(
  ctx: { readonly sql: Sql; readonly testPartner: TestPartner | null },
  options: PayYourselfServiceOptions,
): PayYourselfServices {
  return {
    payYourself: new PayYourselfService(ctx.sql, {
      payIn: options.payInRail ?? null,
      realised: options.realisedSource ?? null,
      // The TEST partner charges nothing for a pay-in (TEST) when it says what a move costs; with its fee switch
      // `unknown` it says nothing, read as "not known", never 0.
      partnerFee: (userId): Amount | null => (partnerFeeKnown(ctx.testPartner, userId) ? ZERO : null),
      ...(options.payYourselfNow ? { now: options.payYourselfNow } : {}),
    }),
  };
}

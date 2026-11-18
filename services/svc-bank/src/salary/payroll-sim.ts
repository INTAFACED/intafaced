import path from 'node:path';
import { z } from 'zod';
import { isExplicitDevOrTest } from '@intafaced/config';
import { railRecorder, type RailRecorder } from '../cash-out/rail-records.js';
import type { TestPartnerDoors } from '../partner/test-partner.js';

/**
 * THE PAYROLL STAND-IN, AND IT IS A TEST FIXTURE (J-bank-30, BK-salary-03).
 *
 * A salary paid in by direct deposit is `rail.bank`: an employer's bank sends a credit over the payroll network to the
 * account details the partner bank issued, and may later reverse it. No network and no partner are wired, so
 * `BANK_PAYROLL_PARTNER=none` (the default) refuses every salary door with `rail.bank`. `payroll-sim` stands in on the
 * local test stack, like the payout stand-in (`cash-out/payout-sim.ts`): it answers nothing on its own; a credit and a
 * reversal are the network's signed calls (`/internal/jobs/payroll-sim/*`), which a journey makes as the network would.
 * The money is the TEST partner bank's (`partner/test-partner.ts`): a credit is one pay-in there, a reversal one move out
 * to it, and INTAFACED's ledger posts nothing. So the stand-in needs the TEST partner, and refuses to start without it.
 *
 * Chosen in a process whose raw `APP_ENV` is not exactly `dev` or `test`, or with `NODE_ENV=production`, the service
 * refuses to start. With `BANK_PAYROLL_SIM_RECORDS_DIR` set (the stack sets it), the stand-in keeps its own TEST record of
 * each credit it carried and each reversal (`cash-out/rail-records.ts` format, rail `payroll-sim`), so the founders' rail
 * desk compares the network's own word with what the app showed. It is a folder of its own, never the stack's ledger
 * rail records: the ledger posts nothing for this money, so it has no boundary to reconcile against.
 */
export const PAYROLL_PARTNER_SETTINGS = ['none', 'payroll-sim'] as const;
export type PayrollPartnerSetting = (typeof PAYROLL_PARTNER_SETTINGS)[number];

export const PAYROLL_SIM_RAIL = 'payroll-sim';
export const PAYROLL_SIM_LABEL = 'TEST payroll network (payroll-sim)';

/** The payroll network on the stack, the partner bank its credits land in, and its own record. */
export interface PayrollPartner {
  readonly label: string;
  readonly partner: TestPartnerDoors;
  /** The stand-in's own TEST record of credits and reversals; null when no folder was given (nothing kept). */
  readonly records: RailRecorder | null;
}

export class PayrollSimRefusedError extends Error {
  constructor(
    readonly code:
      'bank.payroll_sim_outside_dev_test' | 'bank.payroll_sim_needs_test_partner' | 'bank.payroll_sim_records_outside_dev_test',
    message: string,
  ) {
    super(message);
    this.name = 'PayrollSimRefusedError';
  }
}

/**
 * Total over the closed setting. `none` is no network. `payroll-sim` is the stand-in only in an explicit dev or test
 * process that runs the TEST partner bank, and throws at boot otherwise: `env` is the RAW process env. A records folder is
 * a LOCAL TEST path: given in any other process, or not absolute, the service refuses to start whatever the setting.
 */
export function payrollPartnerFor(
  setting: PayrollPartnerSetting,
  partner: TestPartnerDoors | null,
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
  recordsDir?: string,
): PayrollPartner | null {
  const devOrTest = isExplicitDevOrTest(env.APP_ENV) && env.NODE_ENV !== 'production';
  if (recordsDir !== undefined && (!devOrTest || !path.isAbsolute(recordsDir))) {
    throw new PayrollSimRefusedError(
      'bank.payroll_sim_records_outside_dev_test',
      "BANK_PAYROLL_SIM_RECORDS_DIR is the local-test stack's records folder; it is an absolute path and is set only with APP_ENV exactly dev or test.",
    );
  }
  if (setting !== 'payroll-sim') return null;
  if (!devOrTest) {
    throw new PayrollSimRefusedError(
      'bank.payroll_sim_outside_dev_test',
      'BANK_PAYROLL_PARTNER=payroll-sim is a local-test stand-in that pays nobody; it runs only with APP_ENV exactly dev or test.',
    );
  }
  if (!partner) {
    throw new PayrollSimRefusedError(
      'bank.payroll_sim_needs_test_partner',
      'BANK_PAYROLL_PARTNER=payroll-sim credits the TEST partner bank, so it needs BANK_TEST_PARTNER=test.',
    );
  }
  return { label: PAYROLL_SIM_LABEL, partner, records: recordsDir ? railRecorder(recordsDir, PAYROLL_SIM_RAIL) : null };
}

const decimal = z.string().regex(/^\d{1,20}(\.\d{1,18})?$/);
const networkId = z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/);

/** The network's credit, as it sends it: who pays, to which details, how much, and the account holder it names. */
export const payrollCreditBody = z
  .object({
    networkId,
    accountDetailsId: z.string().min(1).max(256),
    amount: decimal,
    currency: z.string().regex(/^[A-Z]{3}$/),
    originatorName: z.string().trim().min(1).max(140),
    holderName: z.string().trim().min(1).max(140),
  })
  .strict();
export type PayrollCredit = z.infer<typeof payrollCreditBody>;

/** The employer's reversal of one credit the network carried, named by its network id. */
export const payrollReverseBody = z.object({ networkId }).strict();

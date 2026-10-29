import path from 'node:path';
import { z } from 'zod';
import { isExplicitDevOrTest } from '@intafaced/config';
import { formatAmount, mul, parseAmount, sub } from '@intafaced/ledger-client';
import { railRecorder, type RailRecorder } from './rail-records.js';

/**
 * THE CASH-OUT PAYOUT STAND-IN, AND IT IS A TEST FIXTURE (J-bank-03 #4/#5).
 *
 * Paying out to a bank account is `rail.bank`: a banking partner verifies the account, prices the payout, pays it and
 * later says whether it arrived, failed or came back. None is wired, so every cash-out is kept refused by name
 * (`docs/adr/2026-08-04-bank-vertical-law.md`). `BANK_PAYOUT_PARTNER=none` (the default) keeps it that way. `payout-sim`
 * is a stand-in for the local test stack and the journey tests, like the global-send stand-in: it prices the assets its
 * catalogue lists (`BANK_PAYOUT_SIM_JSON`, labelled TEST in the bank's test profile) and takes a payout with a TEST
 * reference. It answers nothing on its own: verifying an account and saying paid, failed or returned are the partner's
 * signed calls (`/internal/jobs/payout-sim/*`), which the journey makes as the partner would. Value moves only through
 * the ledger's withdraw and deposit recipes against its own TEST rail boundary (`payout-sim`). Chosen in a process whose
 * raw `APP_ENV` is not exactly `dev` or `test`, or with `NODE_ENV=production`, the service refuses to start, and so it
 * does over a blank or unreadable catalogue. With `BANK_PAYOUT_SIM_RECORDS_DIR` set (the stack sets it), the stand-in
 * also keeps its own TEST record of each payout it paid and each amount that came back (`rail-records.ts`), which the
 * stack's outside source reads for rail `payout-sim`; set in any other process, the service refuses to start.
 */
export const PAYOUT_PARTNER_SETTINGS = ['none', 'payout-sim'] as const;
export type PayoutPartnerSetting = (typeof PAYOUT_PARTNER_SETTINGS)[number];

/** The ledger rail boundary the stand-in pays out to and returns from. */
export const PAYOUT_SIM_RAIL = 'payout-sim';

/** Why a partner did not pay, in its own closed list. */
export const PAYOUT_FAILURES = ['bank.payout_account_closed', 'bank.payout_name_mismatch', 'bank.payout_rejected'] as const;
export type PayoutFailure = (typeof PAYOUT_FAILURES)[number];

/** Why a paid-out amount came back. */
export const PAYOUT_RETURNS = ['bank.payout_returned_account_closed', 'bank.payout_returned_by_bank'] as const;
export type PayoutReturn = (typeof PAYOUT_RETURNS)[number];

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

const catalogueShape = z
  .object({
    label: z.string().regex(/^TEST\b/),
    payouts: z
      .array(
        z
          .object({
            asset: z.string().regex(/^[A-Z0-9]{2,16}$/),
            currency: z.string().regex(/^[A-Z]{3,16}$/),
            rate: decimal,
            fee: decimal,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type PayoutSimCatalogue = z.infer<typeof catalogueShape>;

/** The partner's price for one payout: its fee and what arrives, both in the currency it pays. */
export interface PayoutPrice {
  readonly fee: string;
  readonly receiveAmount: string;
  readonly receiveCurrency: string;
}

/** Who pays out to bank accounts. The stand-in is the only one in this build. */
export interface CashOutPartner {
  /** The TEST label when this is the stand-in. */
  readonly label: string;
  /** The ledger rail boundary paid-out value moves to. */
  readonly rail: string;
  /** The price of paying `amount` of `assetId`, or null when the partner does not pay out that asset. */
  price(assetId: string, amount: bigint): PayoutPrice | null;
  /** Take one payout. The cash-out id is the partner's idempotency key: the same id is the same payout. */
  pay(order: { cashOutId: string; assetId: string; amount: string }): Promise<{ payoutRef: string }>;
  /** LOCAL TEST: the stand-in's own record of its rail, written before the ledger posts a movement. Absent: none kept. */
  readonly records?: RailRecorder;
}

/** The typed catalogue, or null when it is blank, not JSON, not labelled TEST or not in shape. */
export function parsePayoutSim(json: string | undefined): PayoutSimCatalogue | null {
  if (!json?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = catalogueShape.safeParse(raw);
  if (!parsed.success) return null;
  const assets = parsed.data.payouts.map((p) => p.asset);
  if (new Set(assets).size !== assets.length) return null;
  try {
    // Both must fit the ledger's numeric(38,18), so a catalogue that cannot price refuses at boot, not at the first quote.
    for (const p of parsed.data.payouts) if (parseAmount(p.rate) <= 0n || parseAmount(p.fee) < 0n) return null;
  } catch {
    return null;
  }
  return parsed.data;
}

/** The stand-in over one typed catalogue, keeping its TEST records in `recordsDir` when one is given. */
export function payoutSim(catalogue: PayoutSimCatalogue, recordsDir?: string): CashOutPartner {
  return {
    ...(recordsDir ? { records: railRecorder(recordsDir, PAYOUT_SIM_RAIL) } : {}),
    label: catalogue.label,
    rail: PAYOUT_SIM_RAIL,
    price(assetId, amount) {
      const line = catalogue.payouts.find((p) => p.asset === assetId);
      if (!line) return null;
      // What arrives is the amount at the TEST rate, rounded down, less the TEST fee. A payout the fee eats is not priced.
      const receive = sub(mul(amount, parseAmount(line.rate), 'floor'), parseAmount(line.fee));
      if (receive <= 0n) return null;
      try {
        parseAmount(formatAmount(receive));
      } catch {
        return null; // too large for the ledger's numeric(38,18): not a payout anyone can record
      }
      return { fee: line.fee, receiveAmount: formatAmount(receive), receiveCurrency: line.currency };
    },
    async pay(order) {
      return { payoutRef: `TEST-PAYOUT-${order.cashOutId}` };
    },
  };
}

/** Why the service will not start with the stand-in chosen. */
export class PayoutSimRefusedError extends Error {
  constructor(
    readonly code: 'bank.payout_sim_outside_dev_test' | 'bank.payout_sim_catalogue_unreadable' | 'bank.payout_sim_records_outside_dev_test',
    message: string,
  ) {
    super(message);
    this.name = 'PayoutSimRefusedError';
  }
}

/**
 * Total over the closed setting. `none` is no partner. `payout-sim` is the stand-in only in an explicit dev or test
 * process with a readable TEST catalogue, and throws at boot otherwise: `env` is the RAW process env. A records folder
 * is a LOCAL TEST path: given in any other process, or not absolute, the service refuses to start whatever the setting.
 */
export function cashOutPartnerFor(
  setting: PayoutPartnerSetting,
  catalogueJson: string | undefined,
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
  recordsDir?: string,
): CashOutPartner | null {
  const devOrTest = isExplicitDevOrTest(env.APP_ENV) && env.NODE_ENV !== 'production';
  if (recordsDir !== undefined && (!devOrTest || !path.isAbsolute(recordsDir))) {
    throw new PayoutSimRefusedError(
      'bank.payout_sim_records_outside_dev_test',
      "BANK_PAYOUT_SIM_RECORDS_DIR is the local-test stack's records folder; it is an absolute path and is set only with APP_ENV exactly dev or test.",
    );
  }
  if (setting !== 'payout-sim') return null;
  if (!devOrTest) {
    throw new PayoutSimRefusedError(
      'bank.payout_sim_outside_dev_test',
      'BANK_PAYOUT_PARTNER=payout-sim is a local-test stand-in that pays nobody; it runs only with APP_ENV exactly dev or test.',
    );
  }
  const catalogue = parsePayoutSim(catalogueJson);
  if (!catalogue) {
    throw new PayoutSimRefusedError(
      'bank.payout_sim_catalogue_unreadable',
      'BANK_PAYOUT_PARTNER=payout-sim needs BANK_PAYOUT_SIM_JSON: a catalogue labelled TEST, in shape (see cash-out/payout-sim.ts).',
    );
  }
  return payoutSim(catalogue, recordsDir);
}

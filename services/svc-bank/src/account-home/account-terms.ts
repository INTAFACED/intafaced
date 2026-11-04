/**
 * The base-tier account terms (BK-acct-01): what an account costs and what comes with it, as the owner published them.
 *
 * Read only, no ledger write. The terms are the owner's (`BANK_ACCOUNT_TERMS_JSON`) and have no default: a blank,
 * unreadable or out-of-shape value refuses `bank.account_terms_unset`, so the account panel says the terms are not
 * published and never claims a fee-free account. Money is decimal strings, exactly as published.
 */
import { z } from 'zod';
import { BankError } from '../errors.js';

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'a fee or minimum is an unsigned decimal string (max 18dp)');

const termsSchema = z
  .object({
    /** The tier's name, shown as published. */
    tier: z.string().trim().min(1).max(64),
    /** Which publication this is, so a support conversation can name it. */
    version: z.string().trim().min(1).max(64),
    /** The asset every figure below is in. */
    currency: z.string().regex(/^[A-Z0-9]{2,16}$/),
    monthlyFee: decimal,
    minimumBalance: decimal,
    /** Null when the tier has no overdraft at all, which is different from an overdraft that costs nothing. */
    overdraftFee: decimal.nullable(),
    /** What the tier includes, in the owner's words. */
    included: z.array(z.string().trim().min(1).max(140)).min(1).max(20),
  })
  .strict();

export type AccountTerms = z.infer<typeof termsSchema>;

/**
 * Why a plan's overdraft cannot be used in this build (J-bank-02 #8). A published overdraft fee says the plan allows a
 * negative balance, but no overdraft engine exists: the ledger refuses any user balance below zero, and lending without
 * collateral needs its own engine and licence (spec BK-loan-08, preview only). So a payment above the balance is refused
 * `bank.insufficient_funds` on every plan, and a plan that publishes an overdraft names this blocker instead of claiming
 * a negative balance the bank cannot book.
 */
export const OVERDRAFT_SWITCHED_OFF = 'bank.overdraft_switched_off' as const;

export const accountTermsOutput = termsSchema.extend({
  /** Null when the plan has no overdraft (nothing is switched off); the blocker when it publishes one. */
  overdraftBlocker: z.literal(OVERDRAFT_SWITCHED_OFF).nullable(),
});

export type AccountFeatures = z.infer<typeof accountTermsOutput>;

/** The published terms as the customer reads them: exactly as published, plus whether their overdraft can be used. */
export function accountFeatures(terms: AccountTerms): AccountFeatures {
  return { ...terms, overdraftBlocker: terms.overdraftFee === null ? null : OVERDRAFT_SWITCHED_OFF };
}

const unset = () =>
  new BankError('The owner has not published the account terms, so no fee or feature is claimed', 'bank.account_terms_unset');

/** The owner's terms, parsed. Blank, not JSON or not in shape refuses; there are no built-in terms. */
export function parseAccountTerms(raw: string | undefined): AccountTerms {
  const text = raw?.trim() ?? '';
  if (text === '') throw unset();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unset();
  }
  const terms = termsSchema.safeParse(parsed);
  if (!terms.success) throw unset();
  return terms.data;
}

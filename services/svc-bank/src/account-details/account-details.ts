/**
 * Local account details and the eligibility statement (BK-acct-03).
 *
 * Reads only, and no ledger write. A set of account details (account number, sort code, routing, BSB, IBAN) is issued by a
 * banking partner, never by us, so nothing here makes one up: with no partner wired every currency answers `unavailable` with the
 * blocker `rail.bank`, and `get` and `request` refuse `rail.bank`. The currencies a customer may ask for are the owner's list
 * (`BANK_ACCOUNT_DETAILS_CURRENCIES`); a blank list refuses `bank.account_details_currencies_unset` and no list is invented.
 *
 * The eligibility statement is the owner's published rule set (`BANK_ELIGIBILITY_JSON`) next to the platform's own verdict for a
 * region (`JURISDICTION_MATRIX`). A blank or unreadable rule set refuses `bank.eligibility_unset`.
 */
import { ruleFor } from '@intafaced/config';
import { z } from 'zod';
import { BankError } from '../errors.js';

export const ACCOUNT_DETAIL_REQUEST_STATES = ['pending_user', 'requirements_fulfilled', 'done'] as const;
export type AccountDetailRequestState = (typeof ACCOUNT_DETAIL_REQUEST_STATES)[number];

/** One set of details as the partner issued it. A field the scheme has no use for is null, never an empty string. */
export interface AccountDetailSet {
  readonly id: string;
  readonly accountNumber: string | null;
  readonly sortCode: string | null;
  readonly routingNumber: string | null;
  readonly bsb: string | null;
  readonly iban: string | null;
  readonly bic: string | null;
  /** The issuing bank's name, shown beside the numbers. */
  readonly partnerBank: string;
  /** What this set cannot receive, in the partner's words. */
  readonly restrictions: string[];
}

export interface AccountDetailsForCurrency {
  readonly state: AccountDetailRequestState;
  readonly sets: AccountDetailSet[];
}

/**
 * The banking partner. There is none today (`rail.bank`). `request` takes a business key so a retry after a timeout is the same
 * request, not a second one.
 */
export interface AccountDetailsPartner {
  detailsFor(userId: string, currency: string): Promise<AccountDetailsForCurrency>;
  request(userId: string, currency: string, key: string): Promise<AccountDetailsForCurrency>;
}

export interface AccountDetailsOptions {
  /** Owner-published, comma separated ISO-4217 codes. Blank or unset refuses. */
  readonly currencies?: string | undefined;
  readonly partner?: AccountDetailsPartner | undefined;
  /** Owner-published eligibility rule set as JSON (`BANK_ELIGIBILITY_JSON`). Blank or unreadable refuses. */
  readonly eligibilityJson?: string | undefined;
}

export interface CurrencyDetails {
  readonly currency: string;
  readonly state: 'unavailable' | AccountDetailRequestState;
  /** Why there is nothing to show: `rail.bank` while no partner is wired. Null once a partner answers. */
  readonly blocker: 'rail.bank' | null;
  readonly sets: AccountDetailSet[];
}

const CURRENCY = /^[A-Z]{3}$/;

export function requestKey(userId: string, currency: string): string {
  return `accountDetails:request:${userId}:${currency}`;
}

export class AccountDetailsService {
  constructor(private readonly options: AccountDetailsOptions = {}) {}

  /** The owner's currencies, in the order given, without repeats. A blank, unreadable or empty list refuses. */
  currencies(): string[] {
    const raw = this.options.currencies?.trim() ?? '';
    const codes = raw === '' ? [] : [...new Set(raw.split(',').map((c) => c.trim().toUpperCase()))];
    if (codes.length === 0 || codes.some((c) => !CURRENCY.test(c))) {
      throw new BankError(
        'The owner has not published which currencies have account details, so none is shown',
        'bank.account_details_currencies_unset',
      );
    }
    return codes;
  }

  private known(currency: string): string {
    const code = currency.trim().toUpperCase();
    if (!this.currencies().includes(code)) {
      throw new BankError(`${code} is not a currency with account details`, 'bank.account_details_currency_unknown');
    }
    return code;
  }

  private partner(): AccountDetailsPartner {
    const { partner } = this.options;
    if (!partner) throw new BankError('Account details need a banking partner. It is switched off in this build', 'rail.bank');
    return partner;
  }

  private async fromPartner<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof BankError) throw err;
      throw new BankError('The banking partner did not answer. Nothing was changed, try again', 'bank.account_details_unavailable');
    }
  }

  /** The owner's rule set and, for a region, the platform's verdict for the bank module there. */
  eligibility(region?: string): Eligibility {
    return eligibilityFor(this.options.eligibilityJson, region);
  }

  async list(userId: string): Promise<{ readonly currencies: CurrencyDetails[] }> {
    const codes = this.currencies();
    const { partner } = this.options;
    if (!partner) {
      return { currencies: codes.map((currency) => ({ currency, state: 'unavailable', blocker: 'rail.bank', sets: [] })) };
    }
    const rows = await Promise.all(
      codes.map(async (currency): Promise<CurrencyDetails> => {
        const got = await this.fromPartner(() => partner.detailsFor(userId, currency));
        return { currency, state: got.state, blocker: null, sets: got.sets };
      }),
    );
    return { currencies: rows };
  }

  async get(userId: string, currency: string): Promise<CurrencyDetails> {
    const code = this.known(currency);
    const partner = this.partner();
    const got = await this.fromPartner(() => partner.detailsFor(userId, code));
    return { currency: code, state: got.state, blocker: null, sets: got.sets };
  }

  /** Ask the partner for details in this currency. The same customer and currency twice is one request. */
  async request(userId: string, currency: string): Promise<CurrencyDetails> {
    const code = this.known(currency);
    const partner = this.partner();
    const got = await this.fromPartner(() => partner.request(userId, code, requestKey(userId, code)));
    return { currency: code, state: got.state, blocker: null, sets: got.sets };
  }
}

const ruleSetSchema = z
  .object({
    /** ISO-3166 alpha-2 codes where an account can be opened. */
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    entityTypes: z.array(z.string().min(1).max(64)).min(1),
    productRestrictions: z.array(z.object({ product: z.string().min(1).max(64), restriction: z.string().min(1).max(280) }).strict()),
  })
  .strict();

export type EligibilityRules = z.infer<typeof ruleSetSchema>;

export interface RegionVerdict {
  readonly region: string;
  /** The platform's own rule for the bank module in this region (`JURISDICTION_MATRIX`). It does not consult a sanctions list. */
  readonly status: 'open' | 'restricted' | 'blocked';
  readonly minTier: string;
  readonly notes: string | null;
  readonly source: 'JURISDICTION_MATRIX';
  /** Whether the owner's published country list names this region. */
  readonly listed: boolean;
}

export interface Eligibility {
  readonly rules: EligibilityRules;
  readonly verdict: RegionVerdict | null;
}

/** The owner's rule set, parsed. Blank, not JSON or not in shape refuses; there is no built-in list. */
export function parseEligibilityRules(raw: string | undefined): EligibilityRules {
  const text = raw?.trim() ?? '';
  const unset = () =>
    new BankError('The owner has not published who can open an account, so no statement is shown', 'bank.eligibility_unset');
  if (text === '') throw unset();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unset();
  }
  const rules = ruleSetSchema.safeParse(parsed);
  if (!rules.success) throw unset();
  return rules.data;
}

export function eligibilityFor(rawRules: string | undefined, region: string | undefined): Eligibility {
  const rules = parseEligibilityRules(rawRules);
  if (region === undefined) return { rules, verdict: null };
  const code = region.trim().toUpperCase();
  const rule = ruleFor('bank', code);
  return {
    rules,
    verdict: {
      region: code,
      status: rule.status,
      minTier: rule.minTier,
      notes: rule.notes ?? null,
      source: 'JURISDICTION_MATRIX',
      listed: rules.countries.includes(code),
    },
  };
}

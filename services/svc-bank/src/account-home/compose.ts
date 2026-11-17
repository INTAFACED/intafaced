import type { BankRoot } from '../bank-root.js';
import type { PartnerCardHolds } from '../cards/partner-card-holds.js';
import type { PartnerPurchaseCustody } from '../partner/partner-purchases.js';
import type { SpaceService } from '../spaces/space-service.js';
import { parseAccountTerms, type AccountTerms } from './account-terms.js';
import { CurrencyService } from './currencies.js';
import { ProfileService } from './profile.js';

/** The account home: its terms, its currencies and which profile a call is for. An area of svc-bank (`area-chain.ts`). */
export interface AccountHomeServices {
  /** The owner's base-tier account terms (BK-acct-01). Blank refuses `bank.account_terms_unset`. */
  readonly accountTerms: () => AccountTerms;
  /** The currencies on an account: labels over ledger accounts (BK-acct-01). */
  readonly currencies: CurrencyService;
  /** Which profile a bank call is for, proved against the caller's own business memberships (J-bank-01 #7). */
  readonly profiles: ProfileService;
}

export interface AccountHomeServiceOptions {
  /** Owner-published base-tier account terms as JSON (`BANK_ACCOUNT_TERMS_JSON`). No default: blank refuses. */
  accountTerms?: string | undefined;
  /** Owner-published currencies an account may hold (`BANK_ACCOUNT_CURRENCIES`). No default: blank refuses an add. */
  accountCurrencies?: string | undefined;
}

export function composeAccountHomeArea(
  root: BankRoot,
  made: {
    readonly spaces: SpaceService;
    readonly partnerCardHolds: PartnerCardHolds | null;
    readonly partnerPurchases: PartnerPurchaseCustody;
  },
  options: AccountHomeServiceOptions,
): AccountHomeServices {
  return {
    accountTerms: () => parseAccountTerms(options.accountTerms),
    // Removing a currency reads what the partner still holds in it: its card holds, its purchase holds and its open orders.
    currencies: new CurrencyService(root.sql, root.ledger, made.spaces, {
      currencies: options.accountCurrencies,
      cardHolds: made.partnerCardHolds,
      purchases: made.partnerPurchases,
    }),
    profiles: new ProfileService(root.sql),
  };
}

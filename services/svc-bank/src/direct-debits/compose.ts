import type { BankRoot } from '../bank-root.js';
import { testPartnerDirectDebits } from '../partner/test-partner.js';
import type { SpaceService } from '../spaces/space-service.js';
import { DirectDebitService } from './direct-debits.js';
import { unsetDirectDebitScheme, type DirectDebitScheme } from './scheme.js';

/** Direct Debit mandates and collections. An area of svc-bank (`area-chain.ts`). */
export interface DirectDebitsServices {
  /** BK-xfer-11: Direct Debit mandates and collections. Every control refuses `rail.bank` while no scheme is wired. */
  readonly directDebits: DirectDebitService;
}

export interface DirectDebitsServiceOptions {
  /** Who speaks for the direct debit scheme. Unset unless the TEST stand-in was chosen (`BANK_DD_SCHEME=dd-sim`). */
  directDebitScheme?: DirectDebitScheme;
}

export function composeDirectDebitsArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService },
  options: DirectDebitsServiceOptions,
): DirectDebitsServices {
  return {
    directDebits: new DirectDebitService(
      root.sql,
      root.ledger,
      made.spaces,
      options.directDebitScheme ?? unsetDirectDebitScheme,
      testPartnerDirectDebits(root.testPartner),
    ),
  };
}

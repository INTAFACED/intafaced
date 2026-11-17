import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { SharedPotService } from '../spaces/shared-pots.js';
import { BankApiService, type BankApiOptions } from './bank-api.js';

/** The developer API's services. An area of svc-bank (`area-chain.ts`). */
export interface DeveloperApiServices {
  /** J-bank-24: the bank API: accounts with filters, moves on the partner's quote, payments out and their webhooks. */
  readonly bankApi: BankApiService;
}

export interface DeveloperApiServiceOptions {
  /** J-bank-24: the bank API's webhook delivery (dev/test loopback hatch, transport, resolver). The TEST partner is passed in here. */
  bankApi?: Omit<BankApiOptions, 'testPartner'>;
}

export function composeDeveloperApiArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService; readonly sharedPots: SharedPotService },
  options: DeveloperApiServiceOptions,
): DeveloperApiServices {
  return {
    bankApi: new BankApiService(root.sql, made.spaces, made.sharedPots, root.custody, {
      ...options.bankApi,
      testPartner: root.testPartner,
    }),
  };
}

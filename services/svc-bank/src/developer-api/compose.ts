import type { Sql } from 'postgres';
import type { PartnerCustody } from '../partner/partner-bank.js';
import type { TestPartner } from '../partner/test-partner.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { SharedPotService } from '../spaces/shared-pots.js';
import { BankApiService, type BankApiOptions } from './bank-api.js';

/**
 * The developer API's services, made in one place of their own, as `business/compose.ts` makes the business bank's: a
 * new developer API service is a field here, an option here, and a line in `composeDeveloperApiServices`;
 * `bank-service.ts` spreads all three and does not change for it (project-state #2656).
 */
export interface DeveloperApiServices {
  /** J-bank-24: the bank API: accounts with filters, moves on the partner's quote, payments out and their webhooks. */
  readonly bankApi: BankApiService;
}

export interface DeveloperApiServiceOptions {
  /** J-bank-24: the bank API's webhook delivery (dev/test loopback hatch, transport, resolver). The TEST partner is passed in here. */
  bankApi?: Omit<BankApiOptions, 'testPartner'>;
}

export interface DeveloperApiComposeContext {
  readonly sql: Sql;
  readonly spaces: SpaceService;
  readonly sharedPots: SharedPotService;
  readonly custody: PartnerCustody;
  readonly testPartner: TestPartner | null;
}

export function composeDeveloperApiServices(ctx: DeveloperApiComposeContext, options: DeveloperApiServiceOptions): DeveloperApiServices {
  return {
    bankApi: new BankApiService(ctx.sql, ctx.spaces, ctx.sharedPots, ctx.custody, { ...options.bankApi, testPartner: ctx.testPartner }),
  };
}

import type { Sql } from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { PartnerCustody, PostingFreeze } from '../partner/partner-bank.js';
import type { PartnerRefusalCounts } from '../partner/partner-refusals.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { TransferService } from '../transfers/transfer-service.js';
import { BusinessService } from './business-service.js';
import { BusinessTeamService } from './business-team.js';
import { BusinessBillsService } from './business-bills.js';
import { BusinessPayoutsService } from './business-payouts.js';
import { BusinessCardsService } from './business-cards.js';
import type { BusinessDirectoryPort, BusinessLookupLimiter } from './business-directory.js';

/**
 * The business bank's services, made in one place of their own. A new business service (a journey of the business
 * bank) is a field here, an option here if it needs an owner value, and a line in `composeBusinessServices`:
 * `bank-service.ts` spreads all three and does not change for it (project-state #2656).
 */
export interface BusinessServices {
  readonly business: BusinessService;
  /** J-bank-19: the business's own roles, advisors, invites, approval rules, partner-held payments and team spend. */
  readonly businessTeam: BusinessTeamService;
  /** J-bank-20: the business's supplier bills: inbox, duplicates, vendors, Bill Pay limits, approvals and partner-held payments. */
  readonly businessBills: BusinessBillsService;
  /** J-bank-21: the business's bulk payment runs, contractors and invoices, and crypto payroll signed by its own wallet. */
  readonly businessPayouts: BusinessPayoutsService;
  /** J-bank-22: the business's team cards with per-purchase limits, receipts, and reimbursements paid at the partner. */
  readonly businessCards: BusinessCardsService;
}

export interface BusinessServiceOptions {
  /** Owner-set minutes a business team invite lasts (`BANK_BUSINESS_INVITE_MINUTES`). No default: blank refuses every invite. */
  businessInviteMinutes?: string | undefined;
  /** The bill reader (`BANK_BILL_READER`): `test-lines` on the TEST stack only. Blank: every bill field is typed by hand. */
  billReader?: string | undefined;
}

/** What the business bank shares with the rest of svc-bank, made once in `createBankServices`. */
export interface BusinessComposeContext {
  readonly sql: Sql;
  readonly ledger: LedgerClient;
  readonly spaces: SpaceService;
  readonly transfers: TransferService;
  readonly custody: PartnerCustody;
  readonly postingFreeze: PostingFreeze;
  readonly noteRefusal: PartnerRefusalCounts['note'];
  readonly directory: BusinessDirectoryPort;
  readonly directoryLookups: BusinessLookupLimiter;
  /** The TEST partner bank is chosen (a dev or test stack only). */
  readonly testPartner: boolean;
}

export function composeBusinessServices(ctx: BusinessComposeContext, options: BusinessServiceOptions): BusinessServices {
  const { sql, postingFreeze, noteRefusal } = ctx;
  const businessTeam = new BusinessTeamService(sql, ctx.custody, ctx.directory, {
    inviteMinutes: () => options.businessInviteMinutes,
    postingFreeze,
    noteRefusal,
  });
  return {
    business: new BusinessService(sql, ctx.ledger, ctx.spaces, ctx.transfers, ctx.directory, ctx.directoryLookups),
    businessTeam,
    businessBills: new BusinessBillsService(sql, businessTeam, {
      reader: () => options.billReader,
      postingFreeze,
      noteRefusal,
    }),
    businessPayouts: new BusinessPayoutsService(sql, businessTeam, { postingFreeze, noteRefusal }),
    businessCards: new BusinessCardsService(sql, businessTeam, {
      postingFreeze,
      noteRefusal,
      custody: ctx.custody,
      testNetwork: ctx.testPartner,
    }),
  };
}

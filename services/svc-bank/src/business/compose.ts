import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { TransferService } from '../transfers/transfer-service.js';
import { BusinessService } from './business-service.js';
import { BusinessTeamService } from './business-team.js';
import { BusinessBillsService } from './business-bills.js';
import { BusinessPayoutsService } from './business-payouts.js';
import { BusinessCardsService } from './business-cards.js';
import { BusinessBooksService } from './business-books.js';

/**
 * The business bank's services. An area of svc-bank (`area-chain.ts`): a new business service (a journey of the business
 * bank) is a field here, an option here if it needs an owner value, and a line in `composeBusinessArea`.
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
  /** J-bank-23: the business's books: the accounting connection record, coding rules and four-format statements. */
  readonly businessBooks: BusinessBooksService;
}

export interface BusinessServiceOptions {
  /** Owner-set minutes a business team invite lasts (`BANK_BUSINESS_INVITE_MINUTES`). No default: blank refuses every invite. */
  businessInviteMinutes?: string | undefined;
  /** The bill reader (`BANK_BILL_READER`): `test-lines` on the TEST stack only. Blank: every bill field is typed by hand. */
  billReader?: string | undefined;
}

export function composeBusinessArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService; readonly transfers: TransferService },
  options: BusinessServiceOptions,
): BusinessServices {
  const { sql, postingFreeze } = root;
  const noteRefusal = root.partnerRefusals.note;
  const businessTeam = new BusinessTeamService(sql, root.custody, root.directory, {
    inviteMinutes: () => options.businessInviteMinutes,
    postingFreeze,
    noteRefusal,
  });
  return {
    business: new BusinessService(sql, root.ledger, made.spaces, made.transfers, root.directory, root.directoryLookups),
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
      custody: root.custody,
      // The TEST partner bank is chosen (a dev or test stack only).
      testNetwork: root.testPartner != null,
    }),
    businessBooks: new BusinessBooksService(sql, businessTeam),
  };
}

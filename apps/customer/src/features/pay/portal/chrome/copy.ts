import { defineCopy } from '../../../../shared/i18n';

/** Words in the portal frame: the top bar, the business switcher, the search menu and the card for parts that are not live. */
const en = {
  // Why a part of the portal is not live yet. A card names its blocker; it never just says "not yet".
  reasonFees: 'Pricing is not set for this account: INTAFACED sets merchant fees',
  reasonDocuments: 'Document checks are not connected here',
  reasonVerified: 'Available after your business is verified',
  reasonHistory: 'History is not connected here: INTAFACED doesn’t record past changes. Nothing for you to set up.',
  reasonDetail: 'Detail is not connected here: INTAFACED has no extra information to show. Nothing for you to set up.',
  reasonLists: 'Not connected here: INTAFACED has not built this view. Nothing for you to set up.',
  reasonActions: 'Not connected here: INTAFACED has not built this action. Nothing for you to set up.',
  reasonDeveloper: 'Developer tools are not connected here: INTAFACED has not built this part. Nothing for you to set up.',
  reasonProfile: 'Profile changes are not connected here: editing business details is not open. Nothing for you to set up.',
  reasonNetwork: 'For platform accounts: the network pages are not connected here',
  reasonSecurity: 'Security settings are not connected here: INTAFACED has no team-wide sign-in rules. Nothing for you to set up.',
  reasonDocs: 'Developer guides are not published',
  reasonService: 'Not connected here: INTAFACED has not switched this on. Nothing for you to set up.',
  // A business account is needed first.
  noBusinessTitle: 'No business account yet',
  noBusinessBody: 'Set up your business to take payments, send payment links and move money. It takes a few minutes.',
  noBusinessStart: 'Start setup',
  noBusinessActionOff: 'Needs a business account. Start setup first.',
  // A header action the signed-in person's role does not allow, or that waits on their account details.
  headerActionNoRole: 'Your role doesn’t allow this. Ask the account owner.',
  headerActionWaiting: 'Available once your account details load.',
  // Refunds and payouts ask "Confirm it's you" when they are opened. Where the person cannot do them, the control is off and says who can.
  moneyStepRefund: 'Only the account owner can refund payments.',
  moneyStepPayout: 'Only the account owner can send payouts.',
  moneyStepRequest: 'Only the account owner, admins and finance can ask for a payout or take a request back.',
  moneyStepConvert: 'Only the account owner, admins and finance can convert a settlement.',
  moneyStepInactive: 'Refunds and payouts open once your business account is active.',
  moneyStepKeys: 'API keys and sub-accounts cannot confirm a payment.',
  switchAccount: 'Switch account',
  yourBusiness: 'Your business',
  yourAccounts: 'Your accounts',
  chooseWhere: 'Choose where you want to work.',
  businessHome: 'Payments, payouts and settings',
  personalAccount: 'Personal account',
  personalHome: 'Balances, transfers and trading',
  verified: 'Verified',
  inReview: 'In review',
  needsAttention: 'Needs attention',
  notVerified: 'Not verified',
  businessNavigation: 'Business navigation',
  openMenu: 'Open business menu',
  closeMenu: 'Close menu',
  backToPersonal: 'Back to personal',
  goToHome: 'Go to Home',
  notifications: 'Notifications',
  helpSupport: 'Help and support',
  searchPlaceholder: 'Search pages or paste a payment ID',
  searchLabel: 'Search the business pages',
  searchHint: 'Press Ctrl K or ⌘K to search',
  searchPages: 'Pages',
  searchNothing: 'Nothing matches that. Try a page name, or paste a payment ID.',
  goToPayment: 'Go to payment {id}',
  notFoundTitle: 'Page not found',
  notFoundBody: 'That page doesn’t exist in your business account. It may have moved.',
  notFoundAction: 'Go to Overview',
} as const;
export const chromeCopy = defineCopy('pay.portal.chrome', en);
/** The wording as written, for the copy lint. */
export const chromeMessages: Record<string, string> = en;

export type ReasonKey = Extract<keyof typeof en, `reason${string}`>;
/** The words for why a part is not live, in the reader's language. Pass the result to `NotLiveCard`'s `reason`. */
export const reason = (key: ReasonKey): string => chromeCopy.t(key);

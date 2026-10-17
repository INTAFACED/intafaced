import { defineCopy } from '../../../../shared/i18n';

/** Words in the portal frame: the top bar, the business switcher, the search menu and the card for parts that are not live. */
const en = {
  // Why a part of the portal is not live yet. A card names its blocker; it never just says "not yet".
  reasonFees: 'Pricing not set yet: INTAFACED is finalising merchant fees',
  reasonLimits: 'Limits not set yet: INTAFACED is finalising account tiers',
  reasonDocuments: 'Document checks not connected yet',
  reasonVerified: 'Available after your business is verified',
  reasonHistory: 'History not connected yet: past changes aren’t recorded for your account yet',
  reasonDetail: 'Detail not connected yet: this extra information isn’t available for your account yet',
  reasonLists: 'Not connected yet: this view isn’t available for your account yet',
  reasonActions: 'Not connected yet: this action isn’t switched on for your account yet',
  reasonDeveloper: 'Developer tools not connected yet: this part isn’t switched on for your account yet',
  reasonProfile: 'Profile changes not connected yet: your business details can’t be edited here yet',
  reasonNetwork: 'For platform accounts: the network pages aren’t connected yet',
  reasonSecurity: 'Security settings not connected yet: sign-in protection can’t be changed here yet',
  reasonDocs: 'Developer guides not published yet',
  reasonService: 'Not connected yet: INTAFACED hasn’t switched this on for your account',
  // A business account is needed first.
  noBusinessTitle: 'No business account yet',
  noBusinessBody: 'Set up your business to take payments, send payment links and move money. It takes a few minutes.',
  noBusinessStart: 'Start setup',
  noBusinessActionOff: 'Needs a business account. Start setup first.',
  // A header action the signed-in person's role does not allow, or that waits on their account details.
  headerActionNoRole: 'Your role doesn’t allow this. Ask the account owner.',
  headerActionWaiting: 'Available once your account details load.',
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

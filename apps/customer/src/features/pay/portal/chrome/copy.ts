import { defineCopy } from '../../../../shared/i18n';

/** Words in the portal frame: the top bar, the business switcher, the search menu and the card for parts that are not live. */
const en = {
  // Why a part of the portal is not live yet. A card names its blocker; it never just says "not yet".
  reasonFees: 'Pricing not set yet: INTAFACED is finalising merchant fees',
  reasonDocuments: 'Document checks not connected yet',
  reasonVerified: 'Available after your business is verified',
  reasonHistory: 'History not connected yet: INTAFACED doesn’t record past changes yet. Nothing for you to set up.',
  reasonDetail: 'Detail not connected yet: INTAFACED hasn’t built this extra information yet. Nothing for you to set up.',
  reasonLists: 'Not connected yet: INTAFACED hasn’t built this view yet. Nothing for you to set up.',
  reasonActions: 'Not connected yet: INTAFACED hasn’t built this action yet. Nothing for you to set up.',
  reasonDeveloper: 'Developer tools not connected yet: INTAFACED hasn’t built this part yet. Nothing for you to set up.',
  reasonProfile: 'Profile changes not connected yet: INTAFACED hasn’t opened editing of business details yet. Nothing for you to set up.',
  reasonNetwork: 'For platform accounts: the network pages aren’t connected yet',
  reasonSecurity: 'Security settings not connected yet: INTAFACED hasn’t built team-wide sign-in rules yet. Nothing for you to set up.',
  reasonDocs: 'Developer guides not published yet',
  reasonService: 'Not connected yet: INTAFACED hasn’t switched this on yet. Nothing for you to set up.',
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

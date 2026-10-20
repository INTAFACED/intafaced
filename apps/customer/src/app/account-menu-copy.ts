import { defineCopy } from '../shared/i18n';

// The account menu in the top bar (HM-navigation-01). Plain words; a value that could not be read says so.
const en = {
  summaryLabel: 'Your profile',
  summaryUnread: 'Not shown',
  summaryAccountId: 'Account ID {id}',
  summaryVerification: 'Verification: {level}',
  levelNone: 'Not verified',
  levelBasic: 'Basic',
  levelFull: 'Full',
  levelInstitutional: 'Institutional',
  profilesTitle: 'Profile',
  personal: 'Personal',
  business: 'Business',
  businessNamed: '{name} · Business',
  subAccounts: 'Sub-accounts',
  openBusiness: 'Open a business account',
  businessUnread: 'Business accounts could not be read. Only Personal is shown.',
  businessRetry: 'Try again',
  businessGone: 'That business is not one of your accounts, so Personal is shown.',
  chip: 'Business: {name}',
  chipLabel: 'Profile in view',
  theme: 'Theme',
  themeDark: 'Dark',
  themeLight: 'Light',
  developer: 'API keys and apps',
  account: 'Account',
  security: 'Security',
  verification: 'Verification',
  signOut: 'Sign out',
  menu: 'Account menu',
} as const;

export const accountMenuCopy = defineCopy('customer.accountMenu', en);
